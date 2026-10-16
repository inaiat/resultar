import { strict as assert } from "node:assert";

import {
  AccountCreateError,
  PaymentState,
  PaymentDeclinedError,
  StorageWriteError,
  abortDetectionExamples,
  acknowledgeCheckout,
  acknowledgeCheckoutAsync,
  allAsyncOrderChecks,
  allOrderChecks,
  asyncFinalCursor,
  asyncInvoiceSchedule,
  chooseFulfillment,
  chooseAsyncFulfillment,
  clearCartSnapshot,
  collectLineTotals,
  combineAsyncOrderContext,
  combineOrderContext,
  configErrorLabel,
  configErrorStatus,
  configPortOrDefault,
  createPaidAccount,
  createPaidAccountAsyncWithGen,
  createPaidAccountWithGen,
  createPaidAccountWithSafeTry,
  decidePaymentState,
  decodeSignupPayload,
  describeProviderReason,
  draftProfileFromCacheMiss,
  enrichBuyerAsync,
  fallbackPriceWithCustomRace,
  fastestPrice,
  fastestRegionalPrice,
  filterAuthorizedPayments,
  finalCursor,
  findStorageCause,
  firstAvailableProfile,
  firstAvailableWarehouse,
  firstCompletedPrice,
  guaranteedProfile,
  importRowsWithCleanup,
  importRowsWithFallibleRelease,
  inspectCheckoutEvents,
  invoiceSchedule,
  isEmailValidationFailure,
  loadBundledConfig,
  loadCatalogAfterRetry,
  loadCatalogWithFallback,
  loadCatalogWithRetryPolicy,
  loadConfig,
  loadConfigOrThrow,
  loadConfigPortPromise,
  loadDefaultConfig,
  loadUserWithTimeout,
  markCheckoutStarted,
  maybeAudit,
  maybeAuditAfterFlag,
  maybeAsyncAudit,
  maybeAsyncAuditAfterFlag,
  maybeAsyncFraudCheck,
  maybeAsyncFraudCheckAfterFlag,
  maybeFraudCheck,
  maybeFraudCheckAfterFlag,
  normalizeUnknownError,
  observeAsyncCheckout,
  observeCheckout,
  parseConfig,
  parseConfigPortSync,
  parseConfigWithReusableWrapper,
  profileBoundaryResponse,
  profileWithFallbacks,
  recoverLocalProfile,
  recoverProviderReason,
  recoverRateLimitedProfile,
  requireNonEmptyCart,
  reserveInventory,
  reserveValidatedLine,
  runAdvancedErgonomics,
  runAdvancedTaskResilience,
  runCookbook,
  runTaskControlFlow,
  runTaskResilience,
  saveAuditTrail,
  validateAsyncCheckout,
  validateCheckout,
  validateInventory,
  validateOrderLines,
  waitForConfigEvent,
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
  assert.equal(isEmailValidationFailure(signup.error[0]), true);
  assert.equal(isEmailValidationFailure(signup.error[1]), false);

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

const accountFromGen = createPaidAccountWithGen({
  cardToken: "card_4242",
  email: "ada@example.com",
  planCode: "enterprise",
});
assert.equal(accountFromGen.isOk(), true);

const accountFromAsyncGen = await createPaidAccountAsyncWithGen({
  cardToken: "card_4242",
  email: "ada@example.com",
  planCode: "team",
});
assert.equal(accountFromAsyncGen.isOk(), true);

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
  const rootStorageError = findStorageCause(error);
  assert.equal(rootStorageError instanceof StorageWriteError, true);
  assert.equal(rootStorageError?.email, "ada@blocked.example");
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

const callbackEvents: string[] = [];
const callbackConfig = await waitForConfigEvent("ready", callbackEvents);
assert.equal(callbackConfig.isOk(), true);
assert.deepEqual(callbackEvents, ["subscribe:ready", "cleanup:ready"]);

const brokenCallbackEvents: string[] = [];
const brokenCallbackConfig = await waitForConfigEvent("broken", brokenCallbackEvents);
assert.equal(brokenCallbackConfig.isErr(), true);
assert.deepEqual(brokenCallbackEvents, ["subscribe:broken", "cleanup:broken"]);

assert.equal(configPortOrDefault("{"), 3000);
assert.equal(parseConfigPortSync('{"port":9000,"mode":"dev"}'), 9000);
assert.equal(await loadConfigPortPromise("memory"), 8080);
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

const guaranteed = guaranteedProfile("missing-cache-key");
assert.equal(guaranteed.isOk(), true);
if (guaranteed.isOk()) {
  assert.equal(guaranteed.value.source, "empty");
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

const authorizedPayment = decidePaymentState(1_900, 10);
const settledPayment = settlePayment(authorizedPayment);
assert.equal(settledPayment._tag, "Settled");
assert.equal(paymentStateLabel(settledPayment), "settled:rcpt_1900");

const declinedPayment = decidePaymentState(60_000, 10);
assert.equal(PaymentState.$is("Declined", declinedPayment), true);
assert.equal(paymentStateLabel(declinedPayment), "declined:limit_exceeded");
assert.equal(
  filterAuthorizedPayments([pendingPayment, authorizedPayment, settledPayment, declinedPayment])
    .length,
  1,
);

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

const clearedCart = clearCartSnapshot();
assert.equal(clearedCart.isOk(), true);
if (clearedCart.isOk()) {
  assert.equal(clearedCart.value, undefined);
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

const allSyncOrder = allOrderChecks("SAVE10");
assert.equal(allSyncOrder.isOk(), true);

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

const fraudAfterFlag = maybeFraudCheckAfterFlag(false);
assert.equal(fraudAfterFlag.isOk(), true);
if (fraudAfterFlag.isOk()) {
  assert.equal(fraudAfterFlag.value, "fraud-check-from-result");
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

const asyncAuditAfterFlag = await maybeAsyncAuditAfterFlag(true);
assert.equal(asyncAuditAfterFlag.isOk(), true);
if (asyncAuditAfterFlag.isOk()) {
  assert.equal(asyncAuditAfterFlag.value, "async-audit-from-result");
}

const asyncFraudCheck = await maybeAsyncFraudCheck(false);
assert.equal(asyncFraudCheck.isOk(), true);

if (asyncFraudCheck.isOk()) {
  assert.equal(asyncFraudCheck.value, "async-fraud-check");
}

const asyncFraudAfterFlag = await maybeAsyncFraudCheckAfterFlag(false);
assert.equal(asyncFraudAfterFlag.isOk(), true);
if (asyncFraudAfterFlag.isOk()) {
  assert.equal(asyncFraudAfterFlag.value, "async-fraud-from-result");
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

const allAsyncChecks = await allAsyncOrderChecks();
assert.equal(allAsyncChecks.isOk(), true);

const invalidAsyncCheckout = await validateAsyncCheckout(
  [{ quantity: 1, sku: "missing", unitCents: 100 }],
  "NOPE",
);
assert.equal(invalidAsyncCheckout.isErr(), true);
if (invalidAsyncCheckout.isErr()) {
  assert.equal(invalidAsyncCheckout.error.length, 2);
}

const warehouse = await firstAvailableWarehouse("sku_book");
assert.equal(warehouse.isOk(), true);
if (warehouse.isOk()) {
  assert.equal(warehouse.value.position, 1);
}

const asyncSchedule = await asyncInvoiceSchedule();
assert.equal(asyncSchedule.isOk(), true);
if (asyncSchedule.isOk()) {
  assert.deepEqual(asyncSchedule.value, [
    "async-invoice:1",
    "async-invoice:2",
    "async-invoice:3",
  ]);
}

const asyncCursor = await asyncFinalCursor();
assert.equal(asyncCursor.isOk(), true);
if (asyncCursor.isOk()) {
  assert.equal(asyncCursor.value, 3);
}

const asyncOrderIds = await zipAsyncOrderIds();
assert.equal(asyncOrderIds.isOk(), true);

if (asyncOrderIds.isOk()) {
  assert.deepEqual(asyncOrderIds.value, ["order_1", "receipt_1"]);
}

assert.deepEqual(await inspectCheckoutEvents(), [
  "inspect:order_inspect",
  "bothOk:order_inspect",
  "asyncInspectError:AuditWriteError",
  "asyncBothErr:AuditWriteError",
]);

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

assert.deepEqual(await runTaskControlFlow(), {
  branch: "express",
  delayedValue: "ready",
  elapsedMs: 5,
  fallback: "warehouse:backup",
  iterated: 4,
  looped: ["step:1", "step:2"],
  unlessValue: undefined,
  whenValue: "audited",
  zipped: ["left", "right"],
});

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

const policyCatalog = await loadCatalogWithRetryPolicy("sku_123");
assert.equal(policyCatalog.attempts, 3);
assert.equal(policyCatalog.result.isOk(), true);
assert.deepEqual(policyCatalog.retryLog, [
  "retry:0:CatalogUnavailableError",
  "retry:1:CatalogUnavailableError",
]);

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

const importReleaseFailed = await importRowsWithFallibleRelease(true);
assert.equal(importReleaseFailed.result.isOk(), true);
assert.deepEqual(importReleaseFailed.result.unwrapOr({ imported: -1 }), { imported: 1 });
assert.deepEqual(importReleaseFailed.events, [
  "acquire",
  "warehouse-2:use",
  "warehouse-2:release",
]);

const summary = await runCookbook();
const resilience = await runTaskResilience();
assert.deepEqual(resilience, {
  retry: {
    attempts: 3,
    elapsedMs: 15,
    events: ["open:1", "close:1", "open:2", "close:2", "open:3", "close:3"],
    value: "ready",
  },
  batch: {
    maxConcurrency: 2,
    record: { count: 3, status: "complete" },
    values: [2, 4, 6],
  },
  timeout: { events: ["close:connection"], tag: "TaskDeadlineError" },
  race: { events: ["close:fast", "close:slow"], winner: "fast" },
  fiber: { _tag: "Success", value: "observed" },
  rootFiber: {
    wasRunning: true,
    events: ["Success"],
    exit: { _tag: "Success", value: "background ready" },
  },
  semaphore: {
    events: ["enter", "exit", "enter", "exit"],
    values: ["permit-ok", "permit-ok"],
  },
  sandbox: {
    cleanup: ["ensured"],
    value: "recovered:TaskProviderError:9",
  },
  validation: ["TaskProviderError:2"],
  pendingTimers: 0,
});
assert.deepEqual(summary.resilience, resilience);
assert.deepEqual(summary.ergonomics, {
  first: "session:guest:missing",
  second: "session:guest:missing",
  normalized: "user:ada:42",
  events: ["open", "close", "open", "close"],
  roleSummary: "role:admin",
  invalidRole: "InvalidRoleError:guest",
  matchedAccess: "[req_1] allow:admin",
  matchedNumber: 84,
  status: "Ready",
});

const advancedErgonomics = await runAdvancedErgonomics();
assert.deepEqual(advancedErgonomics, {
  billingAlert: "alert:7d",
  guards: {
    isClockTag: true,
    isTask: true,
  },
  http: ["ok:pong", "redirect->/login"],
  invoiceGroup: ["invoice-group:InvoicePaid", "other:SubscriptionCancelled"],
  matchedAsOption: { _tag: "Some", value: "non-admin:viewer" },
  matchedAsResult: "write:admin",
  paidBanner: "paid:2500",
  providedWithMap: "acme:t=100",
  providedWithResolver: "globex:t=200",
  scores: ["boundary:100", "pass:60(40+20)", "fail:15"],
});

const advancedResilience = await runAdvancedTaskResilience();
assert.deepEqual(advancedResilience, {
  awaitedDirectly: "direct-await",
  bridgedAsync: "bridged-async",
  causeDiagnostics: {
    defects: ["unexpected-defect"],
    failures: ["TaskProviderError"],
    hasDies: true,
    hasFails: true,
    hasInterrupts: false,
    isCause: true,
    prettyIncludesFail: true,
  },
  causeEvents: ["inspectCause:true"],
  fiberResult: {
    interruptedTag: "Failure",
    joined: "joined-value",
  },
  lifecycleEvents: ["fiberWorkflow:Success"],
  multiPermitValue: "two-permits-acquired",
  raceOkWinner: "backup-winner",
  recoveredFromCause: "caught:4",
  schedulerYields: 3,
  yieldedValue: "step-1->after-yield",
});

assert.equal(summary.signup.statusCode, 201);
assert.equal(summary.account.statusCode, 201);
assert.equal(summary.payment.label, "settled:rcpt_1900");

process.stdout.write("Resultar cookbook example smoke passed.\n");
