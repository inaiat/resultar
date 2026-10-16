/**
 * Lightweight Tagged Union Cookbook (`tagged-enum.ts`)
 *
 * Demonstrates:
 * - Defining discriminated value unions with `TaggedEnum<...>` and `taggedEnum<...>()`
 * - Constructing frozen `{ readonly _tag, ...props }` variants without `Error` stack overhead
 * - Exhaustively transforming and formatting variants with `.$match(state, handlers)`
 * - Narrowing untrusted `unknown` inputs with `.$is(tag, value)`
 */
import { taggedEnum, type TaggedEnum } from "resultar";

/**
 * Type-level definition of the `PaymentState` discriminated union.
 * Each key becomes a variant with `{ readonly _tag: Key, ...Fields }`.
 */
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

/**
 * Runtime factory exposing variant constructors (`PaymentState.Authorized(...)`, etc.),
 * the `$is(tag, value)` guard, and the exhaustive `$match(value, handlers)` helper.
 * Constructed values are frozen with `Object.freeze`.
 */
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

/** Produces a frozen `PaymentState` variant based on risk score and amount thresholds. */
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

/**
 * Transitions an `Authorized` state to `Settled` while leaving terminal or pending states
 * unchanged using exhaustive `PaymentState.$match`.
 */
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

/** Formats any `PaymentState` into a compact human-readable label via exhaustive `$match`. */
export const paymentStateLabel = (state: PaymentState): string =>
  PaymentState.$match(state, {
    Authorized: (authorized) => `authorized:${authorized.authorizationId}`,
    Declined: (declined) => `declined:${declined.code}`,
    PendingReview: (pending) => `pending:${pending.retryAfterMs}`,
    Settled: (settled) => `settled:${settled.receiptId}`,
  });

/**
 * Safely narrows an arbitrary `unknown` value to the `PendingReview` variant
 * using `PaymentState.$is("PendingReview", input)`.
 */
export const retryAfterMsFromUnknown = (input: unknown): number | undefined =>
  PaymentState.$is("PendingReview", input) ? input.retryAfterMs : undefined;

/** Filters a mixed array of `unknown` values down to `Authorized` payment states. */
export const filterAuthorizedPayments = (
  inputs: readonly unknown[],
): readonly Extract<PaymentState, { readonly _tag: "Authorized" }>[] =>
  inputs.filter((item): item is Extract<PaymentState, { readonly _tag: "Authorized" }> =>
    PaymentState.$is("Authorized", item),
  );
