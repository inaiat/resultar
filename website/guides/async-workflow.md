# Compose a lazy workflow

The checkout now needs to read available stock. The caller needs to distinguish an invalid quantity, an unavailable inventory service, and a valid request that exceeds stock. Keep those outcomes in the workflow so the handler can give each one a different response.

## Wrap the driver call

`tryPromise` accepts a factory. The task calls it on each run and passes an `AbortSignal` that a real driver can use to cancel its work. Its `catch` function converts a rejection into a typed failure. This in-memory driver counts reads so you can see when it runs.

```ts
import { ResultTask } from "resultar";

let reads = 0;
const readStock = ResultTask.tryPromise({
  try: async (signal) => {
    signal.throwIfAborted();
    reads += 1;
    return 4;
  },
  catch: () => "InventoryUnavailable" as const,
});

console.log(reads); // 0
await readStock.runResult();
await readStock.runResult();
console.log(reads); // 2
```

Construct the Promise inside the factory. If you create it before calling `tryPromise`, the driver starts immediately and later runs share that same operation.

## Short-circuit before doing I/O

This handler receives a numeric quantity from the form. The generator consumes a synchronous `Result` and a lazy `ResultTask` with the same `yield*` syntax. The first failure ends the workflow and skips the remaining steps.

```ts
import { err, ok, ResultTask, type Result } from "resultar";

function checkQuantity(count: number): Result<number, "InvalidQuantity"> {
  return Number.isSafeInteger(count) && count > 0 ? ok(count) : err("InvalidQuantity");
}

const checkOrder = (count: number, readStock: () => Promise<number>) =>
  ResultTask.gen(function* () {
    const quantity = yield* checkQuantity(count);
    const available = yield* ResultTask.tryPromise({
      try: readStock,
      catch: () => "InventoryUnavailable" as const,
    });
    if (quantity > available) return yield* err("InsufficientStock" as const);
    return quantity;
  });

let reads = 0;
const inventory = async () => {
  reads += 1;
  return 4;
};

for (const count of [0, 5, 2]) {
  const result = await checkOrder(count, inventory).runResult();
  console.log(result.match({ ok: (n) => `Ready: ${n}`, err: (reason) => reason }));
}
console.log(reads); // 2
```

The output is `InvalidQuantity`, `InsufficientStock`, then `Ready: 2`. Only the last two requests read inventory. Replace the driver's `return 4` with `throw new Error("offline")` and run again. Those two requests now produce `InventoryUnavailable`.

## Run at the application boundary

`checkOrder` returns the task directly. A handler, CLI command, or test starts it with `await task.runResult()` and receives a `Result` from a native `Promise<Result<T, E>>`. Each call to `runResult()` starts a fresh execution, so retries and repeated handler invocations never accidentally share an already-settled Promise.

Continue with [failure handling and cleanup](./failure-boundaries.md) to see what a worker can inspect when a callback throws. For a real HTTP driver, see the [JSON request client](../../packages/request/README.md).
