/**
 * Error Recovery & Fallbacks (`catchTag`, `catchTags`, `orElse`, `orElseSucceed`, `firstSuccessOf`, `catchReason`)
 *
 * This module shows how to selectively recover from specific tagged errors or
 * nested error reasons while widening or narrowing the remaining error union
 * automatically.
 */
import {
  Result,
  createTaggedError,
  err,
  ok,
  taggedEnum,
  type Result as ResultValue,
  type StrictResult,
  type TaggedEnum,
} from "resultar";

export interface Profile {
  readonly id: string;
  readonly name: string;
  readonly source: "cache" | "draft" | "empty" | "primary" | "replica" | "retry";
}

export class ProfileCacheMissError extends createTaggedError({
  name: "ProfileCacheMissError",
  message: "Profile $id was not found in cache",
}) {}

export class ProfileNotFoundError extends createTaggedError({
  name: "ProfileNotFoundError",
  message: "Profile $id was not found",
}) {}

export class ProfileReplicaError extends createTaggedError({
  name: "ProfileReplicaError",
  message: "Replica could not read profile $id",
}) {}

/**
 * Nested reason union used inside `ProfileServiceError` to demonstrate
 * `catchReason`, `catchReasons`, and `unwrapReason`.
 */
export type ProfileReason = TaggedEnum<{
  QuotaExceeded: {
    readonly limit: number;
  };
  RateLimited: {
    readonly retryAfterMs: number;
  };
  SafetyBlocked: {
    readonly policy: string;
  };
}>;

export const ProfileReason = taggedEnum<{
  QuotaExceeded: {
    readonly limit: number;
  };
  RateLimited: {
    readonly retryAfterMs: number;
  };
  SafetyBlocked: {
    readonly policy: string;
  };
}>();

type ProfileServiceError = TaggedEnum<{
  ProfileServiceError: {
    readonly reason: ProfileReason;
  };
}>;

const ProfileServiceError = taggedEnum<{
  ProfileServiceError: {
    readonly reason: ProfileReason;
  };
}>();

export type ProfileReadError =
  | ProfileCacheMissError
  | ProfileNotFoundError
  | ProfileReplicaError
  | ProfileServiceError;

const cachedProfile: Profile = {
  id: "cached",
  name: "Cached Ada",
  source: "cache",
};

const readProfileFromCache = (id: string): StrictResult<Profile, ProfileCacheMissError> =>
  id === cachedProfile.id ? ok(cachedProfile) : ProfileCacheMissError.err({ id });

const readProfileFromPrimary = (
  id: string,
): ResultValue<Profile, ProfileNotFoundError | ProfileServiceError> => {
  if (id === "missing") {
    return ProfileNotFoundError.err({ id });
  }

  if (id === "quota") {
    return err(
      ProfileServiceError.ProfileServiceError({
        reason: ProfileReason.QuotaExceeded({ limit: 10 }),
      }),
    );
  }

  if (id === "rate-limited") {
    return err(
      ProfileServiceError.ProfileServiceError({
        reason: ProfileReason.RateLimited({ retryAfterMs: 1_000 }),
      }),
    );
  }

  return ok({
    id,
    name: "Primary Ada",
    source: "primary",
  });
};

const readProfileFromReplica = (id: string): StrictResult<Profile, ProfileReplicaError> =>
  id === "replica-down"
    ? ProfileReplicaError.err({ id })
    : ok({
        id,
        name: "Replica Ada",
        source: "replica",
      });

const readLocalProfile = (
  id: string,
): StrictResult<Profile, ProfileCacheMissError | ProfileNotFoundError> =>
  id === "missing" ? ProfileNotFoundError.err({ id }) : readProfileFromCache(id);

const draftProfile = (id: number | string): Profile => ({
  id: String(id),
  name: "Draft profile",
  source: "draft",
});

const emptyProfile = (id: number | string): Profile => ({
  id: String(id),
  name: "Empty profile",
  source: "empty",
});

const retryProfile = (id: string, name: string): Profile => ({
  id,
  name,
  source: "retry",
});

/**
 * `.catchTag(tag, handler)` intercepts a single `_tag` from the error union and
 * removes `ProfileCacheMissError` from the resulting error type (`never` here).
 */
export const draftProfileFromCacheMiss = (id: string): StrictResult<Profile, never> =>
  readProfileFromCache(id).catchTag("ProfileCacheMissError", (error) =>
    ok<Profile, never>(draftProfile(error.id)),
  );

/**
 * `.catchTags(handlers)` recovers from multiple tagged error variants at once,
 * narrowing the error channel by all handled tags.
 */
export const recoverLocalProfile = (id: string): StrictResult<Profile, never> =>
  readLocalProfile(id).catchTags({
    ProfileCacheMissError: (error) => ok<Profile, never>(draftProfile(error.id)),
    ProfileNotFoundError: (error) => ok<Profile, never>(emptyProfile(error.id)),
  });

/**
 * `.orElseSucceed(fn)` converts any `Err` directly into an `Ok` fallback value
 * without needing to wrap the return value in `ok(...)`, producing `Result<T, never>`.
 */
export const guaranteedProfile = (id: string): StrictResult<Profile, never> =>
  readProfileFromCache(id).orElseSucceed((error) => emptyProfile(error.id));

/**
 * `.orElse(fn)` chains error-dependent fallback `Result` operations sequentially,
 * inspecting the previous `error` payload before selecting the next lookup.
 */
export const profileWithFallbacks = (id: string): ResultValue<Profile, ProfileReadError> =>
  readProfileFromCache(id)
    .orElse((error) => readProfileFromPrimary(String(error.id)))
    .orElse((error) =>
      readProfileFromReplica(error._tag === "ProfileNotFoundError" ? String(error.id) : id),
    );

/**
 * `Result.firstSuccessOf(candidates)` evaluates lazy candidate thunks in order
 * and returns the first `Ok` (or the last `Err` if every candidate fails).
 */
export const firstAvailableProfile = (id: string): ResultValue<Profile, ProfileReadError> =>
  Result.firstSuccessOf([
    () => readProfileFromCache(id),
    () => readProfileFromPrimary(id),
    () => readProfileFromReplica(id),
  ]);

/**
 * `.catchReason(outerTag, reasonTag, handler)` recovers from a specific nested
 * `reason._tag` inside a container error (`ProfileServiceError`).
 */
export const recoverRateLimitedProfile = (id: string): ResultValue<Profile, ProfileReadError> =>
  readProfileFromPrimary("rate-limited").catchReason(
    "ProfileServiceError",
    "RateLimited",
    (reason) => ok<Profile, never>(retryProfile(id, `Retry after ${reason.retryAfterMs}ms`)),
  );

/**
 * `.catchReasons(outerTag, handlers)` recovers from multiple nested `reason`
 * variants inside a container error in a single call.
 */
export const recoverProviderReason = (id: string): ResultValue<Profile, ProfileReadError> =>
  readProfileFromPrimary(id).catchReasons("ProfileServiceError", {
    QuotaExceeded: (reason) => ok<Profile, never>(retryProfile(id, `Quota ${reason.limit}`)),
    RateLimited: (reason) =>
      ok<Profile, never>(retryProfile(id, `Retry after ${reason.retryAfterMs}ms`)),
  });

/**
 * `.unwrapReason(outerTag)` lifts the nested `reason` union out of the outer
 * container error (`ProfileServiceError`) into the top-level error channel.
 */
export const describeProviderReason = (id: string): string =>
  readProfileFromPrimary(id)
    .unwrapReason("ProfileServiceError")
    .match(
      (profile) => `profile:${profile.source}`,
      (error) => {
        if (ProfileReason.$is("QuotaExceeded", error)) {
          return `quota:${error.limit}`;
        }

        if (ProfileReason.$is("RateLimited", error)) {
          return `rate:${error.retryAfterMs}`;
        }

        if (ProfileReason.$is("SafetyBlocked", error)) {
          return `safety:${error.policy}`;
        }

        return `other:${error._tag}`;
      },
    );

/**
 * `.matchTagsPartial(onOk, tagHandlers, onRemainingErr)` folds `Ok` and selected
 * error tags while routing any unhandled error variants to a fallback callback.
 */
export const profileBoundaryResponse = (id: string) =>
  readProfileFromPrimary(id).matchTagsPartial(
    (profile) => ({
      body: profile,
      statusCode: 200,
    }),
    {
      ProfileNotFoundError: (error) => ({
        body: { code: error._tag, id: error.id },
        statusCode: 404,
      }),
    },
    (error) => ({
      body: { code: error._tag },
      statusCode: 502,
    }),
  );
