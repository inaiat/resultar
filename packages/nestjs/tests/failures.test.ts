/* eslint-disable unicorn/no-null, unicorn/no-await-expression-member */
import { PassThrough } from "node:stream";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { getEventListeners } from "node:events";
import {
  Catch,
  Controller,
  Get,
  Res,
  type ArgumentsHost,
  type ExceptionFilter,
  type LoggerService,
} from "@nestjs/common";
import { expect, test, vi } from "vite-plus/test";
import { ResultTask, tryResultAsync } from "resultar";
import { createModule, resource, service } from "resultar-di";
import { createNestApp, Services, type NestRequest } from "../src/index.js";

function serverUrl(server: { address: () => string | AddressInfo | null }): string {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address");
  return `http://127.0.0.1:${address.port}`;
}

test.each(["sync", "async"] as const)(
  "%s locals failures retain identity and remove request listeners before the exception filter",
  async (mode) => {
    const failure = new Error("Authentication unavailable");
    let acquired = 0;
    let handled = 0;
    let abortListeners = 0;
    const Local = service("local", {}, () => {
      acquired += 1;
      return 1;
    });

    @Catch()
    class LocalsFailureFilter implements ExceptionFilter {
      catch(error: unknown, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const request = ctx.getRequest<NestRequest>();
        const response = ctx.getResponse<{
          status: (code: number) => { send: (body: unknown) => void };
        }>();
        expect(error).toBe(failure);
        expect(getEventListeners(request.signal, "abort")).toHaveLength(abortListeners);
        handled += 1;
        response.status(503).send({ unavailable: true });
      }
    }

    @Controller()
    class UnreachableController {
      @Get()
      get() {
        return "unreachable";
      }
    }

    const app = createNestApp(
      {
        services: createModule().scoped(Local),
        bindings: ["local"],
        controllers: [UnreachableController],
        locals: (request: NestRequest) => {
          abortListeners = getEventListeners(request.signal, "abort").length - 1;
          if (mode === "async") return Promise.reject(failure);
          throw failure;
        },
      },
      (instance) => {
        instance.useGlobalFilters(new LocalsFailureFilter());
      },
    );

    const response = await app.inject("/");
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ unavailable: true });
    expect(handled).toBe(1);
    expect(acquired).toBe(0);
    await app.close();
  },
);

test("a native registration failure waits for rollback and retains its identity", async () => {
  const failure = new Error("Decorator registration failed");
  const releasing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let releases = 0;
  const Shared = resource("shared", {
    acquire: ResultTask.succeed(1),
    release: () =>
      ResultTask.tryPromise({
        try: async () => {
          releasing.resolve();
          await release.promise;
          releases += 1;
        },
        catch: (error) => error,
      }),
  });
  const app = createNestApp({
    services: createModule().singleton(Shared),
    appBindings: ["shared"],
    bindings: [],
  });
  const decorate = vi.spyOn(app, "decorate").mockImplementation(() => {
    throw failure;
  });
  let settled = false;
  const ready = tryResultAsync(async () => {
    await app.ready();
  }).match(
    () => {
      settled = true;
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  await releasing.promise;
  expect(settled).toBe(false);
  expect(releases).toBe(0);
  release.resolve();
  expect(await ready).toBe(failure);
  expect(releases).toBe(1);
  decorate.mockRestore();
  await app.close();
  expect(releases).toBe(1);
});

test("request release failures are logged once after the native response is sent", async () => {
  const logs: string[] = [];
  const logger: LoggerService = {
    log(message: unknown) {
      logs.push(String(message));
    },
    error(message: unknown) {
      logs.push(String(message));
    },
    warn(message: unknown) {
      logs.push(String(message));
    },
  };
  const Local = resource("local", {
    acquire: ResultTask.succeed(1),
    release: () => ResultTask.fail("cleanup"),
  });

  @Controller()
  class OkController {
    @Get()
    get() {
      return { ok: true };
    }
  }

  const app = createNestApp({
    services: createModule().scoped(Local),
    bindings: ["local"],
    logger,
    controllers: [OkController],
  });
  const response = await app.inject("/");
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true });
  expect(logs.filter((log) => log.includes("Request service cleanup failed"))).toHaveLength(1);
  await app.close();
});

test("root cleanup failure rejects close and preserves startup failure alongside rollback failure", async () => {
  let releases = 0;
  const Shared = resource("shared", {
    acquire: ResultTask.succeed(1),
    release: () =>
      ResultTask.sync(() => {
        releases += 1;
      }).flatMap(() => ResultTask.fail("release failed")),
  });
  const Failing = service("failing", ResultTask.fail("startup failed"));
  const app = createNestApp({
    services: createModule().singleton(Shared),
    appBindings: ["shared"],
    bindings: [],
  });
  await app.ready();
  await expect(app.close()).rejects.toThrow("Application service cleanup failed");
  expect(releases).toBe(1);

  const other = createNestApp({
    services: createModule().singleton(Shared).singleton(Failing),
    appBindings: ["shared", "failing"],
    bindings: [],
  });
  await expect(other.ready()).rejects.toMatchObject({
    message: "Service initialization and cleanup failed",
    errors: [
      expect.objectContaining({ cause: { _tag: "Fail", error: "startup failed" } }),
      expect.objectContaining({ message: "Application service cleanup failed" }),
    ],
  });
  expect(releases).toBe(2);
  await expect(other.close()).rejects.toThrow("Application service cleanup failed");
});

test("initTimeout retains cleanup ownership until pending startup work settles", async () => {
  const acquired = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<number>();
  let released = 0;
  const Shared = resource("shared", {
    acquire: ResultTask.sync(() => {
      acquired.resolve();
      return 1;
    }),
    release: () =>
      ResultTask.sync(() => {
        released += 1;
      }),
  });
  const Slow = service(
    "slow",
    ResultTask.tryPromise({ try: () => finish.promise, catch: (error) => error }),
  );
  const closingStarted = Promise.withResolvers<void>();
  const app = createNestApp(
    {
      services: createModule().singleton(Shared).singleton(Slow),
      appBindings: ["shared", "slow"],
      bindings: [],
      initTimeout: 30,
    },
    (instance) => {
      instance.addHook("preClose", async () => {
        closingStarted.resolve();
      });
    },
  );
  const ready = app.ready();
  await acquired.promise;
  await expect(ready).rejects.toThrow();
  let closed = false;
  const closing = app.close().then(() => {
    closed = true;
  });
  await closingStarted.promise;
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(closed).toBe(false);
  finish.resolve(2);
  await closing;
  expect(released).toBe(1);
});

test("a client abort during acquisition waits for and releases the acquired resource", async () => {
  const acquiring = Promise.withResolvers<void>();
  const acquired = Promise.withResolvers<number>();
  let released = 0;
  const Local = resource("local", {
    acquire: ResultTask.tryPromise({
      try: () => {
        acquiring.resolve();
        return acquired.promise;
      },
      catch: (error) => error,
    }),
    release: () =>
      ResultTask.sync(() => {
        released += 1;
      }),
  });

  @Controller()
  class DoneController {
    @Get()
    get() {
      return "done";
    }
  }

  const app = createNestApp({
    services: createModule().scoped(Local),
    bindings: ["local"],
    controllers: [DoneController],
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const url = serverUrl(app.server);
  const controller = new AbortController();
  const request = fetch(url, { signal: controller.signal }).catch(() => {
    /* This client is deliberately disconnected during provider acquisition. */
  });
  await acquiring.promise;
  controller.abort();
  await request;
  acquired.resolve(1);
  await expect.poll(() => released).toBe(1);
  await app.close();
  expect(released).toBe(1);
});

test("stream transport errors release resources without relying on finish", async () => {
  let released = 0;
  const Local = resource("local", {
    acquire: ResultTask.succeed(1),
    release: () =>
      ResultTask.sync(() => {
        released += 1;
      }),
  });
  const stream = new PassThrough();

  @Controller()
  class StreamErrorController {
    @Get()
    get(@Res() res: { raw: NodeJS.WritableStream & { destroy: (err?: Error) => void } }) {
      stream.on("error", (err) => {
        res.raw.destroy(err);
      });
      stream.write("first");
      stream.pipe(res.raw);
    }
  }

  const app = createNestApp({
    services: createModule().scoped(Local),
    bindings: ["local"],
    controllers: [StreamErrorController],
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const url = serverUrl(app.server);
  await new Promise<void>((resolve, reject) => {
    const client = httpRequest(url, (response) => {
      response.once("data", () => stream.destroy(new Error("stream failed")));
      response.once("error", () => resolve());
      response.once("end", () => resolve());
    });
    client.once("error", reject);
    client.end();
  });
  await expect.poll(() => released).toBe(1);
  await app.close();
});

test("transients are materialized per binding and values are not automatically owned", async () => {
  let created = 0;
  let disposed = 0;
  const External = {
    dispose: () => {
      disposed += 1;
    },
  };
  const Transient = service("transient", {}, () => {
    created += 1;
    return { id: created };
  });

  @Controller()
  class TransientController {
    @Get()
    get(@Services() values: { transient: { id: number }; external: typeof External }) {
      expect(values.transient).toBe(values.transient);
      return values.transient;
    }
  }

  const app = createNestApp({
    services: createModule().transient(Transient).value("external", External),
    bindings: ["transient", "external"],
    controllers: [TransientController],
  });
  expect((await app.inject("/")).json()).toEqual({ id: 1 });
  expect((await app.inject("/")).json()).toEqual({ id: 2 });
  await app.close();
  expect(disposed).toBe(0);
});
