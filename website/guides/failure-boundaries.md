# Handle failures and cleanup

A checkout can tell a customer that stock ran out. A bug in the price calculation calls for a different response. Choose a runner based on who handles the outcome.

| What the caller needs                                                      | Runner         | What the caller receives                                                                                           |
| -------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------ |
| Return a response for success or an expected business failure              | `runResult()`  | A native Promise resolving to `Ok` or a simple typed `Err`. Defects, interruption, and composite causes reject it. |
| Supply a success value to a Promise-based API                              | `runPromise()` | A native Promise resolving to the value and rejecting on failure.                                                  |
| Record the outcome of a background job, including defects and interruption | `runExit()`    | An `Exit` containing the success value or a structured failure cause.                                              |

## Inspect an unexpected failure

A thrown exception inside `map` becomes a defect. A worker can inspect it without converting the bug into a customer-facing inventory error.

```ts
import { Cause, ResultTask } from "resultar";

const priceOrder = ResultTask.ok(2).map(() => {
  throw new Error("Missing price table");
});

const exit = await priceOrder.runExit();
if (exit._tag === "Failure") {
  console.log(Cause.failures(exit.cause).length); // 0 typed failures
  console.log(Cause.defects(exit.cause).length); // 1 defect
}
```

Try replacing `priceOrder` with `ResultTask.err("InsufficientStock")`. The counts switch to one typed failure and zero defects. For an external call whose failure you expect, map it deliberately with [tryPromise](./async-workflow.md#wrap-the-driver-call).

## Release a resource on failure

Suppose the inventory driver lends the worker a session. Register its release when acquiring it. The following in-memory session records each step, so you can see when cleanup finishes.

```ts
import { ResultTask } from "resultar";

const events: string[] = [];
const session = ResultTask.acquireRelease({
  acquire: ResultTask.sync(() => {
    events.push("open");
    return {
      close() {
        events.push("close");
      },
    };
  }),
  release: (handle) => ResultTask.sync(() => handle.close()),
});

const checkStock = ResultTask.gen(function* () {
  yield* session;
  events.push("check");
  return yield* ResultTask.err("InsufficientStock");
}).scoped();

const result = await checkStock.runResult();
console.log(result.isErr()); // true
console.log(events.join(" → ")); // open → check → close
```

By the time the runner resolves, the scope has released the session. Replace the last line inside the generator with `return 2`. The result becomes an `Ok` and the event order stays the same. In a real driver, return the task that performs the close so the scope can await it.

See [resource scopes and application lifecycle](../../packages/resultar/README.md#resource-scopes-and-application-lifecycle) for asynchronous finalizers and release errors. For request-scoped services, choose the adapter for [Fastify](../../packages/fastify/README.md), [Hono](../../packages/hono/README.md), or [NestJS](../../packages/nestjs/README.md).
