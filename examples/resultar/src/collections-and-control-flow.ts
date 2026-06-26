import {
  Result,
  ResultAsync,
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

export const requireNonEmptyCart = (
  lines: readonly OrderLineInput[],
): StrictResult<readonly OrderLineInput[], EmptyCartError> =>
  ok(lines).filterOrElse(
    (value) => value.length > 0,
    () => new EmptyCartError(),
  );

export const markCheckoutStarted = () => ok("checkout").as({ status: "started" as const });

export const acknowledgeCheckout = () => unit();

export const acknowledgeCheckoutAsync = () => unitAsync();

export const enrichBuyerAsync = (buyerId: string) =>
  ok(buyerId).asyncMap(async (id) => ({
    id,
    tier: "gold" as const,
  }));

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

export const zipBuyerAndCart = () =>
  Result.zip(ok("buyer_1"), ok(["sku_book", "sku_pen"] as const));

export const combineOrderContext = (coupon: string | undefined) =>
  Result.combine({
    buyerId: ok("buyer_1"),
    coupon: validateCoupon(coupon),
  });

export const validateOrderLines = (lines: readonly OrderLineInput[]) =>
  Result.validateAll(lines, validateLine);

export const validateCheckout = (lines: readonly OrderLineInput[], coupon: string | undefined) =>
  Result.combineWithAllErrors({
    coupon: validateCoupon(coupon),
    lines: validateOrderLines(lines),
  });

export const collectLineTotals = (lines: readonly OrderLineInput[]) =>
  Result.forEach(lines, (line, index) =>
    validateLine(line, index).map((validLine) => ({
      index,
      totalCents: validLine.quantity * validLine.unitCents,
    })),
  );

export const invoiceSchedule = () =>
  Result.loop(1, {
    body: (month) => ok(`invoice:${month}`),
    step: (month) => month + 1,
    while: (month) => month <= 3,
  });

export const finalCursor = () =>
  Result.iterate(0, {
    body: (cursor) => ok(cursor + 1),
    while: (cursor) => cursor < 3,
  });

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

export const chooseAsyncFulfillment = (expedited: boolean) =>
  ResultAsync.if(expedited, {
    onFalse: () => okAsync({ mode: "standard" as const }),
    onTrue: () => okAsync({ mode: "express" as const }),
  });

export const maybeAsyncAudit = (enabled: boolean) =>
  ResultAsync.when(enabled, () => okAsync("async-audit-written" as const));

export const maybeAsyncFraudCheck = (trustedBuyer: boolean) =>
  ResultAsync.unless(trustedBuyer, () => okAsync("async-fraud-check" as const));

const reserveLine = (
  line: OrderLineInput,
  index: number,
): StrictResultAsync<ReservedLine, MissingInventoryError> =>
  ResultAsync.fromSafePromise(Promise.resolve({ index, line })).andThen(({ index, line }) =>
    line.sku === "missing"
      ? MissingInventoryError.err({ sku: line.sku })
      : ok({ position: index, sku: line.sku }),
  );

export const reserveInventory = (lines: readonly OrderLineInput[]) =>
  ResultAsync.forEach(lines, reserveLine, { concurrency: 2 });

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

export const combineAsyncOrderContext = () =>
  ResultAsync.combine({
    inventory: okAsync("reserved"),
    payment: okAsync("authorized"),
  });

export const zipAsyncOrderIds = () => ResultAsync.zip(okAsync("order_1"), okAsync("receipt_1"));

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
