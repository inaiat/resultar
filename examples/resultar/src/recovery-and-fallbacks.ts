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

export const draftProfileFromCacheMiss = (id: string): StrictResult<Profile, never> =>
  readProfileFromCache(id).catchTag("ProfileCacheMissError", (error) =>
    ok<Profile, never>(draftProfile(error.id)),
  );

export const recoverLocalProfile = (id: string): StrictResult<Profile, never> =>
  readLocalProfile(id).catchTags({
    ProfileCacheMissError: (error) => ok<Profile, never>(draftProfile(error.id)),
    ProfileNotFoundError: (error) => ok<Profile, never>(emptyProfile(error.id)),
  });

export const profileWithFallbacks = (id: string): ResultValue<Profile, ProfileReadError> =>
  Result.firstSuccessOf([
    () => readProfileFromCache(id),
    () => readProfileFromPrimary(id),
    () => readProfileFromReplica(id),
  ]);

export const firstAvailableProfile = (id: string): ResultValue<Profile, ProfileReadError> =>
  Result.firstSuccessOf([
    () => readProfileFromCache(id),
    () => readProfileFromPrimary(id),
    () => readProfileFromReplica(id),
  ]);

export const recoverRateLimitedProfile = (id: string): ResultValue<Profile, ProfileReadError> =>
  readProfileFromPrimary("rate-limited").catchReason(
    "ProfileServiceError",
    "RateLimited",
    (reason) => ok<Profile, never>(retryProfile(id, `Retry after ${reason.retryAfterMs}ms`)),
  );

export const recoverProviderReason = (id: string): ResultValue<Profile, ProfileReadError> =>
  readProfileFromPrimary(id).catchReasons("ProfileServiceError", {
    QuotaExceeded: (reason) => ok<Profile, never>(retryProfile(id, `Quota ${reason.limit}`)),
    RateLimited: (reason) =>
      ok<Profile, never>(retryProfile(id, `Retry after ${reason.retryAfterMs}ms`)),
  });

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
