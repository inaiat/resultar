import { pathToFileURL } from "node:url";

export * from "./async-resilience.js";
export * from "./collections-and-control-flow.js";
export * from "./domain-workflow.js";
export * from "./edge-wrapping.js";
export * from "./resource-cleanup.js";
export * from "./recovery-and-fallbacks.js";
export * from "./sync-validation.js";
export * from "./tagged-enum.js";

import { fastestPrice, loadCatalogWithFallback, loadUserWithTimeout } from "./async-resilience.js";
import { createPaidAccountResponse } from "./domain-workflow.js";
import { importRowsWithCleanup } from "./resource-cleanup.js";
import { createSignupResponse } from "./sync-validation.js";
import { decidePaymentState, paymentStateLabel, settlePayment } from "./tagged-enum.js";

const errorCode = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    return String(error._tag);
  }

  return error instanceof Error ? error.name : "UnknownError";
};

export const runCookbook = async () => {
  const user = await loadUserWithTimeout("usr_123", 1);
  const catalog = await loadCatalogWithFallback("sku_123");
  const price = await fastestPrice("sku_123");
  const imported = await importRowsWithCleanup(["one", "two"]);
  const payment = settlePayment(decidePaymentState(1_900, 10));

  return {
    account: createPaidAccountResponse({
      cardToken: "card_4242",
      email: "ada@example.com",
      planCode: "team",
    }),
    catalog: catalog.match(
      (value) => value,
      (error) => ({ code: errorCode(error) }),
    ),
    imported: imported.result.match(
      (value) => value,
      (error) => ({ code: errorCode(error) }),
    ),
    price: price.match(
      (value) => value,
      (error) => ({ code: errorCode(error) }),
    ),
    payment: {
      label: paymentStateLabel(payment),
      state: payment,
    },
    signup: createSignupResponse({
      acceptedTerms: true,
      email: "ADA@example.com",
      password: "correct-horse-battery-staple",
    }),
    user: user.match(
      (value) => value,
      (error) => ({ code: errorCode(error) }),
    ),
  };
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const summary = await runCookbook();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
