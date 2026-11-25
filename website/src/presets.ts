export interface PlaygroundPreset {
  readonly id: string;
  readonly title: string;
  readonly badge: string;
  readonly description: string;
  readonly code: string;
}

export const PLAYGROUND_PRESETS: readonly PlaygroundPreset[] = [
  {
    id: "result-errors",
    title: "Tagged Errors & Result.gen",
    badge: "Core",
    description:
      "Real Error subclasses with $var interpolation, secret redaction, and exhaustive matching.",
    code: `import { createTaggedError, ok, redact, Result } from "resultar";

class InvalidAmountError extends createTaggedError({
  name: "InvalidAmountError",
  message: "Amount $amount must be positive",
}).withProps<{ readonly amount: number }>() {}

class TokenRejectedError extends createTaggedError({
  name: "TokenRejectedError",
  message: "Token $token rejected for tenant $tenantId",
}) {}

const validateAmount = (amount: number) =>
  amount > 0 ? ok(amount) : InvalidAmountError.err({ amount });

const authorize = (token: string, tenantId: string) =>
  token.startsWith("live_")
    ? ok(tenantId)
    : TokenRejectedError.err({ token: redact(token, "apiKey"), tenantId });

const checkout = (amount: number, token: string) =>
  Result.gen(function* () {
    const validAmount = yield* validateAmount(amount);
    const tenant = yield* authorize(token, "acme");
    return { tenant, charged: validAmount };
  });

const failed = checkout(150, "bad_secret_123");
if (failed.isErr()) {
  console.log("Message:", failed.error.message);
  console.log("Fingerprint:", failed.error.fingerprint);
}

const status = checkout(150, "live_ok").matchTags(
  (receipt) => ({ status: 200, receipt }),
  {
    InvalidAmountError: (err) => ({ status: 400, error: err.message }),
    TokenRejectedError: (err) => ({ status: 401, error: err.message }),
  },
);
console.log("HTTP response:", status);
`,
  },
  {
    id: "task-di",
    title: "Lazy ResultTask + Services",
    badge: "Tasks & DI",
    description: "Typed dependency requirements (R), linear ResultTask.fn, and service injection.",
    code: `import { createTaggedError, ResultTask, serviceTag } from "resultar";

class UserNotFoundError extends createTaggedError({
  name: "UserNotFoundError",
  message: "User $id was not found",
}) {}

interface UserRepo {
  readonly findById: (id: string) => ResultTask<{ readonly id: string; readonly name: string }, UserNotFoundError>;
}
const UserRepo = serviceTag<UserRepo>("UserRepo");

const greetUser = ResultTask.fn(function* (id: string) {
  const repo = yield* UserRepo;
  const user = yield* repo.findById(id);
  return \`Hello, \${user.name}!\`;
});

const repoImpl: UserRepo = {
  findById: (id) =>
    id === "1"
      ? ResultTask.ok({ id, name: "Ada Lovelace" })
      : UserNotFoundError.taskErr({ id }),
};

const found = await greetUser("1").provideService(UserRepo, repoImpl).runResult();
const missing = await greetUser("99").provideService(UserRepo, repoImpl).runResult();

console.log("Found:", found);
console.log("Missing:", missing);
`,
  },
  {
    id: "retry-virtual-clock",
    title: "Retry + Clock.virtual()",
    badge: "Resilience",
    description:
      "Error-aware backoff with maxDelayMs/maxElapsedMs tested instantaneously via VirtualClock.",
    code: `import { Clock, createTaggedError, ResultTask, Retry } from "resultar";

class RateLimitError extends createTaggedError({
  name: "RateLimitError",
  message: "Rate limited; retry after $retryAfterMs ms",
}).withProps<{ readonly retryAfterMs: number }>() {}

let attempts = 0;
const fetchPrice = ResultTask.suspend(() => {
  attempts += 1;
  if (attempts < 4) {
    return RateLimitError.taskErr({ retryAfterMs: attempts * 250 });
  }
  return ResultTask.ok({ symbol: "BTC", price: 95_000, attempts });
});

const policy = Retry.policy<RateLimitError>({
  times: 5,
  delayMs: (_ctx, err) => err.retryAfterMs,
  maxDelayMs: 600,
  maxElapsedMs: 5_000,
  onRetry: (err, ctx) => {
    console.log(\`Retry #\${ctx.attempt}: \${err.message}\`);
  },
});

const clock = Clock.virtual();
const exit = await clock.runToCompletion(fetchPrice.retry(policy));
console.log("Virtual elapsed ms:", clock.now());
console.log("Exit:", exit);
`,
  },
  {
    id: "concurrency",
    title: "Ref, Deferred & Queue",
    badge: "Concurrency",
    description: "Bounded FIFO backpressure, fiber coordination, and lossless shutdown draining.",
    code: `import { Deferred, Queue, Ref, ResultTask } from "resultar";

const processed = Ref.make<readonly string[]>([]);
const queue = Queue.bounded<string>(2);
const done = Deferred.make<number>();

const workflow = ResultTask.gen(function* () {
  const consumer = yield* ResultTask.gen(function* () {
    for (let i = 0; i < 4; i += 1) {
      const item = yield* queue.take();
      yield* processed.update((list) => [...list, item.toUpperCase()]);
    }
    const items = yield* processed.get();
    yield* done.succeed(items.length);
  }).forkChild();

  yield* queue.offerAll(["alpha", "beta", "gamma", "delta"]);
  const total = yield* done.await();
  yield* queue.shutdown();
  yield* consumer.join();

  return { total, items: yield* processed.get() };
}).scoped();

const result = await workflow.runPromise();
console.log("Pipeline result:", result);
`,
  },
  {
    id: "observability",
    title: "TaskLocal, Tracer & Spans",
    badge: "Observability",
    description:
      "Zero-overhead opt-in spans, fiber-inherited TaskLocal, and span traces in Cause.pretty.",
    code: `import { Cause, Clock, createTaggedError, ResultTask, TaskLocal, Tracer } from "resultar";

class DbError extends createTaggedError({
  name: "DbError",
  message: "Query failed on table $table",
}) {}

const RequestId = TaskLocal.make("anonymous", "requestId");

const loadProfile = ResultTask.fn("http.getProfile", function* (userId: string) {
  const reqId = yield* RequestId.get();
  const user = yield* ResultTask.sleep(15)
    .as({ id: userId, name: "Grace Hopper" })
    .withSpan("db.findUser", { "user.id": userId, "request.id": reqId });

  const perms = yield* ResultTask.sleep(10)
    .as(["read", "deploy"])
    .withSpan("cache.loadPermissions", { "user.id": userId });

  return { user, perms, reqId };
});

const tracer = Tracer.memory();
const clock = Clock.virtual();
const okExit = await clock.runToCompletion(
  RequestId.locally("req-9001", loadProfile("u-42")),
);
// Run with tracer attached to capture full span hierarchy:
const tracedExit = await RequestId.locally("req-9001", loadProfile("u-42")).runExit({
  tracer,
});

console.log("Result:", tracedExit);
console.log("Recorded spans:", tracer.spans);

// Even WITHOUT an external tracer, failure Causes retain logical Span traces:
const failedExit = await DbError.taskErr({ table: "orders" })
  .withSpan("db.insertOrder", { orderId: "ord-7" })
  .withSpan("checkout.submit")
  .runExit();

if (failedExit._tag === "Failure") {
  console.log("Failure Cause.pretty():\\n" + Cause.pretty(failedExit.cause));
}
`,
  },
  {
    id: "match-enum",
    title: "Match & taggedEnum",
    badge: "Matching",
    description: "Exhaustive discriminated union matching with predicates and zero boilerplate.",
    code: `import { Match, taggedEnum } from "resultar";

const OrderState = taggedEnum<{
  Pending: { readonly id: string; readonly items: number };
  Shipped: { readonly id: string; readonly carrier: string };
  Cancelled: { readonly id: string; readonly reason: string };
}>();

const describeOrder = (state: ReturnType<typeof OrderState.Pending | typeof OrderState.Shipped | typeof OrderState.Cancelled>) =>
  Match.valueTags(state, {
    Pending: ({ id, items }) => \`Order \${id}: waiting (\${items} items)\`,
    Shipped: ({ id, carrier }) => \`Order \${id}: shipped via \${carrier}\`,
    Cancelled: ({ id, reason }) => \`Order \${id}: cancelled (\${reason})\`,
  });

const orders = [
  OrderState.Pending({ id: "A-1", items: 3 }),
  OrderState.Shipped({ id: "A-2", carrier: "DHL" }),
  OrderState.Cancelled({ id: "A-3", reason: "out of stock" }),
];

for (const order of orders) {
  console.log(describeOrder(order));
}
`,
  },
];
