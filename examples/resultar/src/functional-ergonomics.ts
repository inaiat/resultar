import {
  constant,
  createTaggedError,
  flow,
  identity,
  Match,
  ok,
  pipe,
  Result,
  ResultTask,
} from "resultar";

export class UserNotFound extends createTaggedError({
  name: "UserNotFound",
  message: "User $id was not found",
}) {}

export class InvalidRoleError extends createTaggedError({
  name: "InvalidRoleError",
  message: "Role is not permitted",
}).withProps<{ readonly role: string; readonly allowed: readonly string[] }>() {}

export const WorkflowClock = ResultTask.service<{ now(): number }>()("WorkflowClock");
export const normalizeUserId = flow(
  (id: string) => id.trim(),
  (id) => id.toLowerCase(),
);

const ALLOWED_ROLES = ["admin", "editor", "viewer"] as const;
type AllowedRole = (typeof ALLOWED_ROLES)[number];

const ensureNonNullRole = Result.fromNullishOr(
  () => new InvalidRoleError({ role: "<empty>", allowed: ALLOWED_ROLES }),
);

const validateAllowedRole = Result.liftPredicate(
  (role: string): role is AllowedRole => (ALLOWED_ROLES as readonly string[]).includes(role),
  (role) => new InvalidRoleError({ role, allowed: ALLOWED_ROLES }),
);

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

const formatAccessWithContext = Match.context<AccessEvent, [requestId: string]>().pipe(
  Match.tagsExhaustive({
    Granted: (event, requestId) => `[${requestId}] allow:${event.role}`,
    Denied: (event, requestId) => `[${requestId}] deny:${event.reason}`,
  }),
);

export const loadUserLabel = ResultTask.fn(function* (id: string, prefix = "user") {
  const clock = yield* WorkflowClock;
  if (id === "missing") yield* ResultTask.err(new UserNotFound({ id }));
  return `${prefix}:${normalizeUserId(id)}:${clock.now()}`;
});

export const recoverUserLabel = (id: string) =>
  pipe(
    loadUserLabel(id),
    ResultTask.catchTags({
      UserNotFound: (error: UserNotFound) => ResultTask.ok(`guest:${error.id}`),
    }),
  );

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
  const first = await ResultTask.runPromise(program);
  const second = await ResultTask.runPromise(program);
  const normalized = await ResultTask.runPromise(
    loadUserLabel(" ADA ").provideService(WorkflowClock, { now: () => 42 }),
  );
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

