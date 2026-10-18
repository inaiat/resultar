/**
 * Collections, Control Flow & Side-Effect Observation
 *
 * This module demonstrates collection combinators (`all`, `combine`, `combineWithAllErrors`,
 * `zip`, `forEach`, `validateAll`, `firstSuccessOf`), structured loops (`loop`, `iterate`),
 * conditional branches (`if`, `when`, `unless`, `whenResult`, `unlessResult`),
 * value replacement (`as`, `asVoid`, `unit`), and observation hooks
 * (`inspect`, `inspectError`, `inspectBoth`, `tap`, `tapError`, `log`, `toDisposable`).
 * Async recipes use lazy Tasks and explicit runners, with scoped native disposal.
 */
import {
  Clock,
  Result,
  ResultTask,
  createTaggedError,
  err,
  ok,
  unit,
  type StrictResult,
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
 * `unit()` and `ResultTask.ok(undefined)` represent side-effect-only steps
 * that have no meaningful return value.
 */
export const acknowledgeCheckout = () => unit();

export const acknowledgeCheckoutTask = () => ResultTask.ok<void>(undefined);

/**
 * `fromResult` lifts a synchronous Result into a Task; `map` transforms its success lazily.
 * Promise-based enrichment would use `andThen` with `ResultTask.tryPromise` instead.
 */
export const enrichBuyerTask = (buyerId: string) =>
  ResultTask.fromResult(ok(buyerId)).map((id) => ({
    id,
    tier: "gold" as const,
  }));

/**
 * `fromResult` and `andThen` chain synchronous validation into a fallible Task step.
 */
export const reserveValidatedLine = (line: OrderLineInput) =>
  ResultTask.fromResult(validateLine(line, 0)).andThen((validLine) =>
    reserveLine(validLine, validLine.index),
  );

interface ValidCoupon {
  readonly code: string;
  readonly discountCents: number;
}

const validateCoupon = (
  code: string | undefined,
): StrictResult<ValidCoupon, InvalidCouponError> => {
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
 * Lazy conditional branching helpers on ResultTask.
 * A Task-produced flag composes with `andThen` before selecting the branch.
 */
export const chooseTaskFulfillment = (expedited: boolean) =>
  ResultTask.if(expedited, {
    onFalse: () => ResultTask.ok({ mode: "standard" as const }),
    onTrue: () => ResultTask.ok({ mode: "express" as const }),
  });

export const maybeTaskAudit = (enabled: boolean) =>
  ResultTask.when(enabled, () => ResultTask.ok("async-audit-written" as const));

export const maybeTaskAuditAfterFlag = (enabled: boolean) =>
  ResultTask.ok(enabled).andThen((flag) =>
    ResultTask.when(flag, () => ResultTask.ok("async-audit-from-result" as const)),
  );

export const maybeTaskFraudCheck = (trustedBuyer: boolean) =>
  ResultTask.unless(trustedBuyer, () => ResultTask.ok("async-fraud-check" as const));

export const maybeTaskFraudCheckAfterFlag = (trustedBuyer: boolean) =>
  ResultTask.ok(trustedBuyer).andThen((flag) =>
    ResultTask.unless(flag, () => ResultTask.ok("async-fraud-from-result" as const)),
  );

const reserveLine = (
  line: OrderLineInput,
  index: number,
): ResultTask<ReservedLine, MissingInventoryError> =>
  ResultTask.sync(() => ({ index, line })).andThen(({ index, line }) =>
    line.sku === "missing"
      ? MissingInventoryError.taskErr({ sku: line.sku })
      : ResultTask.ok({ position: index, sku: line.sku }),
  );

/**
 * `ResultTask.forEach` processes items lazily with configurable concurrency.
 * Apply `asVoid` to its result when only side effects matter.
 */
export const reserveInventory = (lines: readonly OrderLineInput[]) =>
  ResultTask.forEach(lines, reserveLine, { concurrency: 2 });

/**
 * `ResultTask.validateAll` runs validation across all items (with optional
 * concurrency) and collects every error instead of failing fast.
 */
export const validateInventory = (lines: readonly OrderLineInput[]) =>
  ResultTask.validateAll(lines, reserveLine, { concurrency: "unbounded" });

export const saveAuditTrail = (entries: readonly string[]) =>
  ResultTask.forEach(
    entries,
    (entry) =>
      entry === "bad"
        ? AuditWriteError.taskErr({ entry })
        : ResultTask.ok({ entry, written: true }),
    { concurrency: 2 },
  ).asVoid();

/**
 * Task records use `all`, with explicit concurrency. Heterogeneous validation first
 * captures each typed outcome as a Result, then combines those values to collect errors.
 * `zip`, `firstSuccessOf`, `loop`, and `iterate` remain lazy Task operators.
 */
export const combineTaskOrderContext = () =>
  ResultTask.all(
    {
      inventory: ResultTask.ok("reserved"),
      payment: ResultTask.ok("authorized"),
    },
    { concurrency: "unbounded" },
  );

export const allTaskOrderChecks = () =>
  ResultTask.all(
    {
      inventory: ResultTask.ok("reserved" as const),
      payment: ResultTask.ok("authorized" as const),
    },
    { concurrency: "unbounded" },
  );

export const validateTaskCheckout = (
  lines: readonly OrderLineInput[],
  coupon: string | undefined,
) =>
  ResultTask.all(
    {
      coupon: ResultTask.sync(() => validateCoupon(coupon)),
      inventory: reserveInventory(lines).match({
        ok: (value) => ok<ReservedLine[], MissingInventoryError>(value),
        err: (error) => err<ReservedLine[], MissingInventoryError>(error),
      }),
    },
    { concurrency: "unbounded" },
  ).andThen((checks) => ResultTask.fromResult(Result.combineWithAllErrors(checks)));

export const firstAvailableWarehouse = (sku: string) =>
  ResultTask.firstSuccessOf([
    () => MissingInventoryError.taskErr({ sku }),
    () => ResultTask.ok<ReservedLine, MissingInventoryError>({ position: 1, sku }),
  ]);

export const taskInvoiceSchedule = () =>
  ResultTask.loop(1, {
    body: (month) => ResultTask.ok(`async-invoice:${month}`),
    step: (month) => month + 1,
    while: (month) => month <= 3,
  });

export const taskFinalCursor = () =>
  ResultTask.iterate(0, {
    body: (cursor) => ResultTask.ok(cursor + 1),
    while: (cursor) => cursor < 3,
  });

export const zipTaskOrderIds = () =>
  ResultTask.zip(ResultTask.ok("order_1"), ResultTask.ok("receipt_1"), { concurrent: true });

/**
 * Preferred non-deprecated side-effect inspection helpers (`inspect`, `inspectError`, `inspectBoth`).
 * These observe successes and failures without altering the Result or Task outcome.
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

  void (await ResultTask.runResult(
    AuditWriteError.taskErr({ entry: "failed_inspect" })
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
      }),
  ));

  return events;
};

/**
 * Legacy `tap` / `tapError` alongside `log` and explicit resource management
 * (`toDisposable`).
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

/**
 * Tasks use `inspect` for best-effort observation and `acquireDisposable` for native
 * async cleanup. Scope closure awaits disposal and preserves any disposal defect.
 */
export const observeTaskCheckout = async () => {
  const events: string[] = [];

  const checkout = ResultTask.ok<string, AuditWriteError>("async_order")
    .inspect((value) => {
      events.push(`tap:${value}`);
    })
    .inspectError((error) => {
      events.push(`tapError:${error._tag}`);
    })
    .inspectBoth({
      ok: (value) => {
        events.push(`log:${value}`);
      },
      err: (error) => {
        events.push(`log:${error._tag}`);
      },
    });

  const program = ResultTask.scoped(
    ResultTask.gen(function* () {
      const value = yield* checkout;
      yield* ResultTask.acquireDisposable(
        ResultTask.sync(() => ({
          [Symbol.asyncDispose]: async () => {
            events.push(`dispose:${value}`);
          },
        })),
      );
      return value;
    }),
  );
  await ResultTask.runPromise(program);

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

    const [elapsedMs, delayedValue] = yield* ResultTask.ok("ready" as const)
      .delay(5)
      .timed();

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
