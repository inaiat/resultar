/**
 * Linear Domain Workflow Cookbook (`domain-workflow.ts`)
 *
 * Demonstrates:
 * - Chaining dependent domain steps with `.andThen()`, `.map()`, and `.mapErr()`
 * - Writing linear imperative-style workflows with `Result.gen` and `ResultTask.gen`
 *   (returning plain values and unwrapping typed steps via `yield*`)
 * - Preserving the legacy `safeTry` generator helper for gradual v4 migration
 * - Wrapping low-level infrastructure causes (`StorageWriteError`) in domain errors
 *   (`AccountCreateError`) and inspecting the cause chain with `findCause`
 * - Exhaustive error union handling at the boundary with `.matchTags()`
 */
import {
  Result,
  ResultTask,
  createTaggedError,
  findCause,
  ok,
  safeTry,
  type StrictResult,
} from "resultar";

export interface PaidAccountRequest {
  readonly cardToken: string;
  readonly email: string;
  readonly planCode: string;
}

export interface PaidAccount {
  readonly email: string;
  readonly id: string;
  readonly planCode: string;
  readonly receiptId: string;
}

interface Plan {
  readonly code: string;
  readonly priceCents: number;
}

interface Receipt {
  readonly id: string;
}

export class PlanNotFoundError extends createTaggedError({
  name: "PlanNotFoundError",
  message: "Plan $planCode was not found",
}) {}

export class PaymentDeclinedError extends createTaggedError({
  name: "PaymentDeclinedError",
  message: "Payment was declined for $cardToken",
}) {}

export class StorageWriteError extends createTaggedError({
  name: "StorageWriteError",
  message: "Failed to store account for $email",
}) {}

export class AccountCreateError extends createTaggedError({
  name: "AccountCreateError",
  message: "Could not create account for $email",
}) {}

export type CreatePaidAccountError = AccountCreateError | PaymentDeclinedError | PlanNotFoundError;

const plans = new Map<string, Plan>([
  ["team", { code: "team", priceCents: 2900 }],
  ["enterprise", { code: "enterprise", priceCents: 9900 }],
]);

/** Looks up a subscription plan in memory and returns `PlanNotFoundError` when absent. */
const selectPlan = (planCode: string): StrictResult<Plan, PlanNotFoundError> => {
  const plan = plans.get(planCode);

  return plan === undefined ? PlanNotFoundError.err({ planCode }) : ok(plan);
};

/** Simulates a synchronous card charge that fails for declined tokens. */
const chargeCard = (
  cardToken: string,
  amountCents: number,
): StrictResult<Receipt, PaymentDeclinedError> => {
  void amountCents;

  return cardToken === "card_declined"
    ? PaymentDeclinedError.err({ cardToken })
    : ok({ id: `rcpt_${cardToken.slice(-4)}` });
};

/** Simulates persisting the account record; fails with `StorageWriteError` for blocked domains. */
const persistAccount = (
  request: PaidAccountRequest,
  plan: Plan,
  receipt: Receipt,
): StrictResult<PaidAccount, StorageWriteError> =>
  request.email.endsWith("@blocked.example")
    ? StorageWriteError.err({ email: request.email })
    : ok({
        email: request.email,
        id: `acct_${request.email.length}`,
        planCode: plan.code,
        receiptId: receipt.id,
      });

/**
 * Combinator style: chains `selectPlan` -> `chargeCard` -> `persistAccount` with `.andThen()`,
 * translating the low-level `StorageWriteError` into `AccountCreateError` via `.mapErr()`.
 */
export const createPaidAccount = (
  request: PaidAccountRequest,
): StrictResult<PaidAccount, CreatePaidAccountError> =>
  selectPlan(request.planCode)
    .andThen((plan) =>
      chargeCard(request.cardToken, plan.priceCents).map((receipt) => ({
        plan,
        receipt,
      })),
    )
    .andThen(({ plan, receipt }) =>
      persistAccount(request, plan, receipt).mapErr(
        (cause) => new AccountCreateError({ cause, email: request.email }),
      ),
    );

/**
 * Canonical generator style (`Result.gen`):
 * - Unwraps each `Result` with `yield*` (short-circuiting on the first `Err`)
 * - Returns a plain success value (`PaidAccount`) which `Result.gen` wraps in `Ok`
 */
export const createPaidAccountWithGen = (
  request: PaidAccountRequest,
): StrictResult<PaidAccount, CreatePaidAccountError> =>
  Result.gen(function* () {
    const plan = yield* selectPlan(request.planCode);
    const receipt = yield* chargeCard(request.cardToken, plan.priceCents);

    return yield* persistAccount(request, plan, receipt).mapErr(
      (cause) => new AccountCreateError({ cause, email: request.email }),
    );
  });

/**
 * Lazy Task generator style: mixes synchronous domain Results with a Promise boundary.
 * Constructing the Task performs no work; each explicit runner executes the workflow again.
 */
export const createPaidAccountTaskWithGen = (
  request: PaidAccountRequest,
): ResultTask<PaidAccount, CreatePaidAccountError> =>
  ResultTask.gen(function* () {
    const plan = yield* selectPlan(request.planCode);
    const receipt = yield* chargeCard(request.cardToken, plan.priceCents);
    const persisted = yield* ResultTask.tryPromise({
      try: () => Promise.resolve({ plan, receipt }),
      catch: (cause) => new StorageWriteError({ cause, email: request.email }),
    })
      .andThen(({ plan, receipt }) => ResultTask.fromResult(persistAccount(request, plan, receipt)))
      .mapErr((cause) => new AccountCreateError({ cause, email: request.email }));

    return persisted;
  });

/**
 * Legacy `safeTry` generator style (preserved for gradual v4 migration):
 * Unlike `Result.gen`, `safeTry` expects the generator body to return a `Result` directly.
 */
export const createPaidAccountWithSafeTry = (
  request: PaidAccountRequest,
): StrictResult<PaidAccount, CreatePaidAccountError | PaymentDeclinedError | PlanNotFoundError> =>
  safeTry(function* () {
    const plan = yield* selectPlan(request.planCode);
    const receipt = yield* chargeCard(request.cardToken, plan.priceCents);

    return persistAccount(request, plan, receipt).mapErr(
      (cause) => new AccountCreateError({ cause, email: request.email }),
    );
  });

/**
 * Traverses the `Error.cause` chain of a domain error using `findCause` to locate
 * a specific tagged root cause (`StorageWriteError`) without manual `instanceof` loops.
 */
export const findStorageCause = (error: Error): StorageWriteError | undefined =>
  findCause(error, StorageWriteError);

/**
 * Exhaustively matches every member of `CreatePaidAccountError` by `_tag` at the HTTP boundary.
 * Adding a new error variant to `createPaidAccount` will trigger a compile-time error here.
 */
export const createPaidAccountResponse = (request: PaidAccountRequest) =>
  createPaidAccount(request).matchTags((account) => ({ body: account, statusCode: 201 }), {
    AccountCreateError: (error) => ({
      body: { code: error._tag, message: error.message },
      statusCode: 500,
    }),
    PaymentDeclinedError: (error) => ({
      body: { code: error._tag, message: error.message },
      statusCode: 402,
    }),
    PlanNotFoundError: (error) => ({
      body: { code: error._tag, message: error.message },
      statusCode: 404,
    }),
  });
