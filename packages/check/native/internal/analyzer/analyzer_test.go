package analyzer

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/config"
	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/project"
)

const pilotFixture = `
type Result<T, E> = {
  readonly value?: T
  readonly error?: E
  map<X>(fn: (value: T) => X): Result<X, E>
}
declare function ok<T, E = never>(value: T): Result<T, E>
declare function save(): Result<string, Error>
declare function asyncSave(value: number): Promise<void>

save()
const unhandled = save()
ok(1).map(asyncSave)
declare const unsafe: Result<string, unknown>
void unsafe
`

func TestPilotRuleParity(t *testing.T) {
	directory := writeFixture(t, pilotFixture)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}

	findings, err := Run(context.Background(), opened.Program, opened.Directory, config.Defaults())
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		rule string
		line int
	}{
		{"no-discard", 11},
		{"no-discard", 12},
		{"no-discard", 13},
		{"no-promise-in-result-success", 13},
		{"no-unknown-result-error", 14},
	}
	if len(findings) != len(want) {
		t.Fatalf("got %d findings, want %d: %#v", len(findings), len(want), findings)
	}
	if len(findings[0].Fixes) != 1 || findings[0].Fixes[0].Edits[0].NewText != "void " {
		t.Fatalf("no-discard direct finding should offer an explicit void fix: %#v", findings[0].Fixes)
	}
	if findings[0].Fixes[0].Kind != FixIntentionalDiscard || findings[0].Fixes[0].Description == "" {
		t.Fatalf("discard must be classified as an intentional decision: %#v", findings[0].Fixes)
	}
	for index, expected := range want {
		if findings[index].Rule != expected.rule || findings[index].Line != expected.line {
			t.Errorf("finding %d = %s:%d, want %s:%d", index, findings[index].Rule, findings[index].Line, expected.rule, expected.line)
		}
	}
}

func TestNoDiscardModesAndConsumers(t *testing.T) {
	directory := writeFixture(t, `
type Result<T, E> = {
  readonly value?: T
  readonly error?: E
  match<A, B>(ok: (value: T) => A, error: (error: E) => B): A | B
}
declare function save(): Result<string, Error>
declare function external(value: unknown): void

const unhandled = save()
external(unhandled)
const handled = save()
handled.match(value => value, error => error.message)
const returned = save()
const passThrough = (): Result<string, Error> => ({ ...returned })
const discarded = save()
void discarded
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}

	options := config.Defaults()
	options.NoPromiseInResultSuccess = config.SeverityOff
	options.NoUnknownResultError = config.SeverityOff
	mustUse, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(mustUse) != 1 || mustUse[0].Line != 10 {
		t.Fatalf("must-use findings = %#v", mustUse)
	}

	options.NoDiscardMode = "direct"
	direct, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(direct) != 0 {
		t.Fatalf("direct findings = %#v", direct)
	}
}

func TestLineSuppressions(t *testing.T) {
	directory := writeFixture(t, `
// resultar-check-disable-next-line no-throw
throw new Error("allowed here")
throw new Error("reported") // resultar-check-disable-line no-throw
throw new Error("reported too")
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}
	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.PreferTaggedError = config.SeverityOff
	options.NoThrow = config.SeverityError
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 1 || findings[0].Line != 5 {
		t.Fatalf("unexpected suppressed findings: %#v", findings)
	}
}

func TestCapitalizedSuppressions(t *testing.T) {
	directory := writeFixture(t, `
// Resultar-check-disable-next-line no-throw
throw new Error("allowed here")
throw new Error("reported too")
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}
	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.PreferTaggedError = config.SeverityOff
	options.NoThrow = config.SeverityError
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 1 || findings[0].Line != 4 {
		t.Fatalf("unexpected suppressed findings: %#v", findings)
	}
}

func TestCompositionRuleParity(t *testing.T) {
	directory := writeFixture(t, `
type Result<T, E> = {
  map<X>(fn: (value: T) => X): Result<X, E>
  andThen<X, F>(fn: (value: T) => Result<X, F>): Result<X, E | F>
  orElse<F>(fn: (error: E) => Result<T, F>): Result<T, F>
}
type ResultAsync<T, E> = {
  map<X>(fn: (value: T) => X): ResultAsync<X, E>
}
declare function ok<T, E = never>(value: T): Result<T, E>
declare function err<E, T = never>(error: E): Result<T, E>
declare function source(): Result<number, string>
declare function fallback(): Result<number, string>
declare function asyncFallback(): ResultAsync<number, string>
declare function fromThrowable<T>(fn: () => T, catchMapper?: (error: unknown) => Error): Result<T, Error>
declare function tryResult<T, E = unknown>(fn: () => T, catchMapper?: (error: unknown) => E): Result<T, E>

void source().orElse(() => err("mapped"))
void source().map(() => fallback())
void source().map(() => asyncFallback())
void source().andThen((value) => ok(value + 1))
void source().orElse(() => fallback()).orElse(() => fallback())
void fromThrowable(() => 1)
void tryResult<number, Error>(() => 1)
void fromThrowable({ try: () => 1, catch: () => new Error("mapped") })
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}

	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.NoPromiseInResultSuccess = config.SeverityOff
	options.NoUnknownResultError = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		rule     string
		line     int
		column   int
		severity config.Severity
		message  string
	}{
		{"prefer-map-err", 18, 15, config.SeverityWarning, "`orElse` only replaces the failure with another Err. Use `mapErr` when the Ok value cannot recover."},
		{"prefer-and-then", 19, 15, config.SeverityWarning, "`map` creates a nested Result when its callback returns Result<number, string>. Use `andThen` for fallible composition."},
		{"prefer-and-then", 20, 15, config.SeverityWarning, "`map` creates a nested Result when its callback returns ResultAsync<number, string>. Use `asyncAndThen` for fallible composition."},
		{"prefer-map", 21, 15, config.SeverityWarning, "andThen only wraps the callback value in Ok. Use map for a non-fallible transformation."},
		{"prefer-first-success-of", 22, 40, config.SeverityWarning, "This chain has 2 error-independent orElse fallbacks. Use Result.firstSuccessOf to express the fallback selection."},
		{"typed-catch-mapper", 23, 6, config.SeverityWarning, "`fromThrowable` without a catch mapper leaves the error channel as `unknown`. Map the caught value to a specific Resultar error."},
	}
	if len(findings) != len(want) {
		t.Fatalf("got %d findings, want %d: %#v", len(findings), len(want), findings)
	}
	for index, expected := range want {
		finding := findings[index]
		if finding.Rule != expected.rule || finding.Line != expected.line || finding.Column != expected.column ||
			finding.Severity != expected.severity || finding.Message != expected.message {
			t.Errorf("finding %d = %#v, want %#v", index, finding, expected)
		}
	}
	if len(findings[0].Fixes) != 1 || findings[0].Fixes[0].Edits[0].NewText != "mapErr" {
		t.Fatalf("expected mapErr quick fix, got %#v", findings[0].Fixes)
	}
	if findings[0].Fixes[0].Kind != FixCorrection {
		t.Fatalf("composition fix must be classified as a correction: %#v", findings[0].Fixes)
	}
	if len(findings[1].Fixes) != 1 || findings[1].Fixes[0].Edits[0].NewText != "andThen" {
		t.Fatalf("expected andThen quick fix, got %#v", findings[1].Fixes)
	}
}

func TestCompositionRulesAvoidFalsePositives(t *testing.T) {
	directory := writeFixture(t, `
type Result<T, E> = {
  map<X>(fn: (value: T) => X): Result<X, E>
  andThen<X, F>(fn: (value: T) => Result<X, F>): Result<X, E | F>
  orElse<F>(fn: (error: E) => Result<T, F>): Result<T, F>
}
declare function ok<T, E = never>(value: T): Result<T, E>
declare function source(): Result<number, string>
declare function fallback(): Result<number, string>
declare function tryResult<T, E = unknown>(fn: (() => T) | { try: () => T, catch: (error: unknown) => E }): Result<T, E>

void source().orElse(() => ok(1))
void source().map((value) => value + 1)
void source().andThen(() => fallback())
void source().orElse(() => fallback())
void tryResult<number, TypeError>(() => 1)
void tryResult({ try: () => 1, catch: () => new TypeError("mapped") })
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}

	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.NoPromiseInResultSuccess = config.SeverityOff
	options.NoUnknownResultError = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 0 {
		t.Fatalf("unexpected composition findings: %#v", findings)
	}
}

func TestStructuralRuleParity(t *testing.T) {
	directory := writeFixture(t, `
type Result<T, E> = {
  catchTag<X, F>(tag: string, fn: (error: E) => Result<X, F>): Result<T | X, F>
}
declare const Result: {
  combine<T, E>(values: readonly Result<T, E>[]): Result<T[], E>
}
declare function ok<T, E = never>(value: T): Result<T, E>
declare function validate(value: number): Result<string, Error>
declare function safeTry(body: unknown): unknown
declare const values: readonly number[]
declare const source: Result<number, { reason: { _tag: string } }>

void Result.combine(values.map(validate))
void source.catchTag("Nested", (error) => error.reason._tag === "Missing" ? ok(0) : source)
safeTry(function* () {
  yield source
})
try {
  throw new Error("failed")
} catch {}
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}

	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.NoPromiseInResultSuccess = config.SeverityOff
	options.NoUnknownResultError = config.SeverityOff
	options.NoThrow = config.SeverityError
	options.NoTryCatch = config.SeveritySuggestion
	options.PreferTaggedError = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		rule     string
		line     int
		severity config.Severity
		message  string
	}{
		{"prefer-result-for-each", 14, config.SeverityWarning, "Use Result.forEach instead of Result.combine over an intermediate map result list."},
		{"prefer-catch-reason", 15, config.SeverityWarning, "This catchTag callback inspects a nested reason._tag. Use catchReason or catchReasons for typed nested-error handling."},
		{"yield-star-in-safe-try", 17, config.SeverityWarning, "Use `yield*` when unwrapping Resultar values inside `safeTry`."},
		{"no-try-catch", 19, config.SeveritySuggestion, "Avoid raw try/catch for expected failures. Use tryResult or tryResultAsync to preserve the typed error channel."},
		{"no-throw", 20, config.SeverityError, "Do not throw for expected Resultar failures. Return `Err`/`errAsync` or wrap uncontrolled external code with a Resultar catch boundary."},
	}
	if len(findings) != len(want) {
		t.Fatalf("got %d findings, want %d: %#v", len(findings), len(want), findings)
	}
	for _, finding := range findings {
		if finding.Rule == "yield-star-in-safe-try" && (len(finding.Fixes) != 1 || finding.Fixes[0].Edits[0].NewText != "yield*") {
			t.Fatalf("yield-star finding should offer a yield* fix: %#v", finding.Fixes)
		}
	}
	for index, expected := range want {
		finding := findings[index]
		if finding.Rule != expected.rule || finding.Line != expected.line || finding.Severity != expected.severity || finding.Message != expected.message {
			t.Errorf("finding %d = %#v, want %#v", index, finding, expected)
		}
	}
}

func TestSafeTryAndTaggedErrorRuleParity(t *testing.T) {
	directory := writeFixture(t, `
type Result<T, E> = { readonly value?: T; readonly error?: E }
declare function err<T = never, E = unknown>(error: E): Result<T, E>
declare function safeTry(body: unknown): unknown
declare function createTaggedError(
  options: { readonly message?: string; readonly name: string }
): new (...args: readonly unknown[]) => Error

class DomainError extends Error {}
void err(new Error("channel"))
throw new Error("thrown")
class InvalidEmailError extends createTaggedError({
  name: "OtherEmailError",
  message: "Invalid email"
}) {
  constructor() {
    super()
  }
}
safeTry(async function* () {
  await Promise.resolve(1)
  try {
    return 1
  } finally {}
})
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}

	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.NoPromiseInResultSuccess = config.SeverityOff
	options.NoUnknownResultError = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		rule    string
		line    int
		message string
	}{
		{"prefer-tagged-error", 9, "Prefer `createTaggedError` for Resultar domain errors so failures keep a stable tag and typed metadata."},
		{"prefer-tagged-error", 10, "Prefer a `createTaggedError` instance over `new Error(...)` in Resultar error channels."},
		{"prefer-tagged-error", 11, "Prefer a `createTaggedError` instance over throwing `new Error(...)` so failures keep a stable tag and typed metadata."},
		{"tagged-error-name-match", 13, "Tagged error name `OtherEmailError` should match class name `InvalidEmailError`."},
		{"no-tagged-error-constructor-override", 16, "Do not override the constructor generated by `createTaggedError`; it owns template props, cause, and serialization behavior."},
		{"no-await-in-safe-try", 21, "Do not use `await` inside `safeTry`. Use `yield*` for Resultar values and wrap raw Promises before yielding them."},
		{"no-try-catch-in-safe-try", 22, "Avoid raw try/catch inside `safeTry`. Use `safeTry({ try, catch })`, `tryResult`, or `tryResultAsync` to keep failures typed."},
	}
	if len(findings) != len(want) {
		t.Fatalf("got %d findings, want %d: %#v", len(findings), len(want), findings)
	}
	for index, expected := range want {
		finding := findings[index]
		if finding.Rule != expected.rule || finding.Line != expected.line || finding.Message != expected.message {
			t.Errorf("finding %d = %#v, want %#v", index, finding, expected)
		}
	}
}

func TestErrorChannelSemanticRuleParity(t *testing.T) {
	directory := writeFixture(t, `
type Result<T, E> = {
  readonly error?: E
  mapErr<F>(fn: (error: E) => F): Result<T, F>
}
class FirstError extends Error { readonly first = true }
class SecondError extends Error { readonly second = true }
declare const infallible: Result<string, never>
declare const fallible: Result<string, Error>
declare const union: Result<string, FirstError | SecondError>

void infallible.mapErr((error) => error)
void fallible.mapErr((error) => error)
const narrowed = union as Result<string, FirstError>
const unchanged = fallible as Result<string, Error>
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}

	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.NoPromiseInResultSuccess = config.SeverityOff
	options.NoUnknownResultError = config.SeverityOff
	options.PreferTaggedError = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		rule    string
		line    int
		message string
	}{
		{"no-useless-recovery", 12, "`mapErr` cannot run because this Resultar value has `never` in the error channel."},
		{"unsafe-result-type-assertion", 14, "This assertion narrows the Resultar error channel unsafely (`FirstError | SecondError` to `FirstError`). Prefer a real recovery or mapping step."},
	}
	if len(findings) != len(want) {
		t.Fatalf("got %d findings, want %d: %#v", len(findings), len(want), findings)
	}
	for index, expected := range want {
		finding := findings[index]
		if finding.Rule != expected.rule || finding.Line != expected.line || finding.Message != expected.message {
			t.Errorf("finding %d = %#v, want %#v", index, finding, expected)
		}
	}
}

func TestNoUnsafeAwaitParity(t *testing.T) {
	directory := writeFixture(t, `
type Result<T, E> = { readonly value?: T; readonly error?: E }
declare class ResultAsync<T, E> implements PromiseLike<Result<T, E>> {
  then<A = Result<T, E>, B = never>(
    ok?: ((value: Result<T, E>) => A | PromiseLike<A>) | null,
    error?: ((reason: unknown) => B | PromiseLike<B>) | null
  ): PromiseLike<A | B>
}
declare function ok<T, E = never>(value: T): Result<T, E>
declare function fetch(path: string): Promise<string>
declare function startServer(): Promise<void>
declare function promiseReturningResult(): Promise<Result<string, Error>>
declare function runPromise<T, E>(result: ResultAsync<T, E>): Promise<T>
declare function tryAsync(body: unknown): unknown
declare const resultAsync: ResultAsync<string, Error>

async function raw() {
  await fetch("/raw")
  await resultAsync
  await startServer()
}
async function context(): Promise<Result<string, Error>> {
  const value = await fetch("/context")
  await resultAsync
  await promiseReturningResult()
  await runPromise(resultAsync)
  await 1
  return ok(value)
}
tryAsync(async () => await fetch("/boundary"))
tryAsync(async () => {
  async function nested() {
    await fetch("/nested")
  }
  return nested()
})
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}

	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.NoPromiseInResultSuccess = config.SeverityOff
	options.NoUnknownResultError = config.SeverityOff
	options.NoUnsafeAwait = config.SeverityWarning
	options.NoUnsafeAwaitIgnoreCalls = []string{"startServer"}
	options.TypedCatchMapper = config.SeverityOff
	contextFindings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(contextFindings) != 1 || contextFindings[0].Rule != "no-unsafe-await" || contextFindings[0].Line != 23 {
		t.Fatalf("resultar-context findings = %#v", contextFindings)
	}

	options.NoUnsafeAwaitMode = "all"
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		line    int
		message string
	}{
		{18, "Wrap this awaited Promise in tryAsync, tryResultAsync, tryCatchAsync, or fromThrowableAsync so rejections stay in the Resultar error channel."},
		{19, "Do not unwrap a Resultar async value inside a raw Promise boundary. Return ResultAsync or StrictResultAsync so failures stay in the Resultar error channel."},
		{23, "Wrap this awaited Promise in tryAsync, tryResultAsync, tryCatchAsync, or fromThrowableAsync so rejections stay in the Resultar error channel."},
		{33, "Wrap this awaited Promise in tryAsync, tryResultAsync, tryCatchAsync, or fromThrowableAsync so rejections stay in the Resultar error channel."},
	}
	if len(findings) != len(want) {
		t.Fatalf("got %d findings, want %d: %#v", len(findings), len(want), findings)
	}
	for index, expected := range want {
		finding := findings[index]
		if finding.Rule != "no-unsafe-await" || finding.Line != expected.line || finding.Message != expected.message {
			t.Errorf("finding %d = %#v, want %#v", index, finding, expected)
		}
	}
}

func TestNoUnsafeAwaitAcceptsResultTaskRunExitOnly(t *testing.T) {
	directory := writeFixture(t, `
interface ResultTask<T, E = never> { readonly valueType: T; readonly errorType: E }
declare const ResultTask: {
  runExit<T, E>(task: ResultTask<T, E>): Promise<unknown>
  runPromise<T, E>(task: ResultTask<T, E>): Promise<T>
}
declare const task: ResultTask<number, string>
declare const other: { runExit(): Promise<void> }
async function main() {
  await ResultTask.runExit(task)
  await ResultTask.runPromise(task)
  await other.runExit()
}
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}
	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.NoUnsafeAwait = config.SeverityWarning
	options.NoUnsafeAwaitMode = "all"
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 2 {
		t.Fatalf("unexpected runExit findings: %#v", findings)
	}
	for index, line := range []int{11, 12} {
		if findings[index].Rule != "no-unsafe-await" || findings[index].Line != line {
			t.Fatalf("unexpected finding: %#v", findings[index])
		}
	}
}

func TestNoUnsafeAwaitDoesNotTreatUnrelatedTryPromiseAsBoundary(t *testing.T) {
	directory := writeFixture(t, `
interface Client {
  tryPromise<T>(options: { try: () => Promise<T>; catch: (error: unknown) => Error }): Promise<T>
}
declare const client: Client

void client.tryPromise({
  try: async () => {
    await Promise.resolve(1)
    return 1
  },
  catch: () => new Error("failed"),
})
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}

	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.NoPromiseInResultSuccess = config.SeverityOff
	options.NoUnknownResultError = config.SeverityOff
	options.NoUnsafeAwait = config.SeverityWarning
	options.NoUnsafeAwaitMode = "all"
	options.PreferTaggedError = config.SeverityOff
	options.TypedCatchMapper = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 1 || findings[0].Rule != "no-unsafe-await" {
		t.Fatalf("unrelated tryPromise findings = %#v", findings)
	}
}

func TestResultTaskRuleParity(t *testing.T) {
	directory := writeFixture(t, `
interface ResultTask<T, E = never, R = never> {
  map<X>(fn: (value: T) => X): ResultTask<X, E, R>
  andThen<X, F, S>(fn: (value: T) => ResultTask<X, F, S>): ResultTask<X, E | F, R | S>
  catchAll<X, F, S>(fn: (error: E) => ResultTask<X, F, S>): ResultTask<T | X, F, R | S>
  [Symbol.iterator](): Generator<unknown, T, unknown>
}
declare const ResultTask: {
  succeed<T, E = never>(value: T): ResultTask<T, E>
  gen<T>(body: () => Generator<unknown, T, unknown>): ResultTask<T>
}
declare function task(): ResultTask<number, string>
declare const unknownTask: ResultTask<number, unknown>
class FirstTaskError extends Error {}
class SecondTaskError extends Error {}
declare const unionTask: ResultTask<number, FirstTaskError | SecondTaskError>

void task().map(async (value) => value)
void task().map(() => ResultTask.succeed(1))
void task().andThen(() => ResultTask.succeed(1))
void ResultTask.succeed(1).catchAll(() => ResultTask.succeed(2))
void (unionTask as ResultTask<number, FirstTaskError>)
void ResultTask.gen(function* () {
  yield task()
  return 1
})
void ResultTask.gen(function* () {
  yield* task()
  return 1
})
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}

	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.PreferTaggedError = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		rule string
		line int
	}{
		{"no-unknown-result-error", 13},
		{"no-promise-in-result-success", 18},
		{"prefer-and-then", 19},
		{"prefer-map", 20},
		{"no-useless-recovery", 21},
		{"unsafe-result-type-assertion", 22},
		{"yield-star-in-result-task-gen", 24},
	}
	if len(findings) != len(want) {
		t.Fatalf("got %d findings, want %d: %#v", len(findings), len(want), findings)
	}
	for index, expected := range want {
		if findings[index].Rule != expected.rule || findings[index].Line != expected.line {
			t.Errorf("finding %d = %s:%d, want %s:%d", index, findings[index].Rule, findings[index].Line, expected.rule, expected.line)
		}
	}
	if len(findings[2].Fixes) != 1 || findings[2].Fixes[0].Edits[0].NewText != "andThen" {
		t.Fatalf("expected andThen quick fix, got %#v", findings[2].Fixes)
	}
	if len(findings[3].Fixes) != 1 || findings[3].Fixes[0].Edits[0].NewText != "map" {
		t.Fatalf("expected map quick fix, got %#v", findings[3].Fixes)
	}
	if len(findings[6].Fixes) != 1 || findings[6].Fixes[0].Edits[0].NewText != "yield*" {
		t.Fatalf("expected yield* quick fix, got %#v", findings[6].Fixes)
	}
}

func TestResultTaskStaticConsumersAvoidNoDiscardFalsePositives(t *testing.T) {
	directory := writeFixture(t, `
interface ResultTask<T, E = never, R = never> {}
declare const ResultTask: {
  provideServices<T, E, R>(task: ResultTask<T, E, R>, services: object): ResultTask<T, E, R>
  runExit<T, E, R>(task: ResultTask<T, E, R>): Promise<unknown>
  runResult<T, E, R>(task: ResultTask<T, E, R>): Promise<unknown>
}
declare function task(): ResultTask<number, string>

task()
const unhandled = task()
ResultTask.runResult(unhandled)
const provided = ResultTask.provideServices(task(), {})
ResultTask.runExit(provided)
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}

	options := config.Defaults()
	options.NoPromiseInResultSuccess = config.SeverityOff
	options.NoUnknownResultError = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 1 || findings[0].Rule != "no-discard" || findings[0].Line != 10 {
		t.Fatalf("unexpected ResultTask no-discard findings: %#v", findings)
	}
}

func TestNoInvalidLifetime(t *testing.T) {
	directory := writeFixture(t, `
declare const module: {
  singleton(name: string, dependencies: readonly string[], create: () => unknown): unknown
  scoped(name: string, dependencies: readonly string[], create: () => unknown): unknown
  transient(name: string, dependencies: readonly string[], create: () => unknown): unknown
  task(name: string, dependencies: readonly string[], create: () => unknown, options?: { readonly lifetime?: string }): unknown
  resource(name: string, dependencies: readonly string[], options: { readonly lifetime?: string }): unknown
  value(name: string, value: unknown): unknown
}
void module.value("config", {})
void module.transient("operation", [], () => 1)
void module.scoped("request", ["operation"], () => 1)
void module.singleton("cache", [], () => 1)
void module.singleton("application", ["cache", "config"], () => 1)
void module.singleton("server", ["request"], () => 1)
void module.task("snapshot", ["operation"], () => 1, { lifetime: "singleton" })
void module.resource("connection", ["cache"], { lifetime: "scoped" })
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}

	findings, err := Run(context.Background(), opened.Program, opened.Directory, config.Defaults())
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		rule string
		line int
	}{
		{"no-invalid-lifetime", 12},
		{"no-invalid-lifetime", 15},
		{"no-invalid-lifetime", 16},
	}
	if len(findings) != len(want) {
		t.Fatalf("got %d findings, want %d: %#v", len(findings), len(want), findings)
	}
	for index, expected := range want {
		if findings[index].Rule != expected.rule || findings[index].Line != expected.line {
			t.Errorf("finding %d = %s:%d, want %s:%d", index, findings[index].Rule, findings[index].Line, expected.rule, expected.line)
		}
	}
}

func TestResultTaskGenRules(t *testing.T) {
	directory := writeFixture(t, `
interface Result<T, E> { readonly value?: T; readonly error?: E }
interface ResultTask<T, E = never, R = never> { [Symbol.iterator](): Generator<unknown, T, unknown> }
declare function ok<T>(value: T): Result<T, never>
declare function err<E>(error: E): Result<never, E>
declare const ResultTask: {
  gen<T>(body: () => Generator<unknown, T, unknown> | AsyncGenerator<unknown, T, unknown>): ResultTask<T>
  sync<T>(evaluate: () => T): ResultTask<T>
  scoped<T>(task: ResultTask<T, never, never>): ResultTask<T, never, never>
  acquireRelease<T>(options: object): ResultTask<T, never, never>
}
declare function load(): ResultTask<number, string>
void ResultTask.gen(function* () {
  return ok(1)
})
void ResultTask.gen(function* () {
  return err("offline")
})
void ResultTask.gen(async function* () {
  await Promise.resolve(1)
  return 1
})
void ResultTask.gen(function* () {
  yield* ResultTask.acquireRelease({})
  return 1
})
void ResultTask.scoped(ResultTask.gen(function* () {
  yield* ResultTask.acquireRelease({})
  return 1
}))
void ResultTask.sync(() => {
  throw new Error("defect")
})
void ResultTask.gen(function* () {
  return yield* load()
})
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}

	options := config.Defaults()
	options.PreferTaggedError = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		rule string
		line int
	}{
		{"no-result-in-task-gen", 14},
		{"no-result-in-task-gen", 17},
		{"no-await-in-result-task-gen", 20},
		{"no-unscoped-acquire-release", 24},
		{"no-throw-in-task-sync", 32},
	}
	if len(findings) != len(want) {
		t.Fatalf("got %d findings, want %d: %#v", len(findings), len(want), findings)
	}
	for index, expected := range want {
		if findings[index].Rule != expected.rule || findings[index].Line != expected.line {
			t.Errorf("finding %d = %s:%d, want %s:%d", index, findings[index].Rule, findings[index].Line, expected.rule, expected.line)
		}
	}
}

func writeFixture(t *testing.T, source string) string {
	t.Helper()
	directory := t.TempDir()
	configText := `{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true,
    "strict": true,
    "target": "ES2022"
  },
  "files": ["fixture.ts"]
}`
	if err := os.WriteFile(filepath.Join(directory, "tsconfig.json"), []byte(configText), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "fixture.ts"), []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	return directory
}
func TestTaskStaticCompositionConsumesInput(t *testing.T) {
	directory := writeFixture(t, `
interface Result<T, E = never> {readonly value:T;readonly error:E}
interface ResultAsync<T, E = never> {readonly value:T;readonly error:E}
interface ResultTask<T, E = never, R = never> {
  readonly value:T;readonly error:E;readonly requirements:R
  [Symbol.iterator](): Generator<unknown, T, unknown>
}
declare const Result: {
  catchTag<T,E,F>(result:Result<T,E>,tag:string,fn:(error:E)=>Result<T,F>):Result<T,F>
  catchReason<T,E,F>(result:Result<T,E>,tag:string,reasonTag:string,fn:(reason:unknown,error:E)=>Result<T,F>):Result<T,F>
  catchReasons<T,E,F>(result:Result<T,E>,tag:string,handlers:Record<string,(reason:unknown,error:E)=>Result<T,F>>):Result<T,F>
  unwrapReason<T,E>(result:Result<T,E>,tag:string):Result<T,E>
  orElseSucceed<T,E,B>(result:Result<T,E>,fn:(error:E)=>B):Result<T|B,never>
  unwrapOr<T,E,B>(result:Result<T,E>,fallback:B):T|B
  matchTags<T,E,A>(result:Result<T,E>,handlers:Record<string,(value:unknown)=>A>):A
  inspectBoth<T,E>(result:Result<T,E>,onOk:(value:T)=>unknown,onErr:(error:E)=>unknown):Result<T,E>
  all<T,E>(results:readonly Result<T,E>[]):Result<T[],E>
}
declare const ResultAsync: {
  catchTag<T,E,F>(result:ResultAsync<T,E>,tag:string,fn:(error:E)=>ResultAsync<T,F>):ResultAsync<T,F>
  catchReason<T,E,F>(result:ResultAsync<T,E>,tag:string,reasonTag:string,fn:(reason:unknown,error:E)=>ResultAsync<T,F>):ResultAsync<T,F>
  catchReasons<T,E,F>(result:ResultAsync<T,E>,tag:string,handlers:Record<string,(reason:unknown,error:E)=>ResultAsync<T,F>>):ResultAsync<T,F>
  unwrapReason<T,E>(result:ResultAsync<T,E>,tag:string):ResultAsync<T,E>
  orElseSucceed<T,E,B>(result:ResultAsync<T,E>,fn:(error:E)=>B):ResultAsync<T|B,never>
  unwrapOr<T,E,B>(result:ResultAsync<T,E>,fallback:B):Promise<T|B>
  matchTags<T,E,A>(result:ResultAsync<T,E>,handlers:Record<string,(value:unknown)=>A>):Promise<A>
  inspectBoth<T,E>(result:ResultAsync<T,E>,onOk:(value:T)=>unknown,onErr:(error:E)=>unknown):ResultAsync<T,E>
  all<T,E>(results:readonly ResultAsync<T,E>[]):ResultAsync<T[],E>
}
declare const ResultTask: {
  mapError<T,E,R,F>(task:ResultTask<T,E,R>,fn:(error:E)=>F):ResultTask<T,F,R>
  mapErr<T,E,R,F>(task:ResultTask<T,E,R>,fn:(error:E)=>F):ResultTask<T,F,R>
  flatMap<T,E,R,U,F,S>(task:ResultTask<T,E,R>,fn:(value:T)=>ResultTask<U,F,S>):ResultTask<U,E|F,R|S>
  andThen<T,E,R,U,F,S>(task:ResultTask<T,E,R>,fn:(value:T)=>ResultTask<U,F,S>):ResultTask<U,E|F,R|S>
  catchAll<T,E,R,U,F,S>(task:ResultTask<T,E,R>,fn:(error:E)=>ResultTask<U,F,S>):ResultTask<T|U,F,R|S>
  orElse<T,E,R,U,F,S>(task:ResultTask<T,E,R>,fn:(error:E)=>ResultTask<U,F,S>):ResultTask<T|U,F,R|S>
  orElseSucceed<T,E,R,B>(task:ResultTask<T,E,R>,fn:(error:E)=>B):ResultTask<T|B,never,R>
  unwrapOr<T,E,R,B>(task:ResultTask<T,E,R>,fallback:B):ResultTask<T|B,never,R>
  catchTag<T,E,R>(task:ResultTask<T,E,R>,tag:string,fn:(error:E)=>ResultTask<T,never,R>):ResultTask<T,never,R>
  catchTags<T,E,R>(task:ResultTask<T,E,R>,handlers:Record<string,(error:E)=>ResultTask<T,never,R>>):ResultTask<T,never,R>
  catchReason<T,E,R>(task:ResultTask<T,E,R>,tag:string,reasonTag:string,fn:(reason:unknown,error:E)=>ResultTask<T,never,R>):ResultTask<T,never,R>
  catchReasons<T,E,R>(task:ResultTask<T,E,R>,tag:string,handlers:Record<string,(reason:unknown,error:E)=>ResultTask<T,never,R>>):ResultTask<T,never,R>
  unwrapReason<T,E,R>(task:ResultTask<T,E,R>,tag:string):ResultTask<T,E,R>
  filterOrElse<T,E,R,F>(task:ResultTask<T,E,R>,predicate:(value:T)=>boolean,onFalse:(value:T)=>F):ResultTask<T,E|F,R>
  matchTags<T,E,R,A>(task:ResultTask<T,E,R>,handlers:Record<string,(value:unknown)=>A>):ResultTask<A,never,R>
  matchTagsPartial<T,E,R,A>(task:ResultTask<T,E,R>,handlers:Record<string,(value:unknown)=>A>,onUnmatched:(error:E)=>A):ResultTask<A,never,R>
  inspectBoth<T,E,R>(task:ResultTask<T,E,R>,onOk:(value:T)=>unknown,onErr:(error:E)=>unknown):ResultTask<T,E,R>
  tapBoth<T,E,R>(task:ResultTask<T,E,R>,onOk:(value:T)=>unknown,onErr:(error:E)=>unknown):ResultTask<T,E,R>
  toResultAsync<T,E>(task:ResultTask<T,E,never>):ResultAsync<T,E>
  acquireRelease<T>(options: object): ResultTask<T, never, never>
  scoped<T,E,R>(task:ResultTask<T,E,R>):ResultTask<T,E,R>
  fn<T>(body: () => Generator<unknown, T, unknown>, op: (task: ResultTask<T>) => ResultTask<T>): () => ResultTask<T>
}
declare function make():ResultTask<number,string>
declare function makeSync():Result<number,string>
declare function makeAsync():ResultAsync<number,string>
const mapped = make()
void ResultTask.mapError(mapped,error=>error.length)
const chained = make()
void ResultTask.flatMap(chained,()=>make())
const recovered = make()
void ResultTask.catchAll(recovered,()=>make())
const newMapped = make()
void ResultTask.mapErr(newMapped,error=>error.length)
const newChained = make()
void ResultTask.andThen(newChained,()=>make())
const newRecovered = make()
void ResultTask.orElse(newRecovered,()=>make())
const newSucceeded = make()
void ResultTask.orElseSucceed(newSucceeded,()=>0)
const newUnwrapped = make()
void ResultTask.unwrapOr(newUnwrapped,0)
const tagCaught = make()
void ResultTask.catchTag(tagCaught,"Err",()=>make())
const tagsCaught = make()
void ResultTask.catchTags(tagsCaught,{Err:()=>make()})
const reasonCaught = make()
void ResultTask.catchReason(reasonCaught,"Err","Reason",()=>make())
const reasonsCaught = make()
void ResultTask.catchReasons(reasonsCaught,"Err",{Reason:()=>make()})
const reasonUnwrapped = make()
void ResultTask.unwrapReason(reasonUnwrapped,"Err")
const filtered = make()
void ResultTask.filterOrElse(filtered,v=>v>0,()=>"neg")
const matchedTags = make()
void ResultTask.matchTags(matchedTags,{ok:()=>1,Err:()=>0})
const matchedPartial = make()
void ResultTask.matchTagsPartial(matchedPartial,{ok:()=>1},()=>0)
const taskInspectedBoth = make()
void ResultTask.inspectBoth(taskInspectedBoth,()=>{},()=>{})
const taskTappedBoth = make()
void ResultTask.tapBoth(taskTappedBoth,()=>{},()=>{})
const converted = make()
void ResultTask.toResultAsync(converted)
const syncCaught = makeSync()
void Result.catchTag(syncCaught,"Err",()=>makeSync())
const syncReasonCaught = makeSync()
void Result.catchReason(syncReasonCaught,"Err","Reason",()=>makeSync())
const syncReasonsCaught = makeSync()
void Result.catchReasons(syncReasonsCaught,"Err",{Reason:()=>makeSync()})
const syncReasonUnwrapped = makeSync()
void Result.unwrapReason(syncReasonUnwrapped,"Err")
const syncSucceeded = makeSync()
void Result.orElseSucceed(syncSucceeded,()=>0)
const syncUnwrapped = makeSync()
void Result.unwrapOr(syncUnwrapped,0)
const syncMatched = makeSync()
void Result.matchTags(syncMatched,{ok:()=>1,Err:()=>0})
const syncInspectedBoth = makeSync()
void Result.inspectBoth(syncInspectedBoth,()=>{},()=>{})
const syncAllItem = makeSync()
void Result.all([syncAllItem])
const asyncCaught = makeAsync()
void ResultAsync.catchTag(asyncCaught,"Err",()=>makeAsync())
const asyncReasonCaught = makeAsync()
void ResultAsync.catchReason(asyncReasonCaught,"Err","Reason",()=>makeAsync())
const asyncReasonsCaught = makeAsync()
void ResultAsync.catchReasons(asyncReasonsCaught,"Err",{Reason:()=>makeAsync()})
const asyncReasonUnwrapped = makeAsync()
void ResultAsync.unwrapReason(asyncReasonUnwrapped,"Err")
const asyncSucceeded = makeAsync()
void ResultAsync.orElseSucceed(asyncSucceeded,()=>0)
const asyncUnwrapped = makeAsync()
void ResultAsync.unwrapOr(asyncUnwrapped,0)
const asyncMatched = makeAsync()
void ResultAsync.matchTags(asyncMatched,{ok:()=>1,Err:()=>0})
const asyncInspectedBoth = makeAsync()
void ResultAsync.inspectBoth(asyncInspectedBoth,()=>{},()=>{})
const asyncAllItem = makeAsync()
void ResultAsync.all([asyncAllItem])
const scopedFn = ResultTask.fn(function* () {
  yield* ResultTask.acquireRelease({})
  return 1
}, ResultTask.scoped)
void scopedFn
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil || len(diagnostics) != 0 {
		t.Fatalf("open: %v %v", err, diagnostics)
	}
	findings, err := Run(context.Background(), opened.Program, opened.Directory, config.Defaults())
	if err != nil || len(findings) != 0 {
		t.Fatalf("canonical Task composition: %v %#v", err, findings)
	}
}

func TestDelegatingAssignedResultsConsumesTheChannel(t *testing.T) {
	directory := writeFixture(t, `
interface Result<T,E> {
 readonly value:T;readonly error:E
 map<U>(mapper:(value:T)=>U):Result<U,E>
 [Symbol.iterator]():Generator<Result<never,E>,T,unknown>
}
declare const Result: {gen(body:unknown):unknown}
declare function make():Result<number,string>
void Result.gen(function*(){
 const result = make()
 return yield* result
})
void Result.gen(async function*(){
 const result = make()
 return yield* result.map(value=>value+1)
})
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil || len(diagnostics) != 0 {
		t.Fatalf("open: %v %v", err, diagnostics)
	}
	findings, err := Run(context.Background(), opened.Program, opened.Directory, config.Defaults())
	if err != nil || len(findings) != 0 {
		t.Fatalf("yield* must consume assigned Result channels: %v %#v", err, findings)
	}
}

func TestTaskCollectionsAndFibersConsumeAssignedTasks(t *testing.T) {
	directory := writeFixture(t, `
interface ResultTask<T, E = never, R = never> {readonly value:T;readonly error:E;readonly requirements:R}
declare const ResultTask: {
 all(tasks:readonly ResultTask<number,string>[]|Record<string,ResultTask<number,string>>):ResultTask<number[],string>
 race(left:ResultTask<number,string>,right:ResultTask<number,string>):ResultTask<number,string>
 raceFirst(left:ResultTask<number,string>,right:ResultTask<number,string>):ResultTask<number,string>
 forkChild(task:ResultTask<number,string>):ResultTask<unknown>
}
declare function make():ResultTask<number,string>
const first = make(), second = make()
void ResultTask.all([first,second])
const recordFirst = make(), recordSecond = make()
void ResultTask.all({first:recordFirst,second:recordSecond})
const left = make(), right = make()
void ResultTask.race(left,right)
const raceFirstLeft = make(), raceFirstRight = make()
void ResultTask.raceFirst(raceFirstLeft,raceFirstRight)
const child = make()
void ResultTask.forkChild(child)
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil || len(diagnostics) != 0 {
		t.Fatalf("open: %v %v", err, diagnostics)
	}
	findings, err := Run(context.Background(), opened.Program, opened.Directory, config.Defaults())
	if err != nil || len(findings) != 0 {
		t.Fatalf("collections and fibers must consume their task inputs: %v %#v", err, findings)
	}
}
