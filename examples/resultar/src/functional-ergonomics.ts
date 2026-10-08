import { constant, createTaggedError, flow, identity, ok, pipe, ResultTask } from "resultar";

export class UserNotFound extends createTaggedError({
  name: "UserNotFound",
  message: "User $id was not found",
}) {}

export const WorkflowClock = ResultTask.service<{ now(): number }>()("WorkflowClock");
export const normalizeUserId = flow(
  (id: string) => id.trim(),
  (id) => id.toLowerCase(),
);

export const loadUserLabel = ResultTask.fn(function* (id: string, prefix = "user") {
  const clock = yield* WorkflowClock;
  if (id === "missing") yield* ResultTask.fail(new UserNotFound({ id }));
  return `${prefix}:${normalizeUserId(id)}:${clock.now()}`;
});

export const recoverUserLabel = (id: string) =>
  pipe(
    loadUserLabel(id),
    ResultTask.catchTags({
      UserNotFound: (error: UserNotFound) => ResultTask.succeed(`guest:${error.id}`),
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
  return {
    first,
    second,
    normalized,
    events,
    status: ok<string, UserNotFound>("Ready").match({
      ok: identity,
      error: constant("Unavailable"),
    }),
  };
};
