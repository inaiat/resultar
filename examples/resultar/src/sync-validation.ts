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

export class InvalidEmailError extends createTaggedError({
  name: "InvalidEmailError",
  message: "Invalid email $email",
}) {}

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

type SignupValidationError = InvalidEmailError | WeakPasswordError | TermsNotAcceptedError;

const validateEmail = (email: string): StrictResult<string, InvalidEmailError> =>
  email.includes("@") ? ok(email.trim().toLowerCase()) : InvalidEmailError.err({ email });

const validatePassword = (
  password: Redacted<string>,
): StrictResult<Redacted<string>, WeakPasswordError> =>
  revealRedacted(password).length >= 12 ? ok(password) : WeakPasswordError.err({ password });

const validateTerms = (acceptedTerms: boolean): StrictResult<boolean, TermsNotAcceptedError> =>
  acceptedTerms ? ok(true) : TermsNotAcceptedError.err();

export const validateSignup = (
  input: SignupInput,
): ResultValue<SignupDraft, readonly SignupValidationError[]> => {
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

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null;

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

export const isSignupPasswordRedacted = (input: SignupInput): boolean =>
  validateSignup(input).match(
    (draft) => isRedacted(draft.password),
    () => false,
  );

const toProblem = (error: SignupValidationError): object => ({
  code: error._tag,
  message: error.message,
});

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
