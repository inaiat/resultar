/**
 * Collections, Control Flow & Side-Effect Observation
 *
 * This module demonstrates collection combinators (`all`, `combine`, `combineWithAllErrors`,
 * `zip`, `forEach`, `validateAll`, `firstSuccessOf`), structured loops (`loop`, `iterate`),
 * conditional branches (`if`, `when`, `unless`, `whenResult`, `unlessResult`),
 * value replacement (`as`, `asVoid`, `unit`, `unitAsync`), and observation hooks
 * (`inspect`, `inspectError`, `inspectBoth`, `tap`, `tapError`, `log`, `toDisposable`).
 */
import {
  Clock,
  Result,
  ResultAsync,
  ResultTask,
  createTaggedError,
  err,
  errAsync,
  ok,
  okAsync,
  unit,
  unitAsync,
  type StrictResult,
  type StrictResultAsync,
} from "resultar";

export interface OrderLineInput {
  readonly quantity: number;
  readonly sku: string;
  readonly unitCents: number;
}

export interface ValidOrderLine extends OrderLineInput {
  readonly index: number;
}

export interface ReservedLine {
  readonly position: number;
  readonly sku: string;
}

export class InvalidQuantityError extends createTaggedError({
  name: "InvalidQuantityError",
  message: "Invalid quantity for $sku",
}) {}

export class InvalidCouponError extends createTaggedError({
  name: "InvalidCouponError",
  message: "Invalid coupon $code",
}) {}

export class MissingInventoryError extends createTaggedError({
  name: "MissingInventoryError",
  message: "Missing inventory for $sku",
}) {}

export class AuditWriteError extends createTaggedError({
  name: "AuditWriteError",
  message: "Could not write audit event $entry",
}) {}

export class EmptyCartError extends createTaggedError({
  name: "EmptyCartError",
  message: "Cart is empty",
}) {}

const validateLine = (
  line: OrderLineInput,
  index: number,
): StrictResult<ValidOrderLine, InvalidQuantityError> =>
  line.quantity > 0 ? ok({ ...line, index }) : InvalidQuantityError.err({ sku: line.sku });

/**
 * `.filterOrElse(predicate, onFalse)` validates an existing `Ok` value in-place
 * and turns it into `Err` when the predicate fails.
 */
export const requireNonEmptyCart = (
  lines: readonly OrderLineInput[],
): StrictResult<readonly OrderLineInput[], EmptyCartError> =>
  ok(lines).filterOrElse(
    (value) => value.length > 0,
    () => new EmptyCartError(),
  );

/**
 * `.as(constantValue)` replaces the `Ok` payload with a constant while keeping errors intact.
 */
export const markCheckoutStarted = () => ok("checkout").as({ status: "started" as const });

/**
 * `.asVoid()` discards the `Ok` payload and produces `Result<void, E>`.
 */
export const clearCartSnapshot = () => ok({ items: 3 }).asVoid();

/**
 * `unit()` and `unitAsync()` construct `Ok<void, never>` / `ResultAsync<void, never>`
 * for side-effect-only steps that have no meaningful return value.
 */
export const acknowledgeCheckout = () => unit();

export const acknowledgeCheckoutAsync = () => unitAsync();

/**
 * `.asyncMap(fn)` lifts a synchronous `Result` into `ResultAsync` by applying an
 * infallible async transformation to the `Ok` value.
 */
export const enrichBuyerAsync = (buyerId: string) =>
  ok(buyerId).asyncMap(async (id) => ({
    id,
    tier: "gold" as const,
  }));

/**
 * `.asyncAndThen(fn)` chains a synchronous `Result` into a fallible `ResultAsync` step.
 */
export const reserveValidatedLine = (line: OrderLineInput) =>
  validateLine(line, 0).asyncAndThen((validLine) => reserveLine(validLine, validLine.index));

const validateCoupon = (
  code: string | undefined,
): StrictResult<{ readonly code: string; readonly discountCents: number }, InvalidCouponError> => {
  if (code === undefined) {
    return ok({ code: "none", discountCents: 0 });
  }

  return code === "SAVE10" ? ok({ code, discountCents: 1_000 }) : InvalidCouponError.err({ code });
};

/**
 * `Result.zip(left, right)` combines a pair of `Result` values into a `[Left, Right]` tuple.
 */
export const zipBuyerAndCart = () =>
  Result.zip(ok("buyer_1"), ok(["sku_book", "sku_pen"] as const));

/**
 * `Result.combine(recordOrIterable)` and `Result.all(recordOrIterable)` short-circuit
 * on the first `Err` and preserve named record keys or array elements on `Ok`.
 */
export const combineOrderContext = (coupon: string | undefined) =>
  Result.combine({
    buyerId: ok("buyer_1"),
    coupon: validateCoupon(coupon),
  });

export const allOrderChecks = (coupon: string | undefined) =>
  Result.all({
    buyerId: ok("buyer_1"),
    coupon: validateCoupon(coupon),
  });

/**
 * `Result.validateAll(items, mapper)` runs `mapper` on every item and accumulates
 * all errors into a non-empty array instead of stopping at the first failure.
 */
export const validateOrderLines = (lines: readonly OrderLineInput[]) =>
  Result.validateAll(lines, validateLine);

/**
 * `Result.combineWithAllErrors(recordOrIterable)` combines multiple `Result` values
 * and accumulates all errors across fields when more than one fails.
 */
export const validateCheckout = (lines: readonly OrderLineInput[], coupon: string | undefined) =>
  Result.combineWithAllErrors({
    coupon: validateCoupon(coupon),
    lines: validateOrderLines(lines),
  });

/**
 * `Result.forEach(items, mapper)` maps each item sequentially and stops on the first `Err`.
 */
export const collectLineTotals = (lines: readonly OrderLineInput[]) =>
  Result.forEach(lines, (line, index) =>
    validateLine(line, index).map((validLine) => ({
      index,
      totalCents: validLine.quantity * validLine.unitCents,
    })),
  );

/**
 * `Result.loop(initial, { while, step, body })` collects each iteration's `Ok`
 * result into an array until `while(state)` returns `false` or `body` returns `Err`.
 */
export const invoiceSchedule = () =>
  Result.loop(1, {
    body: (month) => ok(`invoice:${month}`),
    step: (month) => month + 1,
    while: (month) => month <= 3,
  });

/**
 * `Result.iterate(initial, { while, body })` threads state across iterations and
 * returns only the final state (without allocating an array of intermediate values).
 */
export const finalCursor = () =>
  Result.iterate(0, {
    body: (cursor) => ok(cursor + 1),
    while: (cursor) => cursor < 3,
  });

/**
 * Conditional branching helpers (`if`, `when`, `unless`, `whenResult`, `unlessResult`).
 * `when` and `unless` return `Result<T | undefined, E>` (`Ok(undefined)` when skipped).
 */
export const chooseFulfillment = (expedited: boolean) =>
  Result.if(expedited, {
    onFalse: () => ok({ mode: "standard" as const }),
    onTrue: () => ok({ mode: "express" as const }),
  });

export const maybeAudit = (enabled: boolean) =>
  Result.when(enabled, () => ok("audit-written" as const));

export const maybeAuditAfterFlag = (enabled: boolean) =>
  Result.whenResult(ok(enabled), () => ok("audit-from-result" as const));

export const maybeFraudCheck = (trustedBuyer: boolean) =>
  Result.unless(trustedBuyer, () => ok("fraud-check" as const));

export const maybeFraudCheckAfterFlag = (trustedBuyer: boolean) =>
  Result.unlessResult(ok(trustedBuyer), () => ok("fraud-check-from-result" as const));

/**
 * Async conditional branching helpers on `ResultAsync`.
 */
export const chooseAsyncFulfillment = (expedited: boolean) =>
  ResultAsync.if(expedited, {
    onFalse: () => okAsync({ mode: "standard" as const }),
    onTrue: () => okAsync({ mode: "express" as const }),
  });

export const maybeAsyncAudit = (enabled: boolean) =>
  ResultAsync.when(enabled, () => okAsync("async-audit-written" as const));

export const maybeAsyncAuditAfterFlag = (enabled: boolean) =>
  ResultAsync.whenResult(okAsync(enabled), () => okAsync("async-audit-from-result" as const));

export const maybeAsyncFraudCheck = (trustedBuyer: boolean) =>
  ResultAsync.unless(trustedBuyer, () => okAsync("async-fraud-check" as const));

export const maybeAsyncFraudCheckAfterFlag = (trustedBuyer: boolean) =>
  ResultAsync.unlessResult(
    okAsync(trustedBuyer),
    () => okAsync("async-fraud-from-result" as const),
  );

const reserveLine = (
  line: OrderLineInput,
  index: number,
): StrictResultAsync<ReservedLine, MissingInventoryError> =>
  ResultAsync.fromSafePromise(Promise.resolve({ index, line })).andThen(({ index, line }) =>
    line.sku === "missing"
      ? MissingInventoryError.err({ sku: line.sku })
      : ok({ position: index, sku: line.sku }),
  );

/**
 * `ResultAsync.forEach` processes items with configurable concurrency (`number | "unbounded"`)
 * and optional `{ discard: true }` when only side effects matter.
 */
export const reserveInventory = (lines: readonly OrderLineInput[]) =>
  ResultAsync.forEach(lines, reserveLine, { concurrency: 2 });

/**
 * `ResultAsync.validateAll` runs async validation across all items (with optional
 * concurrency) and collects every error instead of failing fast.
 */
export const validateInventory = (lines: readonly OrderLineInput[]) =>
  ResultAsync.validateAll(lines, reserveLine, { concurrency: "unbounded" });

export const saveAuditTrail = (entries: readonly string[]) =>
  ResultAsync.forEach(
    entries,
    (entry) =>
      entry === "bad"
        ? errAsync(new AuditWriteError({ entry }))
        : okAsync({ entry, written: true }),
    { concurrency: 2, discard: true },
  );

/**
 * `ResultAsync.combine`, `ResultAsync.all`, `ResultAsync.combineWithAllErrors`,
 * `ResultAsync.zip`, `ResultAsync.firstSuccessOf`, `ResultAsync.loop`, and `ResultAsync.iterate`.
 */
export const combineAsyncOrderContext = () =>
  ResultAsync.combine({
    inventory: okAsync("reserved"),
    payment: okAsync("authorized"),
  });

export const allAsyncOrderChecks = () =>
  ResultAsync.all({
    inventory: okAsync("reserved" as const),
    payment: okAsync("authorized" as const),
  });

export const validateAsyncCheckout = (
  lines: readonly OrderLineInput[],
  coupon: string | undefined,
) =>
  ResultAsync.combineWithAllErrors({
    coupon: validateCoupon(coupon).asyncMap((value) => Promise.resolve(value)),
    inventory: reserveInventory(lines),
  });

export const firstAvailableWarehouse = (sku: string) =>
  ResultAsync.firstSuccessOf([
    () => errAsync<ReservedLine, MissingInventoryError>(new MissingInventoryError({ sku })),
    () => okAsync<ReservedLine, MissingInventoryError>({ position: 1, sku }),
  ]);

export const asyncInvoiceSchedule = () =>
  ResultAsync.loop(1, {
    body: (month) => okAsync(`async-invoice:${month}`),
    step: (month) => month + 1,
    while: (month) => month <= 3,
  });

export const asyncFinalCursor = () =>
  ResultAsync.iterate(0, {
    body: (cursor) => okAsync(cursor + 1),
    while: (cursor) => cursor < 3,
  });

export const zipAsyncOrderIds = () => ResultAsync.zip(okAsync("order_1"), okAsync("receipt_1"));

/**
 * Preferred non-deprecated side-effect inspection helpers (`inspect`, `inspectError`, `inspectBoth`).
 * These observe `Ok` and `Err` values without altering the `Result` or `ResultAsync`.
 */
export const inspectCheckoutEvents = async () => {
  const events: string[] = [];

  void ok<string, AuditWriteError>("order_inspect")
    .inspect((value) => {
      events.push(`inspect:${value}`);
    })
    .inspectError((error) => {
      events.push(`inspectError:${error._tag}`);
    })
    .inspectBoth({
      err: (error) => {
        events.push(`bothErr:${error._tag}`);
      },
      ok: (value) => {
        events.push(`bothOk:${value}`);
      },
    });

  void (await errAsync<string, AuditWriteError>(new AuditWriteError({ entry: "failed_inspect" }))
    .inspect((value) => {
      events.push(`asyncInspect:${value}`);
    })
    .inspectError((error) => {
      events.push(`asyncInspectError:${error._tag}`);
    })
    .inspectBoth({
      err: (error) => {
        events.push(`asyncBothErr:${error._tag}`);
      },
      ok: (value) => {
        events.push(`asyncBothOk:${value}`);
      },
    }));

  return events;
};

/**
 * Legacy `tap` / `tapError` alongside `log` and explicit resource management
 * (`toDisposable` / `toAsyncDisposable`).
 */
export const observeCheckout = () => {
  const events: string[] = [];

  ok<string, AuditWriteError>("order_1")
    .tap((value) => events.push(`tap:${value}`))
    .tapError((error) => events.push(`tapError:${error._tag}`))
    .log((value, error) => events.push(`log:${value ?? error?._tag}`))
    .toDisposable((value, error) => {
      events.push(`dispose:${value ?? error?._tag}`);
    })
    [Symbol.dispose]();

  err<string, AuditWriteError>(new AuditWriteError({ entry: "receipt" }))
    .tap((value) => events.push(`tap:${value}`))
    .tapError((error) => events.push(`tapError:${error._tag}`))
    .log((value, error) => events.push(`log:${value ?? error?._tag}`))
    .toDisposable((value, error) => {
      events.push(`dispose:${value ?? error?._tag}`);
    })
    [Symbol.dispose]();

  return events;
};

export const observeAsyncCheckout = async () => {
  const events: string[] = [];

  await okAsync<string, AuditWriteError>("async_order")
    .tap((value) => {
      events.push(`tap:${value}`);
    })
    .tapError((error) => {
      events.push(`tapError:${error._tag}`);
    })
    .log((value, error) => {
      events.push(`log:${value ?? error?._tag}`);
    })
    .toAsyncDisposable(async (value, error) => {
      events.push(`dispose:${value ?? error?._tag}`);
    })
    [Symbol.asyncDispose]();

  return events;
};

/**
 * `ResultTask` control-flow, collection, and timing helpers (`if`, `when`, `unless`,
 * `loop`, `iterate`, `firstSuccessOf`, `zip` with `{ concurrent: true }`, `delay`, `timed`).
 */
export const runTaskControlFlow = async () => {
  const clock = Clock.virtual(0);

  const taskProgram = ResultTask.gen(function* () {
    const branch = yield* ResultTask.if(true, {
      onFalse: () => ResultTask.ok("standard" as const),
      onTrue: () => ResultTask.ok("express" as const),
    });

    const whenValue = yield* ResultTask.when(true, () => ResultTask.ok("audited" as const));
    const unlessValue = yield* ResultTask.unless(true, () => ResultTask.ok("skipped" as const));

    const looped = yield* ResultTask.loop(1, {
      body: (step) => ResultTask.ok(`step:${step}`),
      step: (step) => step + 1,
      while: (step) => step <= 2,
    });

    const iterated = yield* ResultTask.iterate(0, {
      body: (count) => ResultTask.ok(count + 2),
      while: (count) => count < 4,
    });

    const fallback = yield* ResultTask.firstSuccessOf([
      () => ResultTask.err(new MissingInventoryError({ sku: "primary" })),
      () => ResultTask.ok("warehouse:backup" as const),
    ]);

    const zipped = yield* ResultTask.zip(
      ResultTask.ok("left" as const),
      ResultTask.ok("right" as const),
      { concurrent: true },
    );

    const [elapsedMs, delayedValue] = yield* ResultTask.ok("ready" as const).delay(5).timed();

    return {
      branch,
      delayedValue,
      elapsedMs,
      fallback,
      iterated,
      looped,
      unlessValue,
      whenValue,
      zipped,
    };
  });

  const running = ResultTask.runPromise(taskProgram, { clock });
  await clock.advanceBy(5);
  return running;
};
