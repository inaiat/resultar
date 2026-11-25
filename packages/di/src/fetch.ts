import { ResultTask } from "resultar";

/** Keeps a request scope alive until its response is consumed, fails, or is canceled. */
export const runScopedResponse = (
  request: Request,
  run: (respond: (response: Response) => ResultTask<void, unknown>) => ResultTask<void, unknown>,
): Promise<Response> => {
  const ready = Promise.withResolvers<Response>();
  const finished = Promise.withResolvers<void>();
  const signal = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined = undefined;
  let readerCancelPromise: Promise<void> | undefined = undefined;
  let output: ReadableStreamDefaultController<Uint8Array> | undefined = undefined;
  let empty: Response | undefined = undefined;
  let bodyFailure: unknown = undefined;
  let canceling = false;
  const cancel = (reason: unknown): Promise<void> => {
    canceling = true;
    if (reader === undefined) {
      signal.abort(reason);
      finished.resolve();
      return Promise.resolve();
    }
    if (readerCancelPromise !== undefined) return readerCancelPromise;
    const activeReader = reader;
    const deferred = Promise.withResolvers<void>();
    readerCancelPromise = deferred.promise;
    signal.abort(reason);
    try {
      Promise.resolve(activeReader.cancel(reason)).then(
        () => {
          finished.resolve();
          deferred.resolve();
        },
        (error: unknown) => {
          finished.resolve();
          deferred.reject(error);
        },
      );
    } catch (error) {
      finished.resolve();
      deferred.reject(error);
    }
    return readerCancelPromise;
  };
  const onAbort = () => {
    cancel(request.signal.reason).catch(ready.reject);
  };
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) onAbort();

  const completion = ResultTask.runExit(
    run((response) =>
      ResultTask.tryPromise({
        try: async () => {
          if (response.body === null) {
            empty = response;
            return;
          }
          const source: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
          reader = source;
          if (canceling) {
            await cancel(request.signal.reason);
            return;
          }
          const body = new ReadableStream<Uint8Array>(
            {
              start(controller) {
                output = controller;
              },
              async pull(controller) {
                try {
                  const chunk = await source.read();
                  if (canceling) return;
                  if (chunk.done) {
                    finished.resolve();
                    const exit = await completion;
                    if (exit._tag === "Failure")
                      controller.error(new Error("Request scope failed", { cause: exit.cause }));
                    else controller.close();
                  } else controller.enqueue(chunk.value);
                } catch (error) {
                  bodyFailure = error;
                  await cancel(error).catch(() => {
                    /* Preserve the original stream error. */
                  });
                  await completion;
                  controller.error(error);
                }
              },
              async cancel(reason) {
                try {
                  await cancel(reason);
                } finally {
                  await completion;
                }
              },
            },
            { highWaterMark: 0 },
          );
          ready.resolve(
            new Response(body, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            }),
          );
          await finished.promise;
        },
        catch: (error) => error,
      }),
    ),
    { signal: signal.signal },
  );

  completion
    .then((exit) => {
      request.signal.removeEventListener("abort", onAbort);
      reader?.releaseLock();
      if (exit._tag === "Failure") {
        const error = new Error("Request scope failed", { cause: exit.cause });
        ready.reject(error);
        output?.error(bodyFailure ?? error);
      } else if (empty !== undefined) ready.resolve(empty);
    })
    .catch(ready.reject);
  return ready.promise;
};
