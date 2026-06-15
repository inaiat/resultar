import { createTaggedError, ok, safeTry, type StrictResult } from "resultar";

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

class StorageWriteError extends createTaggedError({
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

const selectPlan = (planCode: string): StrictResult<Plan, PlanNotFoundError> => {
  const plan = plans.get(planCode);

  return plan === undefined ? PlanNotFoundError.err({ planCode }) : ok(plan);
};

const chargeCard = (
  cardToken: string,
  amountCents: number,
): StrictResult<Receipt, PaymentDeclinedError> => {
  void amountCents;

  return cardToken === "card_declined"
    ? PaymentDeclinedError.err({ cardToken })
    : ok({ id: `rcpt_${cardToken.slice(-4)}` });
};

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
