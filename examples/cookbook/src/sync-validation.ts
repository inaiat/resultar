/**
 * Synchronous Validation & Redaction Cookbook (`sync-validation.ts`)
 *
 * Demonstrates:
 * - Defining domain errors with `createTaggedError` and `$prop` message interpolation
 * - Using `.err()` static helpers and `.is()` static type guards on tagged error classes
 * - Wrapping sensitive fields with `redact`, `revealRedacted`, and `isRedacted` so secrets
 *   never leak into error messages, logs, or JSON payloads
 * - Accumulating all field errors in parallel with `Result.validateAll`
 * - Translating `Result` values into HTTP-style responses at the boundary with `.match()`
 */
import {
  Result,
  createTaggedError,
  err,
  isRedacted,
  ok,
  redact,
  revealRedacted,
  type Redacted,
  type Result as ResultValue,
  type StrictResult,
} from "resultar";

export interface SignupInput {
  readonly acceptedTerms: boolean;
  readonly email: string;
  readonly password: string;
}

export interface SignupDraft {
  readonly email: string;
  readonly password: Redacted<string>;
}

export interface HttpResponse {
  readonly body: unknown;
  readonly statusCode: number;
}

/**
 * Tagged errors automatically infer their required payload properties from `$placeholder`
 * tokens in the message template and expose `.err(...)` and `.is(...)` helpers.
 */
export class InvalidEmailError extends createTaggedError({
  name: "InvalidEmailError",
  message: "Invalid email $email",
}) {}

/**
 * When a `Redacted<T>` value is interpolated into `$password`, Resultar formats it as
 * `<redacted:password>` instead of exposing the raw secret in `error.message` or `toJSON()`.
 */
export class WeakPasswordError extends createTaggedError({
  name: "WeakPasswordError",
  message: "Weak password $password",
}) {}

export class TermsNotAcceptedError extends createTaggedError({
  name: "TermsNotAcceptedError",
  message: "Terms were not accepted",
}) {}

export class ValidationError extends createTaggedError({
  name: "ValidationError",
  message: "Invalid input at $path: $detail",
}) {}

export type SignupValidationError = InvalidEmailError | WeakPasswordError | TermsNotAcceptedError;

/** Validates and normalizes an email address, returning `StrictResult` with a single tagged error. */
const validateEmail = (email: string): StrictResult<string, InvalidEmailError> =>
  email.includes("@") ? ok(email.trim().toLowerCase()) : InvalidEmailError.err({ email });

/**
 * Uses `revealRedacted` only inside the validation boundary while keeping the stored
 * and returned password wrapped in `Redacted<string>`.
 */
const validatePassword = (
  password: Redacted<string>,
): StrictResult<Redacted<string>, WeakPasswordError> =>
  revealRedacted(password).length >= 12 ? ok(password) : WeakPasswordError.err({ password });

const validateTerms = (acceptedTerms: boolean): StrictResult<boolean, TermsNotAcceptedError> =>
  acceptedTerms ? ok(true) : TermsNotAcceptedError.err();

/**
 * Validates all signup fields without short-circuiting on the first failure.
 * If multiple checks fail, `Result.validateAll` returns `Err` with a non-empty array of all errors.
 */
export const validateSignup = (
  input: SignupInput,
): ResultValue<SignupDraft, readonly SignupValidationError[]> => {
  // Redact the raw password immediately so downstream errors and logs cannot leak it.
  const password = redact(input.password, "password");

  return Result.validateAll([
    validateEmail(input.email),
    validatePassword(password),
    validateTerms(input.acceptedTerms),
  ]).map(([email, validatedPassword]) => ({
    email,
    password: validatedPassword,
  }));
};

/**
 * Demonstrates the generated static `.is(value)` type guard available on every
 * `createTaggedError` class for narrowing `unknown` or union error values.
 */
export const isEmailValidationFailure = (error: unknown): error is InvalidEmailError =>
  InvalidEmailError.is(error);

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null;

/**
 * Adapter pattern for decoding untrusted `unknown` payloads (e.g. JSON request bodies)
 * and collecting all structural issues into a typed `ValidationError[]` channel.
 */
export const decodeSignupPayload = (
  input: unknown,
): ResultValue<SignupInput, readonly ValidationError[]> => {
  const issues: ValidationError[] = [];

  if (!isRecord(input)) {
    return err([new ValidationError({ detail: "Expected object", path: "$" })]);
  }

  if (typeof input["email"] !== "string") {
    issues.push(new ValidationError({ detail: "Expected string", path: "email" }));
  }

  if (typeof input["password"] !== "string") {
    issues.push(new ValidationError({ detail: "Expected string", path: "password" }));
  }

  if (typeof input["acceptedTerms"] !== "boolean") {
    issues.push(new ValidationError({ detail: "Expected boolean", path: "acceptedTerms" }));
  }

  if (issues.length > 0) {
    return err(issues);
  }

  const decoded = input as unknown as SignupInput;

  return ok({
    acceptedTerms: decoded.acceptedTerms,
    email: decoded.email,
    password: decoded.password,
  });
};

/** Verifies at runtime that a validated draft still carries a redacted password wrapper. */
export const isSignupPasswordRedacted = (input: SignupInput): boolean =>
  validateSignup(input).match(
    (draft) => isRedacted(draft.password),
    () => false,
  );

const toProblem = (error: SignupValidationError): object => ({
  code: error._tag,
  message: error.message,
});

/** Maps a `Result` at the HTTP transport boundary into a status code and serializable body. */
export const createSignupResponse = (input: SignupInput): HttpResponse =>
  validateSignup(input).match(
    (draft) => ({
      body: {
        email: draft.email,
        password: draft.password,
      },
      statusCode: 201,
    }),
    (errors) => ({
      body: {
        errors: errors.map(toProblem),
      },
      statusCode: 422,
    }),
  );
