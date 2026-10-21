/**
 * Functional Ergonomics, Pattern Matching (`Match`) & Service Injection (`ResultTask.service`)
 *
 * This module demonstrates:
 * - Data-first (`pipe`) and point-free (`flow`, `identity`, `constant`) composition
 * - Lifting nullable values (`Result.fromNullishOr`) and predicates (`Result.liftPredicate`)
 * - Reusable generator functions (`Result.fn`, `ResultTask.fn`)
 * - Rich pattern matching (`Match.value`, `Match.type`, `Match.fn`, `Match.context`,
 *   `Match.valueTags`, `Match.typeTags`, `Match.when`, `Match.whenOr`, `Match.whenAnd`,
 *   `Match.not`, `Match.tag`, `Match.tags`, `Match.discriminator`, `Match.result`, `Match.option`)
 * - Typed dependency injection (`ResultTask.service`, `serviceTag`, `provideService`,
 *   `provideServices`, `provideServiceResolver`)
 */
import {
  constant,
  createTaggedError,
  flow,
  identity,
  isResultTask,
  isServiceTag,
  Match,
  ok,
  pipe,
  Result,
  ResultTask,
  serviceTag,
} from "resultar";

export class UserNotFound extends createTaggedError({
  name: "UserNotFound",
  message: "User $id was not found",
}) {}

/**
 * `.withProps<...>()` attaches typed payload properties to a tagged error class
 * even when those properties are not interpolated in `message`.
 */
export class InvalidRoleError extends createTaggedError({
  name: "InvalidRoleError",
  message: "Role is not permitted",
}).withProps<{ readonly role: string; readonly allowed: readonly string[] }>() {}

/**
 * Define typed service tags for `ResultTask` dependency injection.
 * Both `ResultTask.service<Shape>()(id)` and `serviceTag<Shape, Id>(id)` produce a `ServiceTag`.
 */
export const WorkflowClock = ResultTask.service<{ now(): number }>()("WorkflowClock");
export const TenantPrefix = serviceTag<{ readonly prefix: string }, "TenantPrefix">("TenantPrefix");

/**
 * `flow(fn1, fn2, ...)` composes functions left-to-right into a new reusable function.
 */
export const normalizeUserId = flow(
  (id: string) => id.trim(),
  (id) => id.toLowerCase(),
);

const ALLOWED_ROLES = ["admin", "editor", "viewer"] as const;
type AllowedRole = (typeof ALLOWED_ROLES)[number];

/**
 * `Result.fromNullishOr(onNullish)` creates a reusable function that converts
 * `null | undefined` into `Err` and non-nullish values into `Ok`.
 */
const ensureNonNullRole = Result.fromNullishOr(
  () => new InvalidRoleError({ role: "<empty>", allowed: ALLOWED_ROLES }),
);

/**
 * `Result.liftPredicate(refinement, onFalse)` turns a type guard or boolean
 * predicate into a reusable `Result`-returning validator.
 */
const validateAllowedRole = Result.liftPredicate(
  (role: string): role is AllowedRole => (ALLOWED_ROLES as readonly string[]).includes(role),
  (role) => new InvalidRoleError({ role, allowed: ALLOWED_ROLES }),
);

/**
 * `Result.fn(generatorFn, postProcess?)` wraps a generator workflow into a
 * callable function and optionally transforms the resulting `Result` via `pipe`-style
 * post-processing operators.
 */
export const parseUserRole = Result.fn(
  function* (rawRole: string | null | undefined) {
    const nonNull = yield* ensureNonNullRole(rawRole);
    const normalized = normalizeUserId(nonNull);
    const validRole = yield* validateAllowedRole(normalized);
    return validRole;
  },
  (result) => result.map((role) => `role:${role}` as const),
);

type AccessEvent =
  | { readonly _tag: "Granted"; readonly role: AllowedRole }
  | { readonly _tag: "Denied"; readonly reason: string };

/**
 * `Match.context<Input, ContextArgs>()` compiles a matcher that accepts `(input, ...contextArgs)`
 * and forwards `contextArgs` to every branch handler without repeating the input.
 */
const formatAccessWithContext = Match.context<AccessEvent, [requestId: string]>().pipe(
  Match.tagsExhaustive({
    Granted: (event, requestId) => `[${requestId}] allow:${event.role}`,
    Denied: (event, requestId) => `[${requestId}] deny:${event.reason}`,
  }),
);

/**
 * `ResultTask.fn` creates a parameterized generator workflow that tracks both
 * typed errors (`UserNotFound`) and required services (`WorkflowClock`) in its return type.
 */
export const loadUserLabel = ResultTask.fn(function* (id: string, prefix = "user") {
  const clock = yield* WorkflowClock;
  if (id === "missing") return yield* UserNotFound.taskErr({ id });
  return `${prefix}:${normalizeUserId(id)}:${clock.now()}`;
});

/**
 * Point-free error recovery using `pipe(task, ResultTask.catchTags(...))`.
 */
export const recoverUserLabel = (id: string) =>
  pipe(
    loadUserLabel(id),
    ResultTask.catchTags({
      UserNotFound: (error: UserNotFound) => ResultTask.ok(`guest:${error.id}`),
    }),
  );

/**
 * Runs the core functional ergonomics workflow (`acquireDisposable`, `provideService`,
 * `Result.fn`, `Match.context`, `Match.value`, `identity`, `constant`).
 */
export const runFunctionalErgonomics = async () => {
  const events: string[] = [];
  const program = ResultTask.scoped(
    ResultTask.gen(function* () {
      const session = yield* ResultTask.acquireDisposable(
        ResultTask.sync(() => {
          events.push("open");
          return {
            label: "session",
            [Symbol.asyncDispose]: async () => {
              await Promise.resolve();
              events.push("close");
            },
          };
        }),
      );
      const label = yield* recoverUserLabel("missing");
      return `${session.label}:${label}`;
    }),
  ).provideService(WorkflowClock, { now: () => 42 });
  const first = await program.runPromise();
  const second = await program.runPromise();
  const normalized = await loadUserLabel(" ADA ")
    .provideService(WorkflowClock, { now: () => 42 })
    .runPromise();
  const roleSummary = Result.gen(function* () {
    const admin = yield* parseUserRole(" ADMIN ");
    return admin;
  }).unwrapOr("role:none");
  const invalidRole = parseUserRole("guest").match({
    ok: identity,
    err: (error) => `${error._tag}:${error.role}`,
  });
  const matchedAccess = formatAccessWithContext({ _tag: "Granted", role: "admin" }, "req_1");
  const matchedNumber = Match.value(42 as string | number)
    .when(Match.number, (n) => n * 2)
    .when(Match.string, (s) => s.length)
    .exhaustive();
  return {
    first,
    second,
    normalized,
    events,
    roleSummary,
    invalidRole,
    matchedAccess,
    matchedNumber,
    status: ok<string, UserNotFound>("Ready").match({
      ok: identity,
      err: constant("Unavailable"),
    }),
  };
};

type BillingNotification =
  | { readonly _tag: "InvoicePaid"; readonly cents: number }
  | { readonly _tag: "InvoiceOverdue"; readonly days: number }
  | { readonly _tag: "SubscriptionCancelled"; readonly reason: string };

type HttpOutcome =
  | { readonly kind: "ok"; readonly code: 200; readonly body: string }
  | { readonly kind: "redirect"; readonly code: 301 | 302; readonly location: string }
  | { readonly kind: "error"; readonly code: 500; readonly message: string };

/**
 * Demonstrates advanced `Match` capabilities (`Match.type`, `Match.valueTags`,
 * `Match.typeTags`, `Match.fn`, `Match.tag`, `Match.tags`, `Match.tagStartsWith`,
 * `Match.whenOr`, `Match.whenAnd`, `Match.not`, `Match.discriminator`,
 * `Match.discriminatorsExhaustive`, `Match.result`, `Match.option`) and
 * multi-service injection (`provideServices`, `provideServiceResolver`, `isServiceTag`, `isResultTask`).
 */
export const runAdvancedErgonomics = async () => {
  // 1. Multi-service injection with `provideServices` and lazy `provideServiceResolver`.
  const multiServiceTask = ResultTask.gen(function* () {
    const clock = yield* WorkflowClock;
    const tenant = yield* TenantPrefix;
    return `${tenant.prefix}:t=${clock.now()}`;
  });

  const providedWithMap = await multiServiceTask
    .provideServices({
      TenantPrefix: { prefix: "acme" },
      WorkflowClock: { now: () => 100 },
    })
    .runPromise();

  const providedWithResolver = await multiServiceTask
    .provideServiceResolver({
      TenantPrefix: () => ResultTask.ok({ prefix: "globex" }),
      WorkflowClock: () => ResultTask.sync(() => ({ now: () => 200 })),
    })
    .runPromise();

  // 2. `Match.valueTags` and `Match.typeTags` for concise `_tag` dispatch.
  const paidBanner = Match.valueTags<
    BillingNotification,
    {
      InvoicePaid: (n: Extract<BillingNotification, { _tag: "InvoicePaid" }>) => string;
      InvoiceOverdue: (n: Extract<BillingNotification, { _tag: "InvoiceOverdue" }>) => string;
      SubscriptionCancelled: (
        n: Extract<BillingNotification, { _tag: "SubscriptionCancelled" }>,
      ) => string;
    }
  >(
    { _tag: "InvoicePaid", cents: 2_500 },
    {
      InvoiceOverdue: (n) => `overdue:${n.days}`,
      InvoicePaid: (n) => `paid:${n.cents}`,
      SubscriptionCancelled: (n) => `cancelled:${n.reason}`,
    },
  );

  const classifyBilling = Match.typeTags<BillingNotification, string>()({
    InvoiceOverdue: (n) => `alert:${n.days}d`,
    InvoicePaid: (n) => `ok:${n.cents}`,
    SubscriptionCancelled: (n) => `churn:${n.reason}`,
  });

  // 3. `Match.type` with `tagStartsWith` and `tags` + `orElse`.
  const groupInvoiceEvents = Match.type<BillingNotification>().pipe(
    Match.tagStartsWith("Invoice", (event) => `invoice-group:${event._tag}`),
    Match.orElse((event) => `other:${event._tag}`),
  );

  // 4. Custom discriminant matching (`discriminator` and `discriminatorsExhaustive`) on `kind`.
  const formatHttpOutcome = Match.type<HttpOutcome>().pipe(
    Match.discriminator("kind")("redirect", (res) => `redirect->${res.location}`),
    Match.discriminatorsExhaustive("kind")({
      error: (res) => `err:${res.message}`,
      ok: (res) => `ok:${res.body}`,
    }),
  );

  // 5. `Match.whenOr`, `Match.whenAnd`, `Match.not`, `Match.fn`, `Match.result`, and `Match.option`.
  const scoreCategory = Match.fn((score: number, bonus: number) => score + bonus)
    .whenOr(0, 100, (total) => `boundary:${total}`)
    .whenAnd(
      Match.number,
      (n: number) => n >= 50,
      (total, score, bonus) => `pass:${total}(${score}+${bonus})`,
    )
    .orElse((total) => `fail:${total}`);

  const matchedAsResult = Match.value("admin" as AllowedRole)
    .when(Match.is("admin", "editor"), (role) => `write:${role}`)
    .result();

  const matchedAsOption = Match.value("viewer" as AllowedRole)
    .not("admin", (role) => `non-admin:${role}`)
    .option();

  return {
    billingAlert: classifyBilling({ _tag: "InvoiceOverdue", days: 7 }),
    guards: {
      isClockTag: isServiceTag(WorkflowClock),
      isTask: isResultTask(multiServiceTask),
    },
    http: [
      formatHttpOutcome({ body: "pong", code: 200, kind: "ok" }),
      formatHttpOutcome({ code: 302, kind: "redirect", location: "/login" }),
    ],
    invoiceGroup: [
      groupInvoiceEvents({ _tag: "InvoicePaid", cents: 500 }),
      groupInvoiceEvents({ _tag: "SubscriptionCancelled", reason: "cost" }),
    ],
    matchedAsOption,
    matchedAsResult: matchedAsResult.match({
      err: (unmatched) => `unmatched:${unmatched}`,
      ok: identity,
    }),
    paidBanner,
    providedWithMap,
    providedWithResolver,
    scores: [scoreCategory(100, 0), scoreCategory(40, 20), scoreCategory(10, 5)],
  };
};
