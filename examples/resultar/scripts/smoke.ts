import { strict as assert } from "node:assert";

import {
  AccountCreateError,
  PaymentState,
  PaymentDeclinedError,
  abortDetectionExamples,
  acknowledgeCheckout,
  acknowledgeCheckoutAsync,
  chooseFulfillment,
  chooseAsyncFulfillment,
  collectLineTotals,
  combineAsyncOrderContext,
  combineOrderContext,
  configErrorLabel,
  configErrorStatus,
  configPortOrDefault,
  createPaidAccount,
  createPaidAccountWithSafeTry,
  decidePaymentState,
  decodeSignupPayload,
  describeProviderReason,
  draftProfileFromCacheMiss,
  enrichBuyerAsync,
  fallbackPriceWithCustomRace,
  fastestPrice,
  fastestRegionalPrice,
  finalCursor,
  firstAvailableProfile,
  firstCompletedPrice,
  importRowsWithCleanup,
  invoiceSchedule,
  loadBundledConfig,
  loadCatalogAfterRetry,
  loadCatalogWithFallback,
  loadConfig,
  loadConfigOrThrow,
  loadDefaultConfig,
  loadUserWithTimeout,
  markCheckoutStarted,
  maybeAudit,
  maybeAuditAfterFlag,
  maybeAsyncAudit,
  maybeAsyncFraudCheck,
  maybeFraudCheck,
  normalizeUnknownError,
  observeAsyncCheckout,
  observeCheckout,
  parseConfig,
  parseConfigWithReusableWrapper,
  profileBoundaryResponse,
  profileWithFallbacks,
  recoverLocalProfile,
  recoverProviderReason,
  recoverRateLimitedProfile,
  requireNonEmptyCart,
  reserveInventory,
  reserveValidatedLine,
  runCookbook,
  saveAuditTrail,
  validateCheckout,
  validateInventory,
  validateOrderLines,
  paymentStateLabel,
  retryAfterMsFromUnknown,
  settlePayment,
  isSignupPasswordRedacted,
  validateSignup,
  zipAsyncOrderIds,
  zipBuyerAndCart,
  type CreatePaidAccountError,
} from "../src/index.js";

const signup = validateSignup({
  acceptedTerms: false,
  email: "invalid",
  password: "short",
});

assert.equal(signup.isErr(), true);

if (signup.isErr()) {
  assert.equal(signup.error.length, 3);
  assert.deepEqual(
    signup.error.map((error) => error._tag),
    ["InvalidEmailError", "WeakPasswordError", "TermsNotAcceptedError"],
  );

  const serializedErrors = JSON.stringify(signup.error);
  assert.match(serializedErrors, /<redacted:password>/);
  assert.doesNotMatch(serializedErrors, /short/);
}

const decodedSignup = decodeSignupPayload({
  acceptedTerms: true,
  email: "ada@example.com",
  password: "correct-horse-battery-staple",
});
assert.equal(decodedSignup.isOk(), true);

const invalidSignupPayload = decodeSignupPayload({ email: 123 });
assert.equal(invalidSignupPayload.isErr(), true);

if (invalidSignupPayload.isErr()) {
  assert.deepEqual(
    invalidSignupPayload.error.map((issue) => issue.path),
    ["email", "password", "acceptedTerms"],
  );
}

assert.equal(
  isSignupPasswordRedacted({
    acceptedTerms: true,
    email: "ada@example.com",
    password: "correct-horse-battery-staple",
  }),
  true,
);

const account = createPaidAccount({
  cardToken: "card_4242",
  email: "ada@example.com",
  planCode: "team",
});

assert.equal(account.isOk(), true);

if (account.isOk()) {
  assert.equal(account.value.planCode, "team");
  assert.equal(account.value.receiptId, "rcpt_4242");
}

const declined = createPaidAccountWithSafeTry({
  cardToken: "card_declined",
  email: "ada@example.com",
  planCode: "team",
});

assert.equal(declined.isErr(), true);

if (declined.isErr()) {
  assert.equal(declined.error instanceof PaymentDeclinedError, true);
}

const storageFailure = createPaidAccount({
  cardToken: "card_4242",
  email: "ada@blocked.example",
  planCode: "team",
});

assert.equal(storageFailure.isErr(), true);

if (storageFailure.isErr()) {
  const error: CreatePaidAccountError = storageFailure.error;
  assert.equal(error instanceof AccountCreateError, true);
  assert.equal(error.cause instanceof Error, true);
}

const parsedConfig = parseConfig('{"port":8080,"mode":"prod"}');
assert.equal(parsedConfig.isOk(), true);

if (parsedConfig.isOk()) {
  assert.equal(parsedConfig.value.port, 8080);
}

const parsedWithWrapper = parseConfigWithReusableWrapper('{"port":3001,"mode":"dev"}');
assert.equal(parsedWithWrapper.isOk(), true);

const badJsonConfig = parseConfig("{");
assert.equal(badJsonConfig.isErr(), true);

if (badJsonConfig.isErr()) {
  assert.equal(configErrorLabel(badJsonConfig.error), "parse");
  assert.equal(configErrorStatus(badJsonConfig.error), 400);
}

const missingConfig = await loadConfig("missing");
assert.equal(missingConfig.isErr(), true);

if (missingConfig.isErr()) {
  assert.equal(configErrorLabel(missingConfig.error), "read:missing");
  assert.equal(configErrorStatus(missingConfig.error), 503);
}

const bundledConfig = await loadBundledConfig("memory");
assert.equal(bundledConfig.isOk(), true);

const defaultConfig = await loadDefaultConfig();
assert.equal(defaultConfig.isOk(), true);

if (defaultConfig.isOk()) {
  assert.equal(defaultConfig.value.mode, "dev");
}

assert.equal(configPortOrDefault("{"), 3000);
assert.equal((await loadConfigOrThrow("memory")).port, 8080);
assert.equal(normalizeUnknownError(new Error("boom")), "boom");
assert.equal(normalizeUnknownError("boom"), "not-an-error");

const draftProfile = draftProfileFromCacheMiss("new-user");
assert.equal(draftProfile.isOk(), true);

if (draftProfile.isOk()) {
  assert.equal(draftProfile.value.source, "draft");
}

const recoveredLocalProfile = recoverLocalProfile("missing");
assert.equal(recoveredLocalProfile.isOk(), true);

if (recoveredLocalProfile.isOk()) {
  assert.equal(recoveredLocalProfile.value.source, "empty");
}

const fallbackProfile = profileWithFallbacks("new-user");
assert.equal(fallbackProfile.isOk(), true);

if (fallbackProfile.isOk()) {
  assert.equal(fallbackProfile.value.source, "primary");
}

const firstProfile = firstAvailableProfile("new-user");
assert.equal(firstProfile.isOk(), true);

if (firstProfile.isOk()) {
  assert.equal(firstProfile.value.source, "primary");
}

const rateLimitedProfile = recoverRateLimitedProfile("rate-limited");
assert.equal(rateLimitedProfile.isOk(), true);

if (rateLimitedProfile.isOk()) {
  assert.equal(rateLimitedProfile.value.source, "retry");
}

const quotaProfile = recoverProviderReason("quota");
assert.equal(quotaProfile.isOk(), true);

if (quotaProfile.isOk()) {
  assert.equal(quotaProfile.value.name, "Quota 10");
}

assert.equal(describeProviderReason("quota"), "quota:10");
assert.equal(describeProviderReason("rate-limited"), "rate:1000");
assert.equal(profileBoundaryResponse("missing").statusCode, 404);
assert.equal(profileBoundaryResponse("quota").statusCode, 502);

const pendingPayment = decidePaymentState(1_900, 95);
assert.equal(pendingPayment._tag, "PendingReview");
assert.equal(Object.isFrozen(pendingPayment), true);
assert.equal(PaymentState.$is("PendingReview", pendingPayment), true);
assert.equal(retryAfterMsFromUnknown(pendingPayment), 60_000);
assert.equal(paymentStateLabel(pendingPayment), "pending:60000");

const settledPayment = settlePayment(decidePaymentState(1_900, 10));
assert.equal(settledPayment._tag, "Settled");
assert.equal(paymentStateLabel(settledPayment), "settled:rcpt_1900");

const declinedPayment = decidePaymentState(60_000, 10);
assert.equal(PaymentState.$is("Declined", declinedPayment), true);
assert.equal(paymentStateLabel(declinedPayment), "declined:limit_exceeded");

const orderLines = [
  { quantity: 2, sku: "book", unitCents: 1_000 },
  { quantity: 1, sku: "pen", unitCents: 200 },
] as const;

assert.equal(requireNonEmptyCart([]).isErr(), true);

const nonEmptyCart = requireNonEmptyCart(orderLines);
assert.equal(nonEmptyCart.isOk(), true);

const checkoutStarted = markCheckoutStarted();
assert.equal(checkoutStarted.isOk(), true);

if (checkoutStarted.isOk()) {
  assert.equal(checkoutStarted.value.status, "started");
}

const acknowledged = acknowledgeCheckout();
assert.equal(acknowledged.isOk(), true);

if (acknowledged.isOk()) {
  assert.equal(acknowledged.value, undefined);
}

const asyncAcknowledged = await acknowledgeCheckoutAsync();
assert.equal(asyncAcknowledged.isOk(), true);

if (asyncAcknowledged.isOk()) {
  assert.equal(asyncAcknowledged.value, undefined);
}

const enrichedBuyer = await enrichBuyerAsync("buyer_1");
assert.equal(enrichedBuyer.isOk(), true);

if (enrichedBuyer.isOk()) {
  assert.equal(enrichedBuyer.value.tier, "gold");
}

const reservedValidatedLine = await reserveValidatedLine(orderLines[0]);
assert.equal(reservedValidatedLine.isOk(), true);

if (reservedValidatedLine.isOk()) {
  assert.equal(reservedValidatedLine.value.sku, "book");
}

const zippedOrder = zipBuyerAndCart();
assert.equal(zippedOrder.isOk(), true);

if (zippedOrder.isOk()) {
  assert.equal(zippedOrder.value[0], "buyer_1");
}

const orderContext = combineOrderContext("SAVE10");
assert.equal(orderContext.isOk(), true);

if (orderContext.isOk()) {
  assert.equal(orderContext.value.coupon.discountCents, 1_000);
}

const validLines = validateOrderLines(orderLines);
assert.equal(validLines.isOk(), true);

if (validLines.isOk()) {
  assert.equal(validLines.value.length, 2);
}

assert.equal(validateCheckout([{ quantity: 0, sku: "bad", unitCents: 1 }], "NOPE").isErr(), true);

const totals = collectLineTotals(orderLines);
assert.equal(totals.isOk(), true);

if (totals.isOk()) {
  assert.deepEqual(
    totals.value.map((line) => line.totalCents),
    [2_000, 200],
  );
}

const schedule = invoiceSchedule();
assert.equal(schedule.isOk(), true);

if (schedule.isOk()) {
  assert.deepEqual(schedule.value, ["invoice:1", "invoice:2", "invoice:3"]);
}

const cursor = finalCursor();
assert.equal(cursor.isOk(), true);

if (cursor.isOk()) {
  assert.equal(cursor.value, 3);
}

const fulfillment = chooseFulfillment(true);
assert.equal(fulfillment.isOk(), true);

if (fulfillment.isOk()) {
  assert.equal(fulfillment.value.mode, "express");
}

const auditEnabled = maybeAudit(true);
assert.equal(auditEnabled.isOk(), true);

if (auditEnabled.isOk()) {
  assert.equal(auditEnabled.value, "audit-written");
}

const auditSkipped = maybeAudit(false);
assert.equal(auditSkipped.isOk(), true);

if (auditSkipped.isOk()) {
  assert.equal(auditSkipped.value, undefined);
}

const auditAfterFlag = maybeAuditAfterFlag(true);
assert.equal(auditAfterFlag.isOk(), true);

if (auditAfterFlag.isOk()) {
  assert.equal(auditAfterFlag.value, "audit-from-result");
}

const fraudSkipped = maybeFraudCheck(true);
assert.equal(fraudSkipped.isOk(), true);

if (fraudSkipped.isOk()) {
  assert.equal(fraudSkipped.value, undefined);
}

const asyncFulfillment = await chooseAsyncFulfillment(false);
assert.equal(asyncFulfillment.isOk(), true);

if (asyncFulfillment.isOk()) {
  assert.equal(asyncFulfillment.value.mode, "standard");
}

const asyncAuditSkipped = await maybeAsyncAudit(false);
assert.equal(asyncAuditSkipped.isOk(), true);

if (asyncAuditSkipped.isOk()) {
  assert.equal(asyncAuditSkipped.value, undefined);
}

const asyncFraudCheck = await maybeAsyncFraudCheck(false);
assert.equal(asyncFraudCheck.isOk(), true);

if (asyncFraudCheck.isOk()) {
  assert.equal(asyncFraudCheck.value, "async-fraud-check");
}

const inventory = await reserveInventory(orderLines);
assert.equal(inventory.isOk(), true);

if (inventory.isOk()) {
  assert.equal(inventory.value.length, 2);
}

const inventoryValidation = await validateInventory([
  ...orderLines,
  { quantity: 1, sku: "missing", unitCents: 500 },
]);
assert.equal(inventoryValidation.isErr(), true);

const auditSaved = await saveAuditTrail(["created", "paid"]);
assert.equal(auditSaved.isOk(), true);

const auditFailed = await saveAuditTrail(["created", "bad"]);
assert.equal(auditFailed.isErr(), true);

const asyncOrderContext = await combineAsyncOrderContext();
assert.equal(asyncOrderContext.isOk(), true);

if (asyncOrderContext.isOk()) {
  assert.equal(asyncOrderContext.value.payment, "authorized");
}

const asyncOrderIds = await zipAsyncOrderIds();
assert.equal(asyncOrderIds.isOk(), true);

if (asyncOrderIds.isOk()) {
  assert.deepEqual(asyncOrderIds.value, ["order_1", "receipt_1"]);
}

assert.deepEqual(observeCheckout(), [
  "tap:order_1",
  "log:order_1",
  "dispose:order_1",
  "tapError:AuditWriteError",
  "log:AuditWriteError",
  "dispose:AuditWriteError",
]);
assert.deepEqual(await observeAsyncCheckout(), [
  "tap:async_order",
  "log:async_order",
  "dispose:async_order",
]);

const quickUser = await loadUserWithTimeout("usr_123", 1);
assert.equal(quickUser.isOk(), true);

const slowUser = await loadUserWithTimeout("usr_123", 20);
assert.equal(slowUser.isErr(), true);

if (slowUser.isErr()) {
  assert.equal(slowUser.error._tag, "UserTimeoutError");
}

const catalog = await loadCatalogWithFallback("sku_123");
assert.equal(catalog.isOk(), true);

if (catalog.isOk()) {
  assert.equal(catalog.value.source, "cache");
}

const retriedCatalog = await loadCatalogAfterRetry("sku_123");
assert.equal(retriedCatalog.isOk(), true);

if (retriedCatalog.isOk()) {
  assert.equal(retriedCatalog.value.source, "primary");
}

const price = await fastestPrice("sku_123");
assert.equal(price.isOk(), true);

if (price.isOk()) {
  assert.equal(price.value.region, "eu-west");
}

const regionalPrice = await fastestRegionalPrice("sku_123");
assert.equal(regionalPrice.isOk(), true);

if (regionalPrice.isOk()) {
  assert.equal(regionalPrice.value.region, "replica");
}

const firstPrice = await firstCompletedPrice("sku_123");
assert.equal(firstPrice.isErr(), true);

if (firstPrice.isErr()) {
  assert.equal(firstPrice.error._tag, "PriceProviderError");
}

const customRacePrice = await fallbackPriceWithCustomRace("sku_123");
assert.equal(customRacePrice.isOk(), true);

if (customRacePrice.isOk()) {
  assert.equal(customRacePrice.value.region, "fallback");
}

assert.deepEqual(abortDetectionExamples(), {
  code: true,
  instance: true,
  name: true,
});

const importOk = await importRowsWithCleanup(["one", "two"]);
assert.equal(importOk.result.isOk(), true);
assert.deepEqual(importOk.events, ["acquire", "warehouse-1:use", "warehouse-1:release:close"]);

const importFailed = await importRowsWithCleanup(["one", "two"], { failAtRow: 2 });
assert.equal(importFailed.result.isErr(), true);
assert.deepEqual(importFailed.events, [
  "acquire",
  "warehouse-1:use",
  "warehouse-1:release:rollback",
]);

const summary = await runCookbook();
assert.equal(summary.signup.statusCode, 201);
assert.equal(summary.account.statusCode, 201);
assert.equal(summary.payment.label, "settled:rcpt_1900");

process.stdout.write("Resultar cookbook example smoke passed.\n");
