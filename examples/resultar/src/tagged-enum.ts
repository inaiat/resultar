import { taggedEnum, type TaggedEnum } from "resultar";

export type PaymentState = TaggedEnum<{
  Authorized: {
    readonly authorizationId: string;
    readonly cents: number;
  };
  Declined: {
    readonly code: string;
  };
  PendingReview: {
    readonly retryAfterMs: number;
  };
  Settled: {
    readonly receiptId: string;
  };
}>;

export const PaymentState = taggedEnum<{
  Authorized: {
    readonly authorizationId: string;
    readonly cents: number;
  };
  Declined: {
    readonly code: string;
  };
  PendingReview: {
    readonly retryAfterMs: number;
  };
  Settled: {
    readonly receiptId: string;
  };
}>();

export const decidePaymentState = (amountCents: number, riskScore: number): PaymentState => {
  if (riskScore >= 80) {
    return PaymentState.PendingReview({ retryAfterMs: 60_000 });
  }

  if (amountCents > 50_000) {
    return PaymentState.Declined({ code: "limit_exceeded" });
  }

  return PaymentState.Authorized({
    authorizationId: `auth_${amountCents}`,
    cents: amountCents,
  });
};

export const settlePayment = (state: PaymentState): PaymentState =>
  PaymentState.$match<PaymentState>(state, {
    Authorized: (authorized) =>
      PaymentState.Settled({
        receiptId: authorized.authorizationId.replace("auth", "rcpt"),
      }),
    Declined: (declined) => declined,
    PendingReview: (pending) => pending,
    Settled: (settled) => settled,
  });

export const paymentStateLabel = (state: PaymentState): string =>
  PaymentState.$match(state, {
    Authorized: (authorized) => `authorized:${authorized.authorizationId}`,
    Declined: (declined) => `declined:${declined.code}`,
    PendingReview: (pending) => `pending:${pending.retryAfterMs}`,
    Settled: (settled) => `settled:${settled.receiptId}`,
  });

export const retryAfterMsFromUnknown = (input: unknown): number | undefined =>
  PaymentState.$is("PendingReview", input) ? input.retryAfterMs : undefined;
