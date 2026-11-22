package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/analyzer"
	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/project"
)

const v4CompatTypes = `
export interface Result<T, E = never> {
  readonly value: T
  readonly error: E
  map<U>(fn: (value: T) => U): Result<U, E>
  asyncMap<U>(fn: (value: T) => Promise<U>): ResultAsync<U, E>
  asyncAndThen<U, F>(fn: (value: T) => ResultAsync<U, F>): ResultAsync<U, E | F>
  tap(fn: (value: T) => void): Result<T, E>
  unwrapOr(fallback: T): T
  safeUnwrap(): Generator<Result<never, E>, T>
  match<U>(handlers: { ok: (v: T) => U; err: (e: E) => U }): U
  match<U>(handlers: { ok: (v: T) => U; error: (e: E) => U }): U
  match<U>(onOk: (v: T) => U, onErr: (e: E) => U): U
}
export interface ResultAsync<T, E = never> extends PromiseLike<Result<T, E>> {
  map<U>(fn: (value: T) => U | Promise<U>): ResultAsync<U, E>
  tap(fn: (value: T) => void): ResultAsync<T, E>
  tapError(fn: (error: E) => void): ResultAsync<T, E>
  unwrapOr(fallback: T): Promise<T>
  unwrapOrThrow(): Promise<T>
  match<U>(handlers: { ok: (v: T) => U; err: (e: E) => U }): Promise<U>
  match<U>(handlers: { ok: (v: T) => U; error: (e: E) => U }): Promise<U>
  match<U>(onOk: (v: T) => U, onErr: (e: E) => U): Promise<U>
}
export type StrictResultAsync<T, E extends Error = Error> = ResultAsync<T, E>
export interface ResultTask<A, E = never, R = never> {
  readonly _a: A
  readonly _e: E
  readonly _r: R
  flatMap<B, F, R2>(fn: (a: A) => ResultTask<B, F, R2>): ResultTask<B, E | F, R | R2>
  mapError<F>(fn: (e: E) => F): ResultTask<A, F, R>
  catchAll<B, F, R2>(fn: (e: E) => ResultTask<B, F, R2>): ResultTask<A | B, F, R | R2>
  toResultAsync(): ResultAsync<A, E>
  runResult(): ResultAsync<A, E>
  runPromise(): Promise<A>
}
export declare const ResultTask: {
  succeed<A>(value: A): ResultTask<A, never, never>
  fail<E>(error: E): ResultTask<never, E, never>
  ok<A>(value: A): ResultTask<A, never, never>
  err<E>(error: E): ResultTask<never, E, never>
  tryPromise<A, E>(opts: { try: () => Promise<A>; catch: (error: unknown) => E }): ResultTask<A, E, never>
  toResultAsync<A, E>(task: ResultTask<A, E, never>): ResultAsync<A, E>
}
export declare const Result: {
  combine<T, E>(items: readonly Result<T, E>[]): Result<T[], E>
  gen<Y, A>(body: () => AsyncGenerator<Y, A, unknown>): ResultAsync<A, unknown>
  gen<Y, A, C = never>(opts: { try: () => AsyncGenerator<Y, A, unknown>; catch?: (e: unknown) => C }): ResultAsync<A, C>
  fn<Args extends readonly unknown[], Y, A>(body: (...args: Args) => AsyncGenerator<Y, A, unknown>): (...args: Args) => ResultAsync<A, unknown>
}
export declare const ResultAsync: {
  new <T, E>(promise: Promise<Result<T, E>>): ResultAsync<T, E>
  fromTask<A, E>(task: ResultTask<A, E, never>): ResultAsync<A, E>
  retry<T, E>(fn: () => ResultAsync<T, E>, opts: object): ResultAsync<T, E>
  withResource<R, AE, T, UE>(opts: {
    acquire: () => ResultAsync<R, AE>
    use: (resource: R) => ResultAsync<T, UE>
    release: (resource: R) => void | Promise<void>
  }): ResultAsync<T, AE | UE>
  fromCallback<T, E>(opts: {
    subscribe: (ctx: { resolve: (v: T) => void; reject: (e: unknown) => void }) => void
    catch: (e: unknown) => E
  }): ResultAsync<T, E>
}
export declare function ok<T>(value: T): Result<T, never>
export declare function okAsync<T>(value: T): ResultAsync<T, never>
export declare function errAsync<E>(error: E): ResultAsync<never, E>
export declare function tryCatch<T, E>(fn: () => T, onErr: (e: unknown) => E): Result<T, E>
export declare function safeTry<T>(fn: () => Generator<unknown, Result<T, unknown>, unknown>): Result<T, unknown>
`

const v4RequestTypes = `
import type { ResultAsync, ResultTask } from "resultar"
export interface RequestJsonInput { request: Promise<Response> | ((signal?: AbortSignal) => Promise<Response>); signal?: AbortSignal }
export interface RequestJsonTaskInput { request: (signal?: AbortSignal) => Promise<Response> }
export declare function requestJson(input: RequestJsonInput): ResultAsync<unknown, Error>
export declare function requestJsonTask(input: RequestJsonTaskInput): ResultTask<unknown, Error>
`

const v5RequestTypes = `
import type { ResultTask } from "resultar"
export interface RequestJsonInput { request: (signal?: AbortSignal) => Promise<Response> }
export declare function requestJson(input: RequestJsonInput): ResultTask<unknown, Error>
`

func writeMigrateProject(t *testing.T, source string, reqTypes string) (string, string, string) {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		"package.json":                               `{"type":"module"}`,
		"node_modules/resultar/package.json":         `{"name":"resultar","type":"module","types":"index.d.ts"}`,
		"node_modules/resultar/index.d.ts":           v4CompatTypes,
		"node_modules/resultar-request/package.json": `{"name":"resultar-request","type":"module","types":"index.d.ts"}`,
		"node_modules/resultar-request/index.d.ts":   reqTypes,
		"tsconfig.json": `{
  "compilerOptions": {
    "strict": true,
    "target": "ESNext",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}`,
		"src/app.ts": source,
	}
	for rel, content := range files {
		full := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir, filepath.Join(dir, "tsconfig.json"), filepath.Join(dir, "src", "app.ts")
}

func runMigrateJSON(t *testing.T, configPath string, extraArgs ...string) (int, []analyzer.MigrationItem) {
	t.Helper()
	stdoutFile, err := os.CreateTemp(t.TempDir(), "migrate-stdout")
	if err != nil {
		t.Fatal(err)
	}
	defer stdoutFile.Close()
	origStdout := os.Stdout
	os.Stdout = stdoutFile
	code := run(append([]string{"migrate-v5", "--project", configPath, "--json"}, extraArgs...))
	os.Stdout = origStdout
	raw, err := os.ReadFile(stdoutFile.Name())
	if err != nil {
		t.Fatal(err)
	}
	var items []analyzer.MigrationItem
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var item analyzer.MigrationItem
		if err := json.Unmarshal([]byte(line), &item); err != nil {
			t.Fatalf("unmarshal %q: %v", line, err)
		}
		items = append(items, item)
	}
	return code, items
}

func TestMigrateV5PreviewFixAndIdempotency(t *testing.T) {
	initialSource := `import { ok, okAsync, Result, ResultAsync, ResultTask, safeTry, tryCatch, type StrictResultAsync } from "resultar";
import { requestJson, requestJsonTask, type RequestJsonTaskInput } from "resultar-request";

export type MyAsync = StrictResultAsync<number, Error>;
export type MyReq = RequestJsonTaskInput;

declare function makeFallback(): number;
declare const baseTask: ResultTask<number, string>;

export const built = ResultTask.succeed(1)
  .flatMap((n) => ResultTask.fail(String(n)))
  .mapError((e) => e.toUpperCase())
  .catchAll(() => ResultTask.succeed(42));

export const eagerBridge = baseTask.toResultAsync();
export const staticBridge = ResultTask.toResultAsync(baseTask);
export const unwrapped = baseTask.runResult().unwrapOrThrow();
export const matched = baseTask.runResult().match((v) => v + 1, () => 0);
export const safeFallback = baseTask.runResult().unwrapOr(0);
export const riskyFallback = baseTask.runResult().unwrapOr(makeFallback());
export const chained = baseTask.runResult().map((n) => n * 2);
export const combined = Result.combine([ok(1)]);
export const asyncGen = Result.gen(async function* () {
  return 1;
});
export const mappedAsync = ok(1).asyncMap(async (n) => n + 1);
export const legacyMatch = ok(1).match({ ok: (n) => n, error: () => 0 });
export const taskReq = requestJsonTask({ request: () => fetch("https://example.com") });
export const eagerReq = requestJson({ request: fetch("https://example.com"), signal: new AbortController().signal });
export const retried = ResultAsync.retry(() => okAsync(1), {});
export const legacySafeTry = safeTry(function* () {
  const n = yield* ok(1).safeUnwrap();
  return ok(n);
});
export const legacyTryCatch = tryCatch(() => 1, (e) => String(e));
export const tapped = ok(1).tap(() => {});
`
	_, configPath, appPath := writeMigrateProject(t, initialSource, v4RequestTypes)

	// 1. Preview mode must leave the source file byte-identical while reporting edits and reviews.
	code, previewItems := runMigrateJSON(t, configPath)
	if code != 0 {
		t.Fatalf("preview exit code = %d, want 0", code)
	}
	afterPreviewBytes, err := os.ReadFile(appPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(afterPreviewBytes) != initialSource {
		t.Fatalf("preview mode modified %s!", appPath)
	}

	previewEdits := 0
	previewReviews := map[string]bool{}
	for _, item := range previewItems {
		if item.Kind == analyzer.MigrationEdit {
			previewEdits++
		} else if item.Kind == analyzer.MigrationReview {
			previewReviews[item.Category] = true
		}
	}
	if previewEdits == 0 {
		t.Fatalf("expected mechanical edits in preview, got 0")
	}
	for _, wantReview := range []string{
		"removed-v4-import",
		"run-result-unwrap-or-order",
		"request-json-v5-contract",
		"deprecated-result-async-helper",
		"deprecated-safe-try",
		"removed-result-tap",
	} {
		if !previewReviews[wantReview] {
			t.Errorf("missing expected manual review category %q (got: %v)", wantReview, previewReviews)
		}
	}

	// 2. --fix mode applies mechanical edits and keeps manual review items listed.
	code, fixItems := runMigrateJSON(t, configPath, "--fix")
	if code != 0 {
		t.Fatalf("fix exit code = %d, want 0", code)
	}
	fixReviews := map[string]bool{}
	appliedCount := 0
	for _, item := range fixItems {
		if item.Kind == analyzer.MigrationEdit && item.Applied {
			appliedCount++
		}
		if item.Kind == analyzer.MigrationReview {
			fixReviews[item.Category] = true
		}
	}
	if appliedCount == 0 {
		t.Fatalf("expected applied edits in --fix mode")
	}
	if len(fixReviews) != len(previewReviews) {
		t.Fatalf("preview reviews %v != fix reviews %v", previewReviews, fixReviews)
	}

	migratedBytes, err := os.ReadFile(appPath)
	if err != nil {
		t.Fatal(err)
	}
	migrated := string(migratedBytes)

	for _, wantSnippet := range []string{
		`from "resultar/async";`,
		`import { requestJson, type RequestJsonInput } from "resultar-request";`,
		`ResultTask.ok(1)`,
		`.andThen((n) => ResultTask.err(String(n)))`,
		`.mapErr((e) => e.toUpperCase())`,
		`.orElse(() => ResultTask.ok(42))`,
		`export const eagerBridge = ResultAsync.fromTask(baseTask);`,
		`export const staticBridge = ResultAsync.fromTask(baseTask);`,
		`export const unwrapped = baseTask.runPromise();`,
		`export const matched = baseTask.runResult().then((r) => r.match((v) => v + 1, () => 0));`,
		`export const safeFallback = baseTask.runResult().then((r) => r.unwrapOr(0));`,
		`export const chained = new ResultAsync(baseTask.runResult()).map((n) => n * 2);`,
		`export const combined = Result.all([ok(1)]);`,
		`export const asyncGen = ResultAsync.gen(async function* () {`,
		`export const mappedAsync = asyncMap(ok(1), async (n) => n + 1);`,
		`export const legacyMatch = ok(1).match({ ok: (n) => n, err: () => 0 });`,
		`export const taskReq = requestJson({ request: () => fetch("https://example.com") });`,
		`const n = yield* ok(1);`,
	} {
		if !strings.Contains(migrated, wantSnippet) {
			t.Errorf("migrated output missing %q.\nFull migrated file:\n%s", wantSnippet, migrated)
		}
	}

	// 3. Idempotency: a second invocation must produce zero mechanical edits.
	code, secondPass := runMigrateJSON(t, configPath)
	if code != 0 {
		t.Fatalf("second pass exit code = %d, want 0", code)
	}
	for _, item := range secondPass {
		if item.Kind == analyzer.MigrationEdit {
			t.Errorf("expected 0 mechanical edits on second run (idempotent), got: %#v", item)
		}
	}
}

func TestMigrateV5EagerRequestJsonOpaqueOptions(t *testing.T) {
	source := `import { requestJson, type RequestJsonInput } from "resultar-request";
import * as req from "resultar-request";

declare const options: RequestJsonInput;

export async function runOpaque() {
  const pending = requestJson(options);
  return await pending;
}

export async function runFactoryOnly() {
  return await requestJson({ request: () => fetch("https://example.com") });
}

export async function runSpread() {
  return await requestJson({ ...options });
}

export async function runNamespace() {
  return await req.requestJson(options);
}
`
	_, configPath, _ := writeMigrateProject(t, source, v4RequestTypes)
	code, items := runMigrateJSON(t, configPath)
	if code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	reviews := 0
	for _, item := range items {
		if item.Kind == analyzer.MigrationReview && item.Category == "request-json-v5-contract" {
			reviews++
		}
	}
	if reviews != 4 {
		t.Fatalf("expected 4 request-json-v5-contract reviews (opaque, factory-only, spread, namespace), got %d: %#v", reviews, items)
	}

	// When already on v5 Task-native declarations, requestJson(options) must NOT emit eager reviews.
	v5Source := `import { requestJson, type RequestJsonInput } from "resultar-request";
declare const options: RequestJsonInput;
export const task = requestJson(options);
`
	_, v5ConfigPath, _ := writeMigrateProject(t, v5Source, v5RequestTypes)
	code, v5Items := runMigrateJSON(t, v5ConfigPath)
	if code != 0 {
		t.Fatalf("v5 exit code = %d, want 0", code)
	}
	if len(v5Items) != 0 {
		t.Fatalf("expected 0 items for already-v5 requestJson, got %#v", v5Items)
	}
}

func TestMigrateV5MutableFallbackAndHandlers(t *testing.T) {
	source := `import type { ResultTask } from "resultar";

declare const task: ResultTask<string, Error>;
const stableFallback = "stable";
const stableOnOk = (v: string) => v;

export async function mutableFallback() {
  let fallback = "before";
  const pending = task.runResult().unwrapOr(fallback);
  fallback = "after";
  return await pending;
}

export async function parameterFallback(fallback: string) {
  const pending = task.runResult().unwrapOr(fallback);
  fallback = "mutated-param";
  return await pending;
}

export async function immutableConstFallback() {
  return await task.runResult().unwrapOr(stableFallback);
}

export async function mutableHandler() {
  let onOk = (v: string) => v;
  const pending = task.runResult().match(onOk, () => "err");
  onOk = () => "mutated";
  return await pending;
}

export async function mutableShorthandHandler() {
  let ok = (v: string) => v;
  const pending = task.runResult().match({ ok, err: () => "err" });
  ok = () => "mutated";
  return await pending;
}

export async function immutableConstHandler() {
  return await task.runResult().match(stableOnOk, () => "err");
}
`
	_, configPath, appPath := writeMigrateProject(t, source, v4RequestTypes)
	code, items := runMigrateJSON(t, configPath, "--fix")
	if code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}

	editCount := 0
	unwrapReviews := 0
	matchReviews := 0
	for _, item := range items {
		if item.Kind == analyzer.MigrationEdit {
			editCount++
		}
		if item.Kind == analyzer.MigrationReview && item.Category == "run-result-unwrap-or-order" {
			unwrapReviews++
		}
		if item.Kind == analyzer.MigrationReview && item.Category == "run-result-match-order" {
			matchReviews++
		}
	}
	if editCount != 2 {
		t.Fatalf("expected exactly 2 safe edits (stableFallback & stableOnOk), got %d: %#v", editCount, items)
	}
	if unwrapReviews != 2 {
		t.Fatalf("expected 2 run-result-unwrap-or-order reviews (let & param), got %d: %#v", unwrapReviews, items)
	}
	if matchReviews != 2 {
		t.Fatalf("expected 2 run-result-match-order reviews (let arg & let shorthand), got %d: %#v", matchReviews, items)
	}

	afterBytes, err := os.ReadFile(appPath)
	if err != nil {
		t.Fatal(err)
	}
	after := string(afterBytes)
	if strings.Contains(after, "r.unwrapOr(fallback)") {
		t.Fatalf("must NOT rewrite mutable fallback into .then():\n%s", after)
	}
	if !strings.Contains(after, "task.runResult().then((r) => r.unwrapOr(stableFallback))") {
		t.Fatalf("expected stable const fallback to rewrite cleanly:\n%s", after)
	}
	if !strings.Contains(after, "task.runResult().then((r) => r.match(stableOnOk, () => \"err\"))") {
		t.Fatalf("expected stable const handler to rewrite cleanly:\n%s", after)
	}
}

func TestMigrateV5SymbolResolutionAndAliases(t *testing.T) {
	source := `import { ResultAsync as Eager, ResultTask as RT, Result, type ResultTask } from "resultar";
import { requestJsonTask } from "resultar-request";

declare const baseTask: ResultTask<number, string>;

// 1. Local parameter named ResultTask must NEVER be treated as Resultar's ResultTask
export function localShadow(ResultTask: { succeed(n: number): number; runResult(): { unwrapOrThrow(): number } }) {
  const a = ResultTask.succeed(1);
  const b = ResultTask.runResult().unwrapOrThrow();
  return a + b;
}

// 2. Local variable shadowing requestJsonTask must NOT be renamed, while real import IS renamed
export function shadowRequest(requestJsonTask: number) {
  return requestJsonTask + 1;
}
export const realRequest = requestJsonTask({ request: () => fetch("https://example.com") });

// 3. Aliased ResultTask import IS rewritten via symbol resolution
export const realTask = RT.succeed(42);

// 4. Aliased ResultAsync import MUST be reused as Eager (not undefined ResultAsync)
export const chained = baseTask.runResult().map((n) => n * 2);
export const bridged = baseTask.toResultAsync();
export const staticBridged = RT.toResultAsync(baseTask);
export const asyncGen = Result.gen(async function* () {
  return 1;
});
`
	_, configPath, appPath := writeMigrateProject(t, source, v4RequestTypes)
	code, _ := runMigrateJSON(t, configPath, "--fix")
	if code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	afterBytes, err := os.ReadFile(appPath)
	if err != nil {
		t.Fatal(err)
	}
	after := string(afterBytes)

	for _, mustKeep := range []string{
		`const a = ResultTask.succeed(1);`,
		`const b = ResultTask.runResult().unwrapOrThrow();`,
		`export function shadowRequest(requestJsonTask: number) {`,
		`return requestJsonTask + 1;`,
		`export const realRequest = requestJson({ request: () => fetch("https://example.com") });`,
		`export const realTask = RT.ok(42);`,
		`export const chained = new Eager(baseTask.runResult()).map((n) => n * 2);`,
		`export const bridged = Eager.fromTask(baseTask);`,
		`export const staticBridged = Eager.fromTask(baseTask);`,
		`export const asyncGen = Eager.gen(async function* () {`,
		`import { ResultAsync as Eager } from "resultar/async";`,
	} {
		if !strings.Contains(after, mustKeep) {
			t.Errorf("migrated output missing %q.\nFull migrated file:\n%s", mustKeep, after)
		}
	}
	if strings.Contains(after, "new ResultAsync(") || strings.Contains(after, "ResultAsync.fromTask(") || strings.Contains(after, "ResultAsync.gen(") {
		t.Errorf("migrated output generated unaliased ResultAsync when ResultAsync was imported as Eager:\n%s", after)
	}
}

func findBuiltResultarDir(t *testing.T) string {
	t.Helper()
	resultarDir, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "resultar"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(resultarDir, "dist", "async.d.ts")); err != nil {
		t.Skipf("skipping real v5 package verification (dist not built at %s): %v", resultarDir, err)
	}
	return resultarDir
}

func findWorkspaceTsc(t *testing.T, resultarDir string) string {
	t.Helper()
	candidates := []string{
		filepath.Join(resultarDir, "node_modules", ".bin", "tsc"),
		filepath.Join(resultarDir, "..", "..", "node_modules", ".pnpm", "node_modules", ".bin", "tsc"),
		filepath.Join(resultarDir, "..", "..", "node_modules", ".bin", "tsc"),
	}
	for _, c := range candidates {
		if info, err := os.Stat(c); err == nil && !info.IsDir() {
			return c
		}
	}
	if p, err := exec.LookPath("tsc"); err == nil {
		return p
	}
	t.Fatalf("unable to locate tsc binary in workspace or PATH")
	return ""
}

func swapToRealV5Resultar(t *testing.T, dir, resultarDir string) {
	t.Helper()
	nmResultar := filepath.Join(dir, "node_modules", "resultar")
	if err := os.RemoveAll(nmResultar); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(resultarDir, nmResultar); err != nil {
		t.Fatal(err)
	}
}

// installV4RuntimeAdapter installs a v4-semantics ESM wrapper in node_modules/resultar
// backed by the real built dist/index.js + dist/async.js so a consumer can actually be
// executed under Node.js BEFORE `--fix` (with eager `task.runResult()` returning
// `ResultAsync.fromTask(task)` and root `resultar` exporting `ResultAsync`/`okAsync`/etc.).
func installV4RuntimeAdapter(t *testing.T, dir, resultarDir string) {
	t.Helper()
	nmResultar := filepath.Join(dir, "node_modules", "resultar")
	if err := os.MkdirAll(nmResultar, 0o755); err != nil {
		t.Fatal(err)
	}
	distIndex := filepath.ToSlash(filepath.Join(resultarDir, "dist", "index.js"))
	distAsync := filepath.ToSlash(filepath.Join(resultarDir, "dist", "async.js"))

	pkgJSON := `{
  "name": "resultar",
  "type": "module",
  "main": "./index.js",
  "types": "./index.d.ts",
  "exports": {
    ".": { "types": "./index.d.ts", "import": "./index.js" }
  }
}`
	runtimeJS := fmt.Sprintf(`import * as core from %q;
import * as asyncMod from %q;

function wrapTaskV4(task) {
  return new Proxy(task, {
    get(target, prop, receiver) {
      if (prop === "runResult") {
        return (...args) => new asyncMod.ResultAsync(target.runResult(...args));
      }
      if (prop === "toResultAsync") {
        return () => asyncMod.ResultAsync.fromTask(target);
      }
      const val = Reflect.get(target, prop, target);
      if (typeof val === "function") {
        return (...args) => {
          const out = val.apply(target, args);
          if (out && typeof out === "object" && typeof out.runResult === "function" && typeof out.runPromise === "function") {
            return wrapTaskV4(out);
          }
          return out;
        };
      }
      return val;
    },
  });
}

export const Result = {
  ...core.Result,
  combine: core.Result.all,
  gen: (input) => {
    const fn = typeof input === "function" ? input : input.try;
    const res = fn();
    if (res && typeof res[Symbol.asyncIterator] === "function") {
      return asyncMod.ResultAsync.gen(input);
    }
    return core.Result.gen(input);
  },
  fn: (body, ...pipes) => (...args) => {
    const probe = body(...args);
    if (probe && typeof probe[Symbol.asyncIterator] === "function") {
      return asyncMod.ResultAsync.fn(body, ...pipes)(...args);
    }
    return core.Result.fn(body, ...pipes)(...args);
  },
};

export const ResultTask = {
  ...core.ResultTask,
  succeed: (v) => wrapTaskV4(core.ResultTask.ok(v)),
  fail: (e) => wrapTaskV4(core.ResultTask.err(e)),
  ok: (v) => wrapTaskV4(core.ResultTask.ok(v)),
  err: (e) => wrapTaskV4(core.ResultTask.err(e)),
  tryPromise: (opts) => wrapTaskV4(core.ResultTask.tryPromise(opts)),
  toResultAsync: (t) => asyncMod.ResultAsync.fromTask(t),
};

export const { ok, err } = core;
export const { ResultAsync, okAsync, errAsync, asyncMap, asyncAndThen, safeTry } = asyncMod;
`, distIndex, distAsync)

	if err := os.WriteFile(filepath.Join(nmResultar, "package.json"), []byte(pkgJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nmResultar, "index.js"), []byte(runtimeJS), 0o644); err != nil {
		t.Fatal(err)
	}
}

func assertZeroTypeScriptDiagnostics(t *testing.T, configPath, appPath string) {
	t.Helper()
	opened, programDiags, err := project.Open(configPath)
	if err != nil {
		t.Fatalf("project.Open failed: %v", err)
	}
	ctx := context.Background()
	synDiags := opened.Program.GetSyntacticDiagnostics(ctx, nil)
	semDiags := opened.Program.GetSemanticDiagnostics(ctx, nil)

	if len(programDiags) > 0 || len(synDiags) > 0 || len(semDiags) > 0 {
		migratedBytes, _ := os.ReadFile(appPath)
		var msgs []string
		for _, d := range programDiags {
			msgs = append(msgs, fmt.Sprintf("[program] %s", d))
		}
		for _, d := range synDiags {
			msgs = append(msgs, fmt.Sprintf("[syntactic TS%d] %s", d.Code(), d.String()))
		}
		for _, d := range semDiags {
			msgs = append(msgs, fmt.Sprintf("[semantic TS%d] %s", d.Code(), d.String()))
		}
		t.Fatalf("TypeScript diagnostics found:\n%s\n\nFile (%s):\n%s", strings.Join(msgs, "\n"), appPath, string(migratedBytes))
	}
}

func runRealTscNoEmit(t *testing.T, dir, resultarDir, appPath string) {
	t.Helper()
	tscBin := findWorkspaceTsc(t, resultarDir)
	cmd := exec.Command(tscBin, "--noEmit", "-p", filepath.Join(dir, "tsconfig.json"))
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		migratedBytes, _ := os.ReadFile(appPath)
		t.Fatalf("tsc --noEmit failed (%v):\n%s\n\nFile (%s):\n%s", err, string(out), appPath, string(migratedBytes))
	}
}

func runNodeTS(t *testing.T, dir, scriptRelPath string) string {
	t.Helper()
	nodeBin, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not found in PATH: %v", err)
	}
	cmd := exec.Command(nodeBin, scriptRelPath)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("node %s failed (%v):\n%s", scriptRelPath, err, string(out))
	}
	return strings.TrimSpace(string(out))
}

func TestMigrateV5CoercedMutableObjectFallback(t *testing.T) {
	resultarDir := findBuiltResultarDir(t)
	source := `import { ResultTask } from "resultar";

const delayedErr = ResultTask.tryPromise({
  try: async () => {
    await Promise.resolve();
    throw new Error("boom");
  },
  catch: (e) => (e instanceof Error ? e : new Error(String(e))),
});

export async function coercedDateFallback() {
  const deadline = new Date(1000);
  const pending = delayedErr.runResult().unwrapOr(+deadline);
  deadline.setTime(2000);
  return await pending;
}

export async function coercedCustomObjectFallback() {
  let current = 10;
  const box = { valueOf: () => current };
  const pending = delayedErr.runResult().unwrapOr(-box);
  current = 20;
  return await pending;
}

export async function safePrimitiveUnaryFallback() {
  const n = 1000;
  return await delayedErr.runResult().unwrapOr(-n);
}
`
	dir, configPath, appPath := writeMigrateProject(t, source, v4RequestTypes)
	installV4RuntimeAdapter(t, dir, resultarDir)

	// Confirm the v4 consumer executes BEFORE --fix and returns 1000 (not 2000) for +deadline.
	beforeRunner := `import { coercedDateFallback, coercedCustomObjectFallback, safePrimitiveUnaryFallback } from "./src/app.ts";
console.log(JSON.stringify({
  date: await coercedDateFallback(),
  custom: await coercedCustomObjectFallback(),
  primitive: await safePrimitiveUnaryFallback(),
}));
`
	if err := os.WriteFile(filepath.Join(dir, "run.mjs"), []byte(beforeRunner), 0o644); err != nil {
		t.Fatal(err)
	}
	beforeOut := runNodeTS(t, dir, "run.mjs")
	if beforeOut != `{"date":1000,"custom":-10,"primitive":-1000}` {
		t.Fatalf("unexpected v4 baseline runtime output: %s", beforeOut)
	}

	code, items := runMigrateJSON(t, configPath, "--fix")
	if code != 0 {
		t.Fatalf("migrate-v5 --fix exit code = %d, want 0", code)
	}

	edits := 0
	unwrapReviews := 0
	for _, item := range items {
		if item.Kind == analyzer.MigrationEdit {
			edits++
		}
		if item.Kind == analyzer.MigrationReview && item.Category == "run-result-unwrap-or-order" {
			unwrapReviews++
		}
	}
	if edits != 1 {
		t.Fatalf("expected exactly 1 safe edit (primitive -n), got %d: %#v", edits, items)
	}
	if unwrapReviews != 2 {
		t.Fatalf("expected 2 run-result-unwrap-or-order reviews (+deadline and -box), got %d: %#v", unwrapReviews, items)
	}

	afterBytes, err := os.ReadFile(appPath)
	if err != nil {
		t.Fatal(err)
	}
	after := string(afterBytes)
	if strings.Contains(after, "r.unwrapOr(+deadline)") || strings.Contains(after, "r.unwrapOr(-box)") {
		t.Fatalf("must NOT rewrite mutable object unary coercions into .then():\n%s", after)
	}
	if !strings.Contains(after, "delayedErr.runResult().then((r) => r.unwrapOr(-n))") {
		t.Fatalf("expected safe primitive unary fallback (-n) to be autofixed:\n%s", after)
	}
}

func TestMigrateV5StrictResultAsyncReturnContract(t *testing.T) {
	resultarDir := findBuiltResultarDir(t)
	source := `import { ResultTask, type Result, type ResultAsync, type StrictResultAsync } from "resultar";

const baseTask = ResultTask.ok(42);

export const lookup = (): StrictResultAsync<number, Error> => baseTask.runResult();

export function load(): ResultAsync<number, Error> {
  return baseTask.runResult();
}

export const service: { get: () => StrictResultAsync<number, Error>; block: () => StrictResultAsync<number, Error> } = {
  get: () => baseTask.runResult(),
  block: () => {
    return baseTask.runResult();
  },
};

export const typedVar: StrictResultAsync<number, Error> = baseTask.runResult();

export async function localChained() {
  const pending = baseTask.runResult();
  return await pending.map((n) => n * 2);
}

export async function awaitedOnly() {
  return await baseTask.runResult();
}

export const promiseReturn = (): Promise<Result<number, never>> => baseTask.runResult();

export const unannotatedExport = () => baseTask.runResult();
`
	dir, configPath, appPath := writeMigrateProject(t, source, v4RequestTypes)
	installV4RuntimeAdapter(t, dir, resultarDir)

	runner := `import { lookup, load, service, typedVar, localChained, awaitedOnly, promiseReturn } from "./src/app.ts";
console.log(JSON.stringify({
  lookup: await lookup().unwrapOr(0),
  load: await load().unwrapOr(0),
  service: await service.get().unwrapOr(0),
  serviceBlock: await service.block().unwrapOr(0),
  typedVar: await typedVar.unwrapOr(0),
  localChained: (await localChained()).unwrapOr(0),
  awaitedOnly: (await awaitedOnly()).unwrapOr(0),
  promiseReturn: (await promiseReturn()).unwrapOr(0),
}));
`
	if err := os.WriteFile(filepath.Join(dir, "run.mjs"), []byte(runner), 0o644); err != nil {
		t.Fatal(err)
	}
	beforeOut := runNodeTS(t, dir, "run.mjs")

	code, items := runMigrateJSON(t, configPath, "--fix")
	if code != 0 {
		t.Fatalf("migrate-v5 --fix exit code = %d, want 0", code)
	}

	foundExportedReview := false
	for _, item := range items {
		if item.Kind == analyzer.MigrationReview && item.Category == "run-result-exported-contract" {
			foundExportedReview = true
		}
	}
	if !foundExportedReview {
		t.Fatalf("expected run-result-exported-contract review for unannotatedExport, got: %#v", items)
	}

	// Pass 2 idempotency on v4 types (before upgrading node_modules/resultar) must produce 0 edits.
	code, secondPass := runMigrateJSON(t, configPath)
	if code != 0 {
		t.Fatalf("second pass exit code = %d, want 0", code)
	}
	for _, item := range secondPass {
		if item.Kind == analyzer.MigrationEdit {
			t.Errorf("expected 0 edits on second pass, got: %#v", item)
		}
	}

	afterBytes, err := os.ReadFile(appPath)
	if err != nil {
		t.Fatal(err)
	}
	after := string(afterBytes)
	for _, want := range []string{
		`export const lookup = (): StrictResultAsync<number, Error> => new ResultAsync(baseTask.runResult());`,
		`return new ResultAsync(baseTask.runResult());`,
		`get: () => new ResultAsync(baseTask.runResult()),`,
		`export const typedVar: StrictResultAsync<number, Error> = new ResultAsync(baseTask.runResult());`,
		`const pending = new ResultAsync(baseTask.runResult());`,
		`return await baseTask.runResult();`,
		`export const promiseReturn = (): Promise<Result<number, never>> => baseTask.runResult();`,
	} {
		if !strings.Contains(after, want) {
			t.Errorf("migrated output missing %q.\nFull file:\n%s", want, after)
		}
	}

	// Swap to real built v5 package -> must pass TypeScript-Go semantic diagnostics, real tsc --noEmit, AND match v4 runtime output!
	swapToRealV5Resultar(t, dir, resultarDir)
	assertZeroTypeScriptDiagnostics(t, configPath, appPath)
	runRealTscNoEmit(t, dir, resultarDir, appPath)

	// Pass 2 idempotency against v5 types too!
	code, v5SecondPass := runMigrateJSON(t, configPath)
	if code != 0 {
		t.Fatalf("v5 second pass exit code = %d, want 0", code)
	}
	for _, item := range v5SecondPass {
		if item.Kind == analyzer.MigrationEdit {
			t.Errorf("expected 0 edits on v5 second pass, got: %#v", item)
		}
	}

	afterOut := runNodeTS(t, dir, "run.mjs")
	if afterOut != beforeOut {
		t.Fatalf("runtime behavior changed after migration!\nbefore: %s\nafter:  %s", beforeOut, afterOut)
	}
}

func TestMigrateV5RunResultLegacyMatchSinglePass(t *testing.T) {
	resultarDir := findBuiltResultarDir(t)
	source := `import { ResultTask } from "resultar";

const okTask = ResultTask.ok(10);
const errTask = ResultTask.err("boom");

const ok = (v: number) => v + 1;
const error = (e: string) => e.length;

export const propStyleOk = () => okTask.runResult().match({ ok: (v) => v + 1, error: () => -1 });
export const propStyleErr = () => errTask.runResult().match({ ok: () => 0, error: (e) => e.length });
export const shorthandErr = () => errTask.runResult().match({ ok, error });
export const methodStyleErr = () => errTask.runResult().match({
  ok(v) { return { error: String(v) }; },
  error(e) { return { error: e.toUpperCase() }; },
});
`
	dir, configPath, appPath := writeMigrateProject(t, source, v4RequestTypes)
	installV4RuntimeAdapter(t, dir, resultarDir)

	runner := `import { propStyleOk, propStyleErr, shorthandErr, methodStyleErr } from "./src/app.ts";
console.log(JSON.stringify({
  propStyleOk: await propStyleOk(),
  propStyleErr: await propStyleErr(),
  shorthandErr: await shorthandErr(),
  methodStyleErr: await methodStyleErr(),
}));
`
	if err := os.WriteFile(filepath.Join(dir, "run.mjs"), []byte(runner), 0o644); err != nil {
		t.Fatal(err)
	}
	beforeOut := runNodeTS(t, dir, "run.mjs")

	// SINGLE --fix pass must rewrite runResult().match({ ok, error }) -> .then((r) => r.match({ ok, err })) immediately!
	code, _ := runMigrateJSON(t, configPath, "--fix")
	if code != 0 {
		t.Fatalf("migrate-v5 --fix exit code = %d, want 0", code)
	}

	afterBytes, err := os.ReadFile(appPath)
	if err != nil {
		t.Fatal(err)
	}
	after := string(afterBytes)
	for _, want := range []string{
		`okTask.runResult().then((r) => r.match({ ok: (v) => v + 1, err: () => -1 }))`,
		`errTask.runResult().then((r) => r.match({ ok: () => 0, err: (e) => e.length }))`,
		`errTask.runResult().then((r) => r.match({ ok, err: error }))`,
		`ok(v) { return { error: String(v) }; },`,
		`err(e) { return { error: e.toUpperCase() }; },`,
	} {
		if !strings.Contains(after, want) {
			t.Errorf("single-pass output missing %q.\nFull file:\n%s", want, after)
		}
	}

	// Swap to real built v5 package -> must pass semantic diagnostics & real tsc --noEmit on Pass 1 (no TS2561!)
	swapToRealV5Resultar(t, dir, resultarDir)
	assertZeroTypeScriptDiagnostics(t, configPath, appPath)
	runRealTscNoEmit(t, dir, resultarDir, appPath)

	// Pass 2 must emit 0 edits (proving single-pass convergence!)
	code, secondPass := runMigrateJSON(t, configPath)
	if code != 0 {
		t.Fatalf("second pass exit code = %d, want 0", code)
	}
	for _, item := range secondPass {
		if item.Kind == analyzer.MigrationEdit {
			t.Errorf("expected 0 edits on second pass (single-pass match rewrite), got: %#v", item)
		}
	}

	afterOut := runNodeTS(t, dir, "run.mjs")
	if afterOut != beforeOut {
		t.Fatalf("runtime behavior changed after single-pass match migration!\nbefore: %s\nafter:  %s", beforeOut, afterOut)
	}
}

func TestMigrateV5LocalResultAsyncCollisionAndNamespaceImports(t *testing.T) {
	resultarDir := findBuiltResultarDir(t)

	t.Run("local ResultAsync collision", func(t *testing.T) {
		source := `import { ResultTask, type StrictResultAsync } from "resultar";

export const ResultAsync = { custom: true } as const;
const baseTask = ResultTask.ok(21);

export const chained = baseTask.runResult().map((n) => n * 2);
export const lookup = (): StrictResultAsync<number, Error> => baseTask.runResult();
`
		dir, configPath, appPath := writeMigrateProject(t, source, v4RequestTypes)
		installV4RuntimeAdapter(t, dir, resultarDir)

		runner := `import { ResultAsync, chained, lookup } from "./src/app.ts";
console.log(JSON.stringify({
  custom: ResultAsync.custom,
  chained: (await chained).unwrapOr(0),
  lookup: await lookup().unwrapOr(0),
}));
`
		if err := os.WriteFile(filepath.Join(dir, "run.mjs"), []byte(runner), 0o644); err != nil {
			t.Fatal(err)
		}
		beforeOut := runNodeTS(t, dir, "run.mjs")

		code, _ := runMigrateJSON(t, configPath, "--fix")
		if code != 0 {
			t.Fatalf("migrate-v5 --fix exit code = %d, want 0", code)
		}
		afterBytes, err := os.ReadFile(appPath)
		if err != nil {
			t.Fatal(err)
		}
		after := string(afterBytes)
		if !strings.Contains(after, "ResultAsync as ResultarResultAsync") || !strings.Contains(after, "new ResultarResultAsync(") {
			t.Fatalf("expected aliased ResultarResultAsync import & constructor to avoid TS2440 collision:\n%s", after)
		}

		swapToRealV5Resultar(t, dir, resultarDir)
		assertZeroTypeScriptDiagnostics(t, configPath, appPath)
		runRealTscNoEmit(t, dir, resultarDir, appPath)

		code, secondPass := runMigrateJSON(t, configPath)
		if code != 0 {
			t.Fatalf("second pass exit code = %d, want 0", code)
		}
		for _, item := range secondPass {
			if item.Kind == analyzer.MigrationEdit {
				t.Errorf("expected 0 edits on second pass, got: %#v", item)
			}
		}

		afterOut := runNodeTS(t, dir, "run.mjs")
		if afterOut != beforeOut {
			t.Fatalf("runtime behavior changed!\nbefore: %s\nafter:  %s", beforeOut, afterOut)
		}
	})

	t.Run("namespace import eager-only with noUnusedLocals", func(t *testing.T) {
		source := `import * as R from "resultar";

export const five = R.okAsync(5);
export type MyAsync = R.StrictResultAsync<number, Error>;
`
		dir, configPath, appPath := writeMigrateProject(t, source, v4RequestTypes)
		// Enable noUnusedLocals to verify replacing `import * as R` does not leave TS6133 behind!
		strictTsconfig := `{
  "compilerOptions": {
    "strict": true,
    "noUnusedLocals": true,
    "target": "ESNext",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}`
		if err := os.WriteFile(configPath, []byte(strictTsconfig), 0o644); err != nil {
			t.Fatal(err)
		}
		installV4RuntimeAdapter(t, dir, resultarDir)

		runner := `import { five } from "./src/app.ts";
console.log(JSON.stringify({ five: (await five).unwrapOr(0) }));
`
		if err := os.WriteFile(filepath.Join(dir, "run.mjs"), []byte(runner), 0o644); err != nil {
			t.Fatal(err)
		}
		beforeOut := runNodeTS(t, dir, "run.mjs")

		code, _ := runMigrateJSON(t, configPath, "--fix")
		if code != 0 {
			t.Fatalf("migrate-v5 --fix exit code = %d, want 0", code)
		}
		afterBytes, err := os.ReadFile(appPath)
		if err != nil {
			t.Fatal(err)
		}
		after := string(afterBytes)
		if !strings.Contains(after, `import * as RAsync from "resultar/async";`) || !strings.Contains(after, `RAsync.okAsync(5)`) || !strings.Contains(after, `RAsync.StrictResultAsync<number, Error>`) {
			t.Fatalf("expected namespace import to move cleanly to RAsync from resultar/async:\n%s", after)
		}
		if strings.Contains(after, `from "resultar";`) {
			t.Fatalf("expected unused `import * as R from \"resultar\"` to be replaced:\n%s", after)
		}

		swapToRealV5Resultar(t, dir, resultarDir)
		assertZeroTypeScriptDiagnostics(t, configPath, appPath)
		runRealTscNoEmit(t, dir, resultarDir, appPath)

		code, secondPass := runMigrateJSON(t, configPath)
		if code != 0 {
			t.Fatalf("second pass exit code = %d, want 0", code)
		}
		for _, item := range secondPass {
			if item.Kind == analyzer.MigrationEdit {
				t.Errorf("expected 0 edits on second pass, got: %#v", item)
			}
		}

		afterOut := runNodeTS(t, dir, "run.mjs")
		if afterOut != beforeOut {
			t.Fatalf("runtime behavior changed!\nbefore: %s\nafter:  %s", beforeOut, afterOut)
		}
	})

	t.Run("namespace import mixed sync and eager", func(t *testing.T) {
		source := `import * as R from "resultar";

export const syncVal = R.ok(1);
export const asyncVal = R.okAsync(5);
export const taskVal = R.ResultTask.succeed(7);
export const lookup = (): R.StrictResultAsync<number, Error> => taskVal.runResult();
`
		dir, configPath, appPath := writeMigrateProject(t, source, v4RequestTypes)
		installV4RuntimeAdapter(t, dir, resultarDir)

		runner := `import { syncVal, asyncVal, taskVal, lookup } from "./src/app.ts";
console.log(JSON.stringify({
  syncVal: syncVal.unwrapOr(0),
  asyncVal: (await asyncVal).unwrapOr(0),
  taskVal: await taskVal.runPromise(),
  lookup: await lookup().unwrapOr(0),
}));
`
		if err := os.WriteFile(filepath.Join(dir, "run.mjs"), []byte(runner), 0o644); err != nil {
			t.Fatal(err)
		}
		beforeOut := runNodeTS(t, dir, "run.mjs")

		code, _ := runMigrateJSON(t, configPath, "--fix")
		if code != 0 {
			t.Fatalf("migrate-v5 --fix exit code = %d, want 0", code)
		}

		swapToRealV5Resultar(t, dir, resultarDir)
		assertZeroTypeScriptDiagnostics(t, configPath, appPath)
		runRealTscNoEmit(t, dir, resultarDir, appPath)

		code, secondPass := runMigrateJSON(t, configPath)
		if code != 0 {
			t.Fatalf("second pass exit code = %d, want 0", code)
		}
		for _, item := range secondPass {
			if item.Kind == analyzer.MigrationEdit {
				t.Errorf("expected 0 edits on second pass, got: %#v", item)
			}
		}

		afterOut := runNodeTS(t, dir, "run.mjs")
		if afterOut != beforeOut {
			t.Fatalf("runtime behavior changed!\nbefore: %s\nafter:  %s", beforeOut, afterOut)
		}
	})
}

func TestMigrateV5TypeChecksAgainstBuiltV5Package(t *testing.T) {
	resultarDir := findBuiltResultarDir(t)

	initialSource := `import { ResultAsync as Eager, ResultTask, okAsync, errAsync, type StrictResultAsync } from "resultar";

const baseTask = ResultTask.succeed(21);
const errTask = ResultTask.fail("bad");
const ok = (n: number) => n + 1;
const error = (e: string) => e.length;

export const bridged = baseTask.toResultAsync();
export const chained = baseTask.runResult().map((n) => n * 2);
export const lookup = (): StrictResultAsync<number, Error> => baseTask.runResult();
export const legacyMatched = errTask.runResult().match({ ok, error });
export const retried = Eager.retry(() => okAsync(1), { times: 1 });
export const resource = Eager.withResource({
  acquire: () => okAsync("conn"),
  use: (c) => okAsync(c),
  release: () => undefined,
});
export const callback = Eager.fromCallback({
  subscribe: (ctx) => { ctx.resolve(1); },
  catch: (e) => String(e),
});
export const tapped = okAsync(1).tap(() => {}).tapError(() => {});
export const errTapped = errAsync("e").tapError(() => {});
`
	dir, configPath, appPath := writeMigrateProject(t, initialSource, v4RequestTypes)
	installV4RuntimeAdapter(t, dir, resultarDir)

	runner := `import { bridged, chained, lookup, legacyMatched, retried, resource, callback, tapped, errTapped } from "./src/app.ts";
console.log(JSON.stringify({
  bridged: (await bridged).unwrapOr(0),
  chained: (await chained).unwrapOr(0),
  lookup: await lookup().unwrapOr(0),
  legacyMatched: await legacyMatched,
  retried: (await retried).unwrapOr(0),
  resource: (await resource).unwrapOr(""),
  callback: (await callback).unwrapOr(0),
  tapped: (await tapped).unwrapOr(0),
  errTapped: (await errTapped).isErr(),
}));
`
	if err := os.WriteFile(filepath.Join(dir, "run.mjs"), []byte(runner), 0o644); err != nil {
		t.Fatal(err)
	}

	// 1. Execute the consumer BEFORE --fix on the v4-compat runtime.
	beforeOut := runNodeTS(t, dir, "run.mjs")

	// 2. Run migrate-v5 --fix in a single pass.
	code, _ := runMigrateJSON(t, configPath, "--fix")
	if code != 0 {
		t.Fatalf("migrate-v5 --fix exit code = %d, want 0", code)
	}

	// 3. Swap node_modules/resultar to the real built v5 packages/resultar.
	swapToRealV5Resultar(t, dir, resultarDir)

	// 4. Verify zero program, syntactic, AND semantic TypeScript diagnostics via tsgo AND real tsc --noEmit!
	assertZeroTypeScriptDiagnostics(t, configPath, appPath)
	runRealTscNoEmit(t, dir, resultarDir, appPath)

	// 5. Execute the migrated consumer against real built v5 packages/resultar and assert identical runtime output!
	afterOut := runNodeTS(t, dir, "run.mjs")
	if afterOut != beforeOut {
		t.Fatalf("runtime output differed before vs after migration!\nbefore: %s\nafter:  %s", beforeOut, afterOut)
	}
}

func TestNoAwaitResultTaskFixAgainstBuiltV5Package(t *testing.T) {
	resultarDir := findBuiltResultarDir(t)

	t.Run("CLI --fix preserves explicit later execution after inspect chains", func(t *testing.T) {
		source := `import { ResultTask } from "resultar";

const seen: number[] = [];

export async function chainInspectThenRunPromise() {
  const task = ResultTask.ok(10);
  const later = await task;
  return await later.inspect((v) => { seen.push(v); }).runPromise();
}

export async function derivedInspectThenRunPromise() {
  const task = ResultTask.ok(20);
  const later = await task;
  const logged = later.inspect((v) => { seen.push(v); });
  return await logged.runPromise();
}

export async function directInspectChain() {
  const task = ResultTask.ok(30);
  return await (await task).inspect((v) => { seen.push(v); }).runPromise();
}

export function getSeen() {
  return seen;
}
`
		dir, configPath, appPath := writeMigrateProject(t, source, v5RequestTypes)
		swapToRealV5Resultar(t, dir, resultarDir)

		stdoutFile, err := os.CreateTemp(t.TempDir(), "fix-stdout")
		if err != nil {
			t.Fatal(err)
		}
		defer stdoutFile.Close()
		origStdout := os.Stdout
		os.Stdout = stdoutFile
		code := run([]string{"--project", configPath, "--fix", "--format", "json"})
		os.Stdout = origStdout
		if code != 0 {
			raw, _ := os.ReadFile(stdoutFile.Name())
			t.Fatalf("check --fix exit code = %d, want 0.\noutput:\n%s", code, string(raw))
		}

		// Must pass both tsgo GetSemanticDiagnostics AND real tsc --noEmit!
		assertZeroTypeScriptDiagnostics(t, configPath, appPath)
		runRealTscNoEmit(t, dir, resultarDir, appPath)

		runner := `import { chainInspectThenRunPromise, derivedInspectThenRunPromise, directInspectChain, getSeen } from "./src/app.ts";
const a = await chainInspectThenRunPromise();
const b = await derivedInspectThenRunPromise();
const c = await directInspectChain();
console.log(JSON.stringify({ a, b, c, seen: getSeen() }));
`
		if err := os.WriteFile(filepath.Join(dir, "run.mjs"), []byte(runner), 0o644); err != nil {
			t.Fatal(err)
		}
		out := runNodeTS(t, dir, "run.mjs")
		if out != `{"a":10,"b":20,"c":30,"seen":[10,20,30]}` {
			t.Fatalf("unexpected runtime output after no-await-result-task --fix: %s", out)
		}
	})

	t.Run("CLI --fix inserts .runResult() for Result-only usage and clears TS2339", func(t *testing.T) {
		source := `import { ResultTask } from "resultar";

export async function resultOnlyUsage() {
  const task = ResultTask.ok(40);
  const res = await task;
  return res.isOk() ? res.value : 0;
}
`
		dir, configPath, appPath := writeMigrateProject(t, source, v5RequestTypes)
		swapToRealV5Resultar(t, dir, resultarDir)

		stdoutFile, err := os.CreateTemp(t.TempDir(), "fix-ts2339-stdout")
		if err != nil {
			t.Fatal(err)
		}
		defer stdoutFile.Close()
		origStdout := os.Stdout
		os.Stdout = stdoutFile
		code := run([]string{"--project", configPath, "--fix", "--format", "json"})
		os.Stdout = origStdout
		if code != 0 {
			raw, _ := os.ReadFile(stdoutFile.Name())
			t.Fatalf("CLI --fix exit code = %d, want 0 (should fix TS2339 by inserting .runResult()).\noutput:\n%s", code, string(raw))
		}

		// After CLI --fix, TS2339 must be gone and real tsc --noEmit + Node execution must pass!
		assertZeroTypeScriptDiagnostics(t, configPath, appPath)
		runRealTscNoEmit(t, dir, resultarDir, appPath)

		runner := `import { resultOnlyUsage } from "./src/app.ts";
console.log(JSON.stringify({ value: await resultOnlyUsage() }));
`
		if err := os.WriteFile(filepath.Join(dir, "run.mjs"), []byte(runner), 0o644); err != nil {
			t.Fatal(err)
		}
		out := runNodeTS(t, dir, "run.mjs")
		if out != `{"value":40}` {
			t.Fatalf("unexpected runtime output after .runResult() fix: %s", out)
		}
	})

	t.Run("preserves inferred return Task factory (0 runs before runPromise, 1 after) while fixing explicit Result and Task returns", func(t *testing.T) {
		source := `import { ResultTask, type Result } from "resultar";

let runs = 0;
const task = ResultTask.sync(() => ++runs);

export async function factory() {
  return await task;
}

export async function factoryVar() {
  const pending = await task;
  return pending;
}

export async function explicitTaskFactory(): Promise<ResultTask<number>> {
  return await task;
}

export function getRuns() {
  return runs;
}

export function resetRuns() {
  runs = 0;
}
`
		dir, configPath, appPath := writeMigrateProject(t, source, v5RequestTypes)
		swapToRealV5Resultar(t, dir, resultarDir)

		runner := `import { factory, factoryVar, explicitTaskFactory, getRuns, resetRuns } from "./src/app.ts";
resetRuns();
const p1 = await factory();
const runsBefore1 = getRuns();
const v1 = await p1.runPromise();
const runsAfter1 = getRuns();

resetRuns();
const p2 = await factoryVar();
const runsBefore2 = getRuns();
const v2 = await p2.runPromise();
const runsAfter2 = getRuns();

resetRuns();
const p3 = await explicitTaskFactory();
const runsBefore3 = getRuns();
const v3 = await p3.runPromise();
const runsAfter3 = getRuns();

console.log(JSON.stringify({
  factory: { before: runsBefore1, value: v1, after: runsAfter1 },
  factoryVar: { before: runsBefore2, value: v2, after: runsAfter2 },
  explicitTask: { before: runsBefore3, value: v3, after: runsAfter3 },
}));
`
		if err := os.WriteFile(filepath.Join(dir, "run.mjs"), []byte(runner), 0o644); err != nil {
			t.Fatal(err)
		}
		beforeOut := runNodeTS(t, dir, "run.mjs")
		wantOut := `{"factory":{"before":0,"value":1,"after":1},"factoryVar":{"before":0,"value":1,"after":1},"explicitTask":{"before":0,"value":1,"after":1}}`
		if beforeOut != wantOut {
			t.Fatalf("unexpected baseline v5 output: %s", beforeOut)
		}

		// Run `resultar-check --project tsconfig.json --fix` (exits 1 because unannotated factory/factoryVar still report diagnostics,
		// which MUST NOT have speculative .runResult() edits applied!).
		stdoutFile, err := os.CreateTemp(t.TempDir(), "fix-inferred-stdout")
		if err != nil {
			t.Fatal(err)
		}
		defer stdoutFile.Close()
		origStdout := os.Stdout
		os.Stdout = stdoutFile
		_ = run([]string{"--project", configPath, "--fix", "--format", "json"})
		os.Stdout = origStdout

		fixedBytes, err := os.ReadFile(appPath)
		if err != nil {
			t.Fatal(err)
		}
		fixed := string(fixedBytes)
		if strings.Contains(fixed, ".runResult()") {
			t.Fatalf("must NOT insert .runResult() into inferred-return Task factories:\n%s", fixed)
		}
		if !strings.Contains(fixed, "export async function explicitTaskFactory(): Promise<ResultTask<number>> {\n  return task;\n}") {
			t.Fatalf("expected explicit Promise<ResultTask> return to strip redundant await:\n%s", fixed)
		}

		// Fixed file must compile cleanly under both tsgo semantic check and real tsc --noEmit,
		// and preserve exact 0 -> 1 run counts!
		assertZeroTypeScriptDiagnostics(t, configPath, appPath)
		runRealTscNoEmit(t, dir, resultarDir, appPath)

		afterOut := runNodeTS(t, dir, "run.mjs")
		if afterOut != beforeOut {
			t.Fatalf("runtime behavior changed after --fix!\nbefore: %s\nafter:  %s", beforeOut, afterOut)
		}

		// Separately verify an explicitly typed Promise<Result<number, never>> return DOES get .runResult() fixed
		// via the real CLI `resultar-check --project tsconfig.json --fix` (clearing TS2322 and exiting 0)!
		explicitResultSource := `import { ResultTask, type Result } from "resultar";

let runs = 0;
const task = ResultTask.sync(() => ++runs);

export async function explicitResultBoundary(): Promise<Result<number, never>> {
  return await task;
}
`
		resDir, resConfigPath, resAppPath := writeMigrateProject(t, explicitResultSource, v5RequestTypes)
		swapToRealV5Resultar(t, resDir, resultarDir)
		resStdout, err := os.CreateTemp(t.TempDir(), "fix-explicit-result-stdout")
		if err != nil {
			t.Fatal(err)
		}
		defer resStdout.Close()
		origResStdout := os.Stdout
		os.Stdout = resStdout
		resCode := run([]string{"--project", resConfigPath, "--fix", "--format", "json"})
		os.Stdout = origResStdout
		if resCode != 0 {
			raw, _ := os.ReadFile(resStdout.Name())
			t.Fatalf("CLI --fix on explicit Promise<Result<number, never>> exit code = %d, want 0.\noutput:\n%s", resCode, string(raw))
		}
		assertZeroTypeScriptDiagnostics(t, resConfigPath, resAppPath)
		runRealTscNoEmit(t, resDir, resultarDir, resAppPath)

		resRunner := `import { explicitResultBoundary } from "./src/app.ts";
const r = await explicitResultBoundary();
console.log(JSON.stringify({ ok: r.isOk(), value: r.unwrapOr(0) }));
`
		if err := os.WriteFile(filepath.Join(resDir, "run.mjs"), []byte(resRunner), 0o644); err != nil {
			t.Fatal(err)
		}
		resOut := runNodeTS(t, resDir, "run.mjs")
		if resOut != `{"ok":true,"value":1}` {
			t.Fatalf("unexpected explicit Promise<Result> output: %s", resOut)
		}
	})
}

func TestMigrateV5RequestJsonLocalShadowCollision(t *testing.T) {
	resultarDir := findBuiltResultarDir(t)
	requestDir, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "request"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(requestDir, "dist", "index.js")); err != nil {
		t.Skipf("skipping real v5 request package verification (dist not built at %s): %v", requestDir, err)
	}

	v4ReqWithValidatorTypes := `
import type { ResultAsync, ResultTask } from "resultar"
export interface RequestJsonInput { request: Promise<Response> | ((signal?: AbortSignal) => Promise<Response>); signal?: AbortSignal }
export interface RequestJsonTaskInput<T = unknown> {
  request: (signal?: AbortSignal) => Promise<Response>
  validator?: (v: unknown) => v is T
}
export declare function requestJson(input: RequestJsonInput): ResultAsync<unknown, Error>
export declare function requestJsonTask<T = unknown>(input: RequestJsonTaskInput<T>): ResultTask<T, Error>
`
	source := `import { ResultTask } from "resultar";
import { requestJsonTask, type RequestJsonTaskInput } from "resultar-request";

export type RequestJsonInput = { localOnly: true };
export type WrappedTaskInput = RequestJsonTaskInput<number>;

export async function lookup() {
  const requestJson = (..._args: unknown[]) => ResultTask.ok(0);
  const response = requestJsonTask({
    request: async () => new Response("42"),
    validator: (v: unknown): v is number => typeof v === "number",
  });
  const localVal = await requestJson().runPromise();
  const remoteVal = await response.runPromise();
  return { remote: remoteVal, local: localVal };
}
`
	dir, configPath, appPath := writeMigrateProject(t, source, v4ReqWithValidatorTypes)
	installV4RuntimeAdapter(t, dir, resultarDir)

	// Install v4 runtime adapter for resultar-request backed by real built packages/request/dist/index.js
	nmReq := filepath.Join(dir, "node_modules", "resultar-request")
	distReq := filepath.ToSlash(filepath.Join(requestDir, "dist", "index.js"))
	reqPkgJSON := `{
  "name": "resultar-request",
  "type": "module",
  "main": "./index.js",
  "types": "./index.d.ts",
  "exports": {
    ".": { "types": "./index.d.ts", "import": "./index.js" }
  }
}`
	reqRuntimeJS := fmt.Sprintf(`import { requestJson as v5RequestJson } from %q;
export const requestJsonTask = v5RequestJson;
export const requestJson = v5RequestJson;
`, distReq)
	if err := os.WriteFile(filepath.Join(nmReq, "package.json"), []byte(reqPkgJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nmReq, "index.js"), []byte(reqRuntimeJS), 0o644); err != nil {
		t.Fatal(err)
	}

	runner := `import { lookup } from "./src/app.ts";
console.log(JSON.stringify(await lookup()));
`
	if err := os.WriteFile(filepath.Join(dir, "run.mjs"), []byte(runner), 0o644); err != nil {
		t.Fatal(err)
	}
	beforeOut := runNodeTS(t, dir, "run.mjs")
	if beforeOut != `{"remote":42,"local":0}` {
		t.Fatalf("unexpected v4 baseline output: %s", beforeOut)
	}

	// Preview must leave file byte-identical.
	code, _ := runMigrateJSON(t, configPath)
	if code != 0 {
		t.Fatalf("preview exit code = %d, want 0", code)
	}
	previewBytes, err := os.ReadFile(appPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(previewBytes) != source {
		t.Fatalf("preview modified source file!")
	}

	// --fix must preserve local name via alias (`requestJson as requestJsonTask`) and NOT capture local `const requestJson`!
	code, _ = runMigrateJSON(t, configPath, "--fix")
	if code != 0 {
		t.Fatalf("fix exit code = %d, want 0", code)
	}
	afterBytes, err := os.ReadFile(appPath)
	if err != nil {
		t.Fatal(err)
	}
	after := string(afterBytes)
	for _, want := range []string{
		`import { requestJson as requestJsonTask, type RequestJsonInput as RequestJsonTaskInput } from "resultar-request";`,
		`const requestJson = (..._args: unknown[]) => ResultTask.ok(0);`,
		`const response = requestJsonTask({`,
	} {
		if !strings.Contains(after, want) {
			t.Errorf("migrated output missing %q.\nFull file:\n%s", want, after)
		}
	}

	// Swap BOTH resultar and resultar-request to real built v5 packages!
	swapToRealV5Resultar(t, dir, resultarDir)
	if err := os.RemoveAll(nmReq); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(requestDir, nmReq); err != nil {
		t.Fatal(err)
	}

	assertZeroTypeScriptDiagnostics(t, configPath, appPath)
	runRealTscNoEmit(t, dir, resultarDir, appPath)

	// Pass 2 idempotency must emit 0 edits!
	code, secondPass := runMigrateJSON(t, configPath)
	if code != 0 {
		t.Fatalf("second pass exit code = %d, want 0", code)
	}
	for _, item := range secondPass {
		if item.Kind == analyzer.MigrationEdit {
			t.Errorf("expected 0 edits on second pass, got: %#v", item)
		}
	}

	afterOut := runNodeTS(t, dir, "run.mjs")
	if afterOut != beforeOut {
		t.Fatalf("runtime behavior changed! local requestJson captured requestJsonTask?\nbefore: %s\nafter:  %s\nfile:\n%s", beforeOut, afterOut, after)
	}
}

func TestMigrateV5ComputedMatchKeysAndMultiFile(t *testing.T) {
	resultarDir := findBuiltResultarDir(t)

	t.Run("const computed key and second project file migrate without panic", func(t *testing.T) {
		appSource := `import { ResultTask } from "resultar";

const onFailure = "error" as const;

export const runComputed = () =>
  ResultTask.err("declined").runResult().match({
    ok: () => "",
    [onFailure]: (e) => e.toUpperCase(),
  });

export const runDirectLiteralComputed = () =>
  ResultTask.err("declined").runResult().match({
    ok: () => "",
    ["error"]: (e) => e.toUpperCase(),
  });
`
		otherSource := `import { ResultTask } from "resultar";

export const otherTask = ResultTask.succeed(7);
`
		dir, configPath, appPath := writeMigrateProject(t, appSource, v4RequestTypes)
		// Enable noUnusedLocals to also verify `const onFailure` stays cleanly referenced!
		strictTsconfig := `{
  "compilerOptions": {
    "strict": true,
    "noUnusedLocals": true,
    "target": "ESNext",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}`
		if err := os.WriteFile(configPath, []byte(strictTsconfig), 0o644); err != nil {
			t.Fatal(err)
		}
		otherPath := filepath.Join(dir, "src", "other.ts")
		if err := os.WriteFile(otherPath, []byte(otherSource), 0o644); err != nil {
			t.Fatal(err)
		}
		installV4RuntimeAdapter(t, dir, resultarDir)

		runner := `import { runComputed, runDirectLiteralComputed } from "./src/app.ts";
import { otherTask } from "./src/other.ts";
console.log(JSON.stringify({
  computed: await runComputed(),
  directLiteral: await runDirectLiteralComputed(),
  other: await otherTask.runPromise(),
}));
`
		if err := os.WriteFile(filepath.Join(dir, "run.mjs"), []byte(runner), 0o644); err != nil {
			t.Fatal(err)
		}
		beforeOut := runNodeTS(t, dir, "run.mjs")
		if beforeOut != `{"computed":"DECLINED","directLiteral":"DECLINED","other":7}` {
			t.Fatalf("unexpected v4 baseline output: %s", beforeOut)
		}

		// Preview must succeed with exit 0 and leave BOTH files byte-identical.
		code, _ := runMigrateJSON(t, configPath)
		if code != 0 {
			t.Fatalf("preview exit code = %d, want 0", code)
		}
		if b, _ := os.ReadFile(appPath); string(b) != appSource {
			t.Fatalf("preview modified app.ts!")
		}
		if b, _ := os.ReadFile(otherPath); string(b) != otherSource {
			t.Fatalf("preview modified other.ts!")
		}

		// --fix must succeed with exit 0 and migrate BOTH app.ts and other.ts!
		code, _ = runMigrateJSON(t, configPath, "--fix")
		if code != 0 {
			t.Fatalf("fix exit code = %d, want 0", code)
		}
		otherMigrated, _ := os.ReadFile(otherPath)
		if !strings.Contains(string(otherMigrated), "ResultTask.ok(7)") {
			t.Fatalf("second file src/other.ts was NOT migrated:\n%s", string(otherMigrated))
		}

		swapToRealV5Resultar(t, dir, resultarDir)
		assertZeroTypeScriptDiagnostics(t, configPath, appPath)
		runRealTscNoEmit(t, dir, resultarDir, appPath)

		// Pass 2 must emit 0 edits across both files.
		code, secondPass := runMigrateJSON(t, configPath)
		if code != 0 {
			t.Fatalf("second pass exit code = %d, want 0", code)
		}
		for _, item := range secondPass {
			if item.Kind == analyzer.MigrationEdit {
				t.Errorf("expected 0 edits on second pass, got: %#v", item)
			}
		}

		afterOut := runNodeTS(t, dir, "run.mjs")
		if afterOut != beforeOut {
			t.Fatalf("runtime output differed!\nbefore: %s\nafter:  %s", beforeOut, afterOut)
		}
	})

	t.Run("impure computed key [getKey()] routes to review in both preview and fix without deferring evaluation", func(t *testing.T) {
		source := `import { ResultTask } from "resultar";

let keyCalls = 0;
function getKey(): "error" {
  keyCalls += 1;
  return "error";
}

export async function runDynamicComputed() {
  keyCalls = 0;
  const pending = ResultTask.err("declined").runResult().match({
    ok: () => "",
    [getKey()]: (e) => e.toUpperCase(),
  });
  const callsBeforeAwait = keyCalls;
  const value = await pending;
  return { callsBeforeAwait, totalCalls: keyCalls, value };
}
`
		dir, configPath, appPath := writeMigrateProject(t, source, v4RequestTypes)
		installV4RuntimeAdapter(t, dir, resultarDir)

		runner := `import { runDynamicComputed } from "./src/app.ts";
console.log(JSON.stringify(await runDynamicComputed()));
`
		if err := os.WriteFile(filepath.Join(dir, "run.mjs"), []byte(runner), 0o644); err != nil {
			t.Fatal(err)
		}
		beforeOut := runNodeTS(t, dir, "run.mjs")
		if beforeOut != `{"callsBeforeAwait":1,"totalCalls":1,"value":"DECLINED"}` {
			t.Fatalf("unexpected v4 baseline output: %s", beforeOut)
		}

		code, previewItems := runMigrateJSON(t, configPath)
		if code != 0 {
			t.Fatalf("preview exit code = %d, want 0", code)
		}
		code, fixItems := runMigrateJSON(t, configPath, "--fix")
		if code != 0 {
			t.Fatalf("fix exit code = %d, want 0", code)
		}

		countMatchOrderReviews := func(items []analyzer.MigrationItem) (int, int) {
			reviews, edits := 0, 0
			for _, item := range items {
				if item.Kind == analyzer.MigrationReview && item.Category == "run-result-match-order" {
					reviews++
				}
				if item.Kind == analyzer.MigrationEdit {
					edits++
				}
			}
			return reviews, edits
		}
		pReviews, pEdits := countMatchOrderReviews(previewItems)
		fReviews, fEdits := countMatchOrderReviews(fixItems)
		if pReviews != 1 || fReviews != 1 || pEdits != 0 || fEdits != 0 {
			t.Fatalf("expected 1 run-result-match-order review and 0 edits in both preview (%d/%d) and fix (%d/%d): %#v", pReviews, pEdits, fReviews, fEdits, fixItems)
		}
		afterBytes, _ := os.ReadFile(appPath)
		if string(afterBytes) != source {
			t.Fatalf("expected [getKey()] call to be preserved untouched for manual review:\n%s", string(afterBytes))
		}
	})
}

func TestMigrateV5VariableMatchHandlers(t *testing.T) {
	resultarDir := findBuiltResultarDir(t)
	source := `import { ResultTask } from "resultar";

const legacyHandlers = {
  ok: (v: never) => String(v),
  error: (e: string) => e.toUpperCase(),
};

const canonicalHandlers = {
  ok: (v: never) => String(v),
  err: (e: string) => e.toUpperCase(),
};

export const runLegacy = () => ResultTask.err("declined").runResult().match(legacyHandlers);
export const runCanonical = () => ResultTask.err("declined").runResult().match(canonicalHandlers);
export const checkSharedUnmodified = () => typeof legacyHandlers.error;
`
	dir, configPath, appPath := writeMigrateProject(t, source, v4RequestTypes)
	installV4RuntimeAdapter(t, dir, resultarDir)

	runner := `import { runLegacy, runCanonical, checkSharedUnmodified } from "./src/app.ts";
console.log(JSON.stringify({
  legacy: await runLegacy(),
  canonical: await runCanonical(),
  sharedErrorType: checkSharedUnmodified(),
}));
`
	if err := os.WriteFile(filepath.Join(dir, "run.mjs"), []byte(runner), 0o644); err != nil {
		t.Fatal(err)
	}
	beforeOut := runNodeTS(t, dir, "run.mjs")
	if beforeOut != `{"legacy":"DECLINED","canonical":"DECLINED","sharedErrorType":"function"}` {
		t.Fatalf("unexpected v4 baseline output: %s", beforeOut)
	}

	// Preview must leave source untouched.
	code, _ := runMigrateJSON(t, configPath)
	if code != 0 {
		t.Fatalf("preview exit code = %d, want 0", code)
	}
	if b, _ := os.ReadFile(appPath); string(b) != source {
		t.Fatalf("preview modified source!")
	}

	// --fix must wrap legacyHandlers via `new ResultAsync(...)` and rewrite canonicalHandlers via `.then((r) => r.match(...))`!
	code, _ = runMigrateJSON(t, configPath, "--fix")
	if code != 0 {
		t.Fatalf("fix exit code = %d, want 0", code)
	}
	afterBytes, _ := os.ReadFile(appPath)
	after := string(afterBytes)
	for _, want := range []string{
		`import { ResultAsync } from "resultar/async";`,
		`new ResultAsync(ResultTask.err("declined").runResult()).match(legacyHandlers)`,
		`ResultTask.err("declined").runResult().then((r) => r.match(canonicalHandlers))`,
		`error: (e: string) => e.toUpperCase(),`,
	} {
		if !strings.Contains(after, want) {
			t.Errorf("migrated output missing %q.\nFull file:\n%s", want, after)
		}
	}

	swapToRealV5Resultar(t, dir, resultarDir)
	assertZeroTypeScriptDiagnostics(t, configPath, appPath)
	runRealTscNoEmit(t, dir, resultarDir, appPath)

	// Pass 2 must emit 0 edits.
	code, secondPass := runMigrateJSON(t, configPath)
	if code != 0 {
		t.Fatalf("second pass exit code = %d, want 0", code)
	}
	for _, item := range secondPass {
		if item.Kind == analyzer.MigrationEdit {
			t.Errorf("expected 0 edits on second pass, got: %#v", item)
		}
	}

	afterOut := runNodeTS(t, dir, "run.mjs")
	if afterOut != beforeOut {
		t.Fatalf("runtime output differed!\nbefore: %s\nafter:  %s", beforeOut, afterOut)
	}

	// Also verify ambiguous handler object emits a manual review instead of silently breaking.
	ambiguousSource := `import { ResultTask } from "resultar";

declare const ambiguousHandlers: { ok: (v: never) => string; err?: (e: string) => string; error?: (e: string) => string };
export const runAmbiguous = () => ResultTask.err("declined").runResult().match(ambiguousHandlers as { ok: (v: never) => string; err: (e: string) => string } & typeof ambiguousHandlers);
declare const anyHandlers: any;
export const runAny = () => ResultTask.err("declined").runResult().match(anyHandlers);
`
	_, ambConfigPath, _ := writeMigrateProject(t, ambiguousSource, v4RequestTypes)
	code, ambItems := runMigrateJSON(t, ambConfigPath)
	if code != 0 {
		t.Fatalf("ambiguous preview exit code = %d, want 0", code)
	}
	foundAmbiguousReview := false
	for _, item := range ambItems {
		if item.Kind == analyzer.MigrationReview && item.Category == "run-result-match-legacy-handlers" {
			foundAmbiguousReview = true
		}
	}
	if !foundAmbiguousReview {
		t.Fatalf("expected run-result-match-legacy-handlers review for anyHandlers, got: %#v", ambItems)
	}
}

func TestMigrateV5RequestJsonReExport(t *testing.T) {
	resultarDir := findBuiltResultarDir(t)
	requestDir, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "request"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(requestDir, "dist", "index.js")); err != nil {
		t.Skipf("skipping real v5 request package verification (dist not built at %s): %v", requestDir, err)
	}

	v4ReqWithValidatorTypes := `
import type { ResultAsync, ResultTask } from "resultar"
export interface RequestJsonInput { request: Promise<Response> | ((signal?: AbortSignal) => Promise<Response>); signal?: AbortSignal }
export interface RequestJsonTaskInput<T = unknown> {
  request: (signal?: AbortSignal) => Promise<Response>
  validator?: (v: unknown) => v is T
}
export declare function requestJson(input: RequestJsonInput): ResultAsync<unknown, Error>
export declare function requestJsonTask<T = unknown>(input: RequestJsonTaskInput<T>): ResultTask<T, Error>
`
	barrelSource := `import { requestJsonTask, type RequestJsonTaskInput } from "resultar-request";

export { requestJsonTask, type RequestJsonTaskInput };
`
	directBarrelSource := `export { requestJsonTask, type RequestJsonTaskInput } from "resultar-request";
`
	consumerSource := `import { requestJsonTask } from "./barrel.js";
import { requestJsonTask as directRequestJsonTask } from "./direct.js";

export async function lookupViaReExports() {
  const a = await requestJsonTask({
    request: async () => new Response("42"),
    validator: (v: unknown): v is number => typeof v === "number",
  }).runPromise();
  const b = await directRequestJsonTask({
    request: async () => new Response("42"),
    validator: (v: unknown): v is number => typeof v === "number",
  }).runPromise();
  return { a, b };
}
`
	dir, configPath, appPath := writeMigrateProject(t, consumerSource, v4ReqWithValidatorTypes)
	barrelPath := filepath.Join(dir, "src", "barrel.ts")
	directPath := filepath.Join(dir, "src", "direct.ts")
	if err := os.WriteFile(barrelPath, []byte(barrelSource), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(directPath, []byte(directBarrelSource), 0o644); err != nil {
		t.Fatal(err)
	}
	installV4RuntimeAdapter(t, dir, resultarDir)

	nmReq := filepath.Join(dir, "node_modules", "resultar-request")
	distReq := filepath.ToSlash(filepath.Join(requestDir, "dist", "index.js"))
	reqPkgJSON := `{
  "name": "resultar-request",
  "type": "module",
  "main": "./index.js",
  "types": "./index.d.ts",
  "exports": {
    ".": { "types": "./index.d.ts", "import": "./index.js" }
  }
}`
	reqRuntimeJS := fmt.Sprintf(`import { requestJson as v5RequestJson } from %q;
export const requestJsonTask = v5RequestJson;
export const requestJson = v5RequestJson;
`, distReq)
	if err := os.WriteFile(filepath.Join(nmReq, "package.json"), []byte(reqPkgJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nmReq, "index.js"), []byte(reqRuntimeJS), 0o644); err != nil {
		t.Fatal(err)
	}

	// For Node.js direct TS execution, point imports at .ts cleanly via a small runner importing barrel.ts & direct.ts.
	runner := `import { requestJsonTask } from "./src/barrel.ts";
import { requestJsonTask as directRequestJsonTask } from "./src/direct.ts";
const a = await requestJsonTask({
  request: async () => new Response("42"),
  validator: (v) => typeof v === "number",
}).runPromise();
const b = await directRequestJsonTask({
  request: async () => new Response("42"),
  validator: (v) => typeof v === "number",
}).runPromise();
console.log(JSON.stringify({ a, b }));
`
	if err := os.WriteFile(filepath.Join(dir, "run.mjs"), []byte(runner), 0o644); err != nil {
		t.Fatal(err)
	}
	beforeOut := runNodeTS(t, dir, "run.mjs")
	if beforeOut != `{"a":42,"b":42}` {
		t.Fatalf("unexpected v4 baseline output: %s", beforeOut)
	}

	// Preview must leave files untouched.
	code, _ := runMigrateJSON(t, configPath)
	if code != 0 {
		t.Fatalf("preview exit code = %d, want 0", code)
	}
	if b, _ := os.ReadFile(barrelPath); string(b) != barrelSource {
		t.Fatalf("preview modified barrel.ts!")
	}

	// --fix must preserve public re-export name `requestJsonTask` via alias!
	code, _ = runMigrateJSON(t, configPath, "--fix")
	if code != 0 {
		t.Fatalf("fix exit code = %d, want 0", code)
	}
	barrelAfter, _ := os.ReadFile(barrelPath)
	directAfter, _ := os.ReadFile(directPath)
	if !strings.Contains(string(barrelAfter), `import { requestJson as requestJsonTask, type RequestJsonInput as RequestJsonTaskInput } from "resultar-request";`) {
		t.Fatalf("expected local re-export barrel to preserve requestJsonTask via alias:\n%s", string(barrelAfter))
	}
	if !strings.Contains(string(directAfter), `export { requestJson as requestJsonTask, type RequestJsonInput as RequestJsonTaskInput } from "resultar-request";`) {
		t.Fatalf("expected direct re-export barrel to preserve requestJsonTask via alias:\n%s", string(directAfter))
	}

	swapToRealV5Resultar(t, dir, resultarDir)
	if err := os.RemoveAll(nmReq); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(requestDir, nmReq); err != nil {
		t.Fatal(err)
	}

	// Must pass tsgo semantic diagnostics AND real tsc --noEmit (zero TS2552)!
	assertZeroTypeScriptDiagnostics(t, configPath, appPath)
	runRealTscNoEmit(t, dir, resultarDir, appPath)

	// Pass 2 must emit 0 edits.
	code, secondPass := runMigrateJSON(t, configPath)
	if code != 0 {
		t.Fatalf("second pass exit code = %d, want 0", code)
	}
	for _, item := range secondPass {
		if item.Kind == analyzer.MigrationEdit {
			t.Errorf("expected 0 edits on second pass, got: %#v", item)
		}
	}

	afterOut := runNodeTS(t, dir, "run.mjs")
	if afterOut != beforeOut {
		t.Fatalf("runtime output differed!\nbefore: %s\nafter:  %s", beforeOut, afterOut)
	}
}

func TestMigrateV5MatchBothErrAndErrorKeys(t *testing.T) {
	resultarDir := findBuiltResultarDir(t)
	source := `import { ResultTask } from "resultar";

export const bothKeys = () =>
  ResultTask.err("x").runResult().match({
    ok: () => "OK",
    err: () => "A",
    error: () => "B",
  });
`
	dir, configPath, appPath := writeMigrateProject(t, source, v4RequestTypes)
	installV4RuntimeAdapter(t, dir, resultarDir)

	runner := `import { bothKeys } from "./src/app.ts";
console.log(JSON.stringify({ value: await bothKeys() }));
`
	if err := os.WriteFile(filepath.Join(dir, "run.mjs"), []byte(runner), 0o644); err != nil {
		t.Fatal(err)
	}
	beforeOut := runNodeTS(t, dir, "run.mjs")
	if beforeOut != `{"value":"A"}` {
		t.Fatalf("unexpected v4 baseline output: %s", beforeOut)
	}

	code, _ := runMigrateJSON(t, configPath, "--fix")
	if code != 0 {
		t.Fatalf("fix exit code = %d, want 0", code)
	}
	afterBytes, _ := os.ReadFile(appPath)
	after := string(afterBytes)
	if strings.Count(after, "err:") != 1 {
		t.Fatalf("must NOT generate duplicate err properties (TS1117):\n%s", after)
	}

	swapToRealV5Resultar(t, dir, resultarDir)
	assertZeroTypeScriptDiagnostics(t, configPath, appPath)
	runRealTscNoEmit(t, dir, resultarDir, appPath)

	// Pass 2 must emit 0 edits.
	code, secondPass := runMigrateJSON(t, configPath)
	if code != 0 {
		t.Fatalf("second pass exit code = %d, want 0", code)
	}
	for _, item := range secondPass {
		if item.Kind == analyzer.MigrationEdit {
			t.Errorf("expected 0 edits on second pass, got: %#v", item)
		}
	}

	afterOut := runNodeTS(t, dir, "run.mjs")
	if afterOut != beforeOut {
		t.Fatalf("runtime precedence changed (expected A, not B)!\nbefore: %s\nafter:  %s", beforeOut, afterOut)
	}

	// Sync Result.match({ ok, err, error }) must emit a manual review instead of creating TS1117 duplicate err!
	syncSource := `import { ok } from "resultar";

export const syncBoth = ok(1).match({
  ok: () => "OK",
  err: () => "A",
  error: () => "B",
});
`
	_, syncConfigPath, syncAppPath := writeMigrateProject(t, syncSource, v4RequestTypes)
	code, syncItems := runMigrateJSON(t, syncConfigPath, "--fix")
	if code != 0 {
		t.Fatalf("sync fix exit code = %d, want 0", code)
	}
	foundReview := false
	for _, item := range syncItems {
		if item.Kind == analyzer.MigrationEdit {
			t.Errorf("must NOT emit duplicate-key edit for sync match({ ok, err, error }): %#v", item)
		}
		if item.Kind == analyzer.MigrationReview && item.Category == "match-handler-key" {
			foundReview = true
		}
	}
	if !foundReview {
		t.Fatalf("expected match-handler-key review for sync match({ ok, err, error }), got %#v", syncItems)
	}
	syncAfter, _ := os.ReadFile(syncAppPath)
	if string(syncAfter) != syncSource {
		t.Fatalf("expected sync match({ ok, err, error }) to remain untouched for manual review:\n%s", string(syncAfter))
	}
}

func TestMigrateV5StarAndStringLiteralReExports(t *testing.T) {
	resultarDir := findBuiltResultarDir(t)
	requestDir, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "request"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(requestDir, "dist", "index.js")); err != nil {
		t.Skipf("skipping real v5 request package verification (dist not built at %s): %v", requestDir, err)
	}

	v4ReqWithValidatorTypes := `
import type { ResultAsync, ResultTask } from "resultar"
export interface RequestJsonInput { request: Promise<Response> | ((signal?: AbortSignal) => Promise<Response>); signal?: AbortSignal }
export interface RequestJsonTaskInput<T = unknown> {
  request: (signal?: AbortSignal) => Promise<Response>
  validator?: (v: unknown) => v is T
}
export declare function requestJson(input: RequestJsonInput): ResultAsync<unknown, Error>
export declare function requestJsonTask<T = unknown>(input: RequestJsonTaskInput<T>): ResultTask<T, Error>
`

	t.Run("export * from resultar-request and resultar flag manual review", func(t *testing.T) {
		source := `export * from 'resultar-request'
export * as ReqNS from 'resultar-request'
export * from 'resultar'
`
		_, configPath, appPath := writeMigrateProject(t, source, v4ReqWithValidatorTypes)
		code, previewItems := runMigrateJSON(t, configPath)
		if code != 0 {
			t.Fatalf("preview exit code = %d, want 0", code)
		}
		code, fixItems := runMigrateJSON(t, configPath, "--fix")
		if code != 0 {
			t.Fatalf("fix exit code = %d, want 0", code)
		}
		countReviews := func(items []analyzer.MigrationItem) (reqStar, coreStar, edits int) {
			for _, item := range items {
				if item.Kind == analyzer.MigrationEdit {
					edits++
				}
				if item.Kind == analyzer.MigrationReview && item.Category == "request-star-reexport" {
					reqStar++
				}
				if item.Kind == analyzer.MigrationReview && item.Category == "core-star-reexport" {
					coreStar++
				}
			}
			return reqStar, coreStar, edits
		}
		pReq, pCore, pEdits := countReviews(previewItems)
		fReq, fCore, fEdits := countReviews(fixItems)
		if pReq != 2 || fReq != 2 || pCore != 1 || fCore != 1 || pEdits != 0 || fEdits != 0 {
			t.Fatalf("expected 2 request-star-reexport + 1 core-star-reexport reviews and 0 edits in preview (%d/%d/%d) & fix (%d/%d/%d): %#v",
				pReq, pCore, pEdits, fReq, fCore, fEdits, fixItems)
		}
		if b, _ := os.ReadFile(appPath); string(b) != source {
			t.Fatalf("expected star re-exports to remain untouched:\n%s", string(b))
		}
	})

	t.Run("string-literal export aliases preserve quotes (no TS1005) and execute cleanly on v5", func(t *testing.T) {
		barrelSource := `export { requestJsonTask as 'request-json-task' } from 'resultar-request'
export { 'requestJsonTask' as "request-json-task-2" } from 'resultar-request'
export { okAsync as 'ok-async', ResultTask as 'result-task' } from 'resultar'
`
		localBarrelSource := `import { requestJsonTask } from 'resultar-request'
export { requestJsonTask as 'local-request-json-task' }
`
		consumerSource := `import { 'request-json-task' as req1, 'request-json-task-2' as req2, 'ok-async' as okA } from './barrel.js'
import { 'local-request-json-task' as reqLocal } from './local-barrel.js'

export async function runAll() {
  const a = await req1({
    request: async () => new Response('42'),
    validator: (v: unknown): v is number => typeof v === 'number',
  }).runPromise()
  const b = await req2({
    request: async () => new Response('42'),
    validator: (v: unknown): v is number => typeof v === 'number',
  }).runPromise()
  const c = await reqLocal({
    request: async () => new Response('42'),
    validator: (v: unknown): v is number => typeof v === 'number',
  }).runPromise()
  const d = (await okA(7)).unwrapOr(0)
  return { a, b, c, d }
}
`
		dir, configPath, appPath := writeMigrateProject(t, consumerSource, v4ReqWithValidatorTypes)
		barrelPath := filepath.Join(dir, "src", "barrel.ts")
		localBarrelPath := filepath.Join(dir, "src", "local-barrel.ts")
		if err := os.WriteFile(barrelPath, []byte(barrelSource), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(localBarrelPath, []byte(localBarrelSource), 0o644); err != nil {
			t.Fatal(err)
		}
		installV4RuntimeAdapter(t, dir, resultarDir)

		nmReq := filepath.Join(dir, "node_modules", "resultar-request")
		distReq := filepath.ToSlash(filepath.Join(requestDir, "dist", "index.js"))
		reqPkgJSON := `{
  "name": "resultar-request",
  "type": "module",
  "main": "./index.js",
  "types": "./index.d.ts",
  "exports": {
    ".": { "types": "./index.d.ts", "import": "./index.js" }
  }
}`
		reqRuntimeJS := fmt.Sprintf(`import { requestJson as v5RequestJson } from %q;
export const requestJsonTask = v5RequestJson;
export const requestJson = v5RequestJson;
`, distReq)
		if err := os.WriteFile(filepath.Join(nmReq, "package.json"), []byte(reqPkgJSON), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(nmReq, "index.js"), []byte(reqRuntimeJS), 0o644); err != nil {
			t.Fatal(err)
		}

		runner := `import { 'request-json-task' as req1, 'request-json-task-2' as req2, 'ok-async' as okA } from './src/barrel.ts'
import { 'local-request-json-task' as reqLocal } from './src/local-barrel.ts'
const a = await req1({ request: async () => new Response('42'), validator: (v) => typeof v === 'number' }).runPromise()
const b = await req2({ request: async () => new Response('42'), validator: (v) => typeof v === 'number' }).runPromise()
const c = await reqLocal({ request: async () => new Response('42'), validator: (v) => typeof v === 'number' }).runPromise()
const d = (await okA(7)).unwrapOr(0)
console.log(JSON.stringify({ a, b, c, d }))
`
		if err := os.WriteFile(filepath.Join(dir, "run.mjs"), []byte(runner), 0o644); err != nil {
			t.Fatal(err)
		}
		beforeOut := runNodeTS(t, dir, "run.mjs")
		if beforeOut != `{"a":42,"b":42,"c":42,"d":7}` {
			t.Fatalf("unexpected v4 baseline output: %s", beforeOut)
		}

		code, _ := runMigrateJSON(t, configPath, "--fix")
		if code != 0 {
			t.Fatalf("fix exit code = %d, want 0", code)
		}
		barrelAfter, _ := os.ReadFile(barrelPath)
		localBarrelAfter, _ := os.ReadFile(localBarrelPath)
		for _, want := range []string{
			`export { requestJson as 'request-json-task' } from 'resultar-request'`,
			`export { requestJson as "request-json-task-2" } from 'resultar-request'`,
			`export { ResultTask as 'result-task' } from 'resultar'`,
			`export { okAsync as 'ok-async' } from 'resultar/async'`,
		} {
			if !strings.Contains(string(barrelAfter), want) {
				t.Errorf("barrel.ts missing %q.\nFull file:\n%s", want, string(barrelAfter))
			}
		}
		if !strings.Contains(string(localBarrelAfter), `import { requestJson as requestJsonTask } from 'resultar-request'`) {
			t.Errorf("local-barrel.ts did not preserve local alias:\n%s", string(localBarrelAfter))
		}

		swapToRealV5Resultar(t, dir, resultarDir)
		if err := os.RemoveAll(nmReq); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(requestDir, nmReq); err != nil {
			t.Fatal(err)
		}

		// Must pass tsgo syntactic+semantic diagnostics AND real tsc --noEmit (zero TS1005)!
		assertZeroTypeScriptDiagnostics(t, configPath, appPath)
		runRealTscNoEmit(t, dir, resultarDir, appPath)

		// Pass 2 must emit 0 edits.
		code, secondPass := runMigrateJSON(t, configPath)
		if code != 0 {
			t.Fatalf("second pass exit code = %d, want 0", code)
		}
		for _, item := range secondPass {
			if item.Kind == analyzer.MigrationEdit {
				t.Errorf("expected 0 edits on second pass, got: %#v", item)
			}
		}

		afterOut := runNodeTS(t, dir, "run.mjs")
		if afterOut != beforeOut {
			t.Fatalf("runtime output differed!\nbefore: %s\nafter:  %s", beforeOut, afterOut)
		}
	})
}

func TestMigrateV5ReviewEdgeCases(t *testing.T) {
	resultarDir := findBuiltResultarDir(t)

	t.Run("split-value-and-type-imports-no-duplicate-resultasync", func(t *testing.T) {
		source := `import { ResultTask, okAsync } from "resultar";
import type { ResultAsync } from "resultar";

export const eagerVal = okAsync(20);
export const fromTaskVal = (): ResultAsync<number, never> => ResultTask.ok(22).toResultAsync();
`
		dir, configPath, appPath := writeMigrateProject(t, source, v4RequestTypes)
		installV4RuntimeAdapter(t, dir, resultarDir)

		runner := `import { eagerVal, fromTaskVal } from "./src/app.ts";
const a = (await eagerVal).unwrapOr(0);
const b = (await fromTaskVal()).unwrapOr(0);
console.log(a + b);
`
		if err := os.WriteFile(filepath.Join(dir, "run.mjs"), []byte(runner), 0o644); err != nil {
			t.Fatal(err)
		}
		if out := runNodeTS(t, dir, "run.mjs"); out != "42" {
			t.Fatalf("baseline output = %s, want 42", out)
		}

		code, _ := runMigrateJSON(t, configPath, "--fix")
		if code != 0 {
			t.Fatalf("fix exit code = %d, want 0", code)
		}

		swapToRealV5Resultar(t, dir, resultarDir)
		assertZeroTypeScriptDiagnostics(t, configPath, appPath)
		runRealTscNoEmit(t, dir, resultarDir, appPath)

		if out := runNodeTS(t, dir, "run.mjs"); out != "42" {
			t.Fatalf("migrated output = %s, want 42", out)
		}
	})

	t.Run("async-gen-and-fn-referenced-via-variables", func(t *testing.T) {
		source := `import { Result, ok } from "resultar";

async function* step(n: number) {
  const base = yield* ok(n);
  return base + 1;
}

const opts = {
  async *try() {
    const base = yield* ok(10);
    return base * 2;
  },
};

export const g1 = Result.gen(() => step(4));
export const g2 = Result.gen(opts);
export const fnStep = Result.fn(step);
`
		dir, configPath, appPath := writeMigrateProject(t, source, v4RequestTypes)
		installV4RuntimeAdapter(t, dir, resultarDir)

		runner := `import { g1, g2, fnStep } from "./src/app.ts";
console.log(JSON.stringify([
  (await g1).unwrapOr(0),
  (await g2).unwrapOr(0),
  (await fnStep(9)).unwrapOr(0),
]));
`
		if err := os.WriteFile(filepath.Join(dir, "run.mjs"), []byte(runner), 0o644); err != nil {
			t.Fatal(err)
		}
		if out := runNodeTS(t, dir, "run.mjs"); out != "[5,20,10]" {
			t.Fatalf("baseline output = %s, want [5,20,10]", out)
		}

		code, _ := runMigrateJSON(t, configPath, "--fix")
		if code != 0 {
			t.Fatalf("fix exit code = %d, want 0", code)
		}

		swapToRealV5Resultar(t, dir, resultarDir)
		assertZeroTypeScriptDiagnostics(t, configPath, appPath)
		runRealTscNoEmit(t, dir, resultarDir, appPath)

		if out := runNodeTS(t, dir, "run.mjs"); out != "[5,20,10]" {
			t.Fatalf("migrated output = %s, want [5,20,10]", out)
		}
	})

	t.Run("local-helper-returning-runresult-and-optional-chaining", func(t *testing.T) {
		source := `import { ResultTask } from "resultar";

const runAsFluent = () => ResultTask.ok(21).runResult();
const runAsNative = () => ResultTask.ok(10).runResult();

export async function compute(maybeTask: ResultTask<number, Error> | undefined) {
  const doubled = await runAsFluent().map((x) => x * 2).unwrapOr(0);
  const plain = (await runAsNative()).unwrapOr(0);
  const maybeThrown = await maybeTask?.runResult().unwrapOrThrow();
  const maybeDefault = await maybeTask?.runResult().unwrapOr(99);
  return { doubled, plain, maybeThrown, maybeDefault };
}
`
		dir, configPath, appPath := writeMigrateProject(t, source, v4RequestTypes)
		installV4RuntimeAdapter(t, dir, resultarDir)

		runner := `import { ResultTask } from "resultar";
import { compute } from "./src/app.ts";
console.log(JSON.stringify([
  await compute(undefined),
  await compute(ResultTask.ok(7)),
]));
`
		if err := os.WriteFile(filepath.Join(dir, "run.mjs"), []byte(runner), 0o644); err != nil {
			t.Fatal(err)
		}
		beforeOut := runNodeTS(t, dir, "run.mjs")
		if beforeOut != `[{"doubled":42,"plain":10},{"doubled":42,"plain":10,"maybeThrown":7,"maybeDefault":7}]` {
			t.Fatalf("unexpected v4 baseline output: %s", beforeOut)
		}

		code, _ := runMigrateJSON(t, configPath, "--fix")
		if code != 0 {
			t.Fatalf("fix exit code = %d, want 0", code)
		}

		afterBytes, _ := os.ReadFile(appPath)
		after := string(afterBytes)
		if !strings.Contains(after, "const runAsNative = () => ResultTask.ok(10).runResult();") {
			t.Errorf("expected native boundary helper to stay unwrapped:\n%s", after)
		}
		if !strings.Contains(after, "maybeTask?.runPromise()") {
			t.Errorf("expected optional chaining `?.` to be preserved on runPromise():\n%s", after)
		}

		swapToRealV5Resultar(t, dir, resultarDir)
		assertZeroTypeScriptDiagnostics(t, configPath, appPath)
		runRealTscNoEmit(t, dir, resultarDir, appPath)

		afterOut := runNodeTS(t, dir, "run.mjs")
		if afterOut != beforeOut {
			t.Fatalf("runtime output differed!\nbefore: %s\nafter:  %s", beforeOut, afterOut)
		}
	})
}

func TestMigrateV5InferredReturnServiceMethod(t *testing.T) {
	resultarDir := findBuiltResultarDir(t)

	t.Run("class and object service methods with inferred return preserve ResultAsync when callers chain fluent methods", func(t *testing.T) {
		serviceSource := `import { ResultTask } from "resultar";

const baseTask = ResultTask.ok(21);

export class PriceService {
  fetchPrice() {
    return baseTask.runResult();
  }
  fetchArrow = () => baseTask.runResult();
  fetchAwaitedOnly() {
    return baseTask.runResult();
  }
}

export const objService = {
  fetchPrice() {
    return baseTask.runResult();
  },
  fetchArrow: () => baseTask.runResult(),
};
`
		consumerSource := `import { PriceService, objService } from "./service.js";

const svc = new PriceService();

export async function runAll() {
  const fromClassMethod = await svc.fetchPrice().map((n) => n * 2).unwrapOr(0);
  const fromClassArrow = await svc.fetchArrow().map((n) => n * 2).unwrapOr(0);
  const fromObjMethod = await objService.fetchPrice().map((n) => n * 2).unwrapOr(0);
  const fromObjArrow = await objService.fetchArrow().map((n) => n * 2).unwrapOr(0);
  const awaitedOnly = (await svc.fetchAwaitedOnly()).unwrapOr(0);
  return { fromClassMethod, fromClassArrow, fromObjMethod, fromObjArrow, awaitedOnly };
}
`
		dir, configPath, appPath := writeMigrateProject(t, consumerSource, v4RequestTypes)
		servicePath := filepath.Join(dir, "src", "service.ts")
		if err := os.WriteFile(servicePath, []byte(serviceSource), 0o644); err != nil {
			t.Fatal(err)
		}
		installV4RuntimeAdapter(t, dir, resultarDir)

		runner := `import { PriceService, objService } from "./src/service.ts";
const svc = new PriceService();
const fromClassMethod = await svc.fetchPrice().map((n) => n * 2).unwrapOr(0);
const fromClassArrow = await svc.fetchArrow().map((n) => n * 2).unwrapOr(0);
const fromObjMethod = await objService.fetchPrice().map((n) => n * 2).unwrapOr(0);
const fromObjArrow = await objService.fetchArrow().map((n) => n * 2).unwrapOr(0);
const awaitedOnly = (await svc.fetchAwaitedOnly()).unwrapOr(0);
console.log(JSON.stringify({ fromClassMethod, fromClassArrow, fromObjMethod, fromObjArrow, awaitedOnly }));
`
		if err := os.WriteFile(filepath.Join(dir, "run.mjs"), []byte(runner), 0o644); err != nil {
			t.Fatal(err)
		}
		beforeOut := runNodeTS(t, dir, "run.mjs")
		if beforeOut != `{"fromClassMethod":42,"fromClassArrow":42,"fromObjMethod":42,"fromObjArrow":42,"awaitedOnly":21}` {
			t.Fatalf("unexpected v4 baseline output: %s", beforeOut)
		}

		// Preview must leave files untouched.
		code, _ := runMigrateJSON(t, configPath)
		if code != 0 {
			t.Fatalf("preview exit code = %d, want 0", code)
		}
		if b, _ := os.ReadFile(servicePath); string(b) != serviceSource {
			t.Fatalf("preview modified service.ts!")
		}

		// --fix must wrap the 4 methods whose callers chain `.map(...)` in `new ResultAsync(baseTask.runResult())`
		// and emit a manual review for the exported unannotated `fetchAwaitedOnly()`.
		code, fixItems := runMigrateJSON(t, configPath, "--fix")
		if code != 0 {
			t.Fatalf("fix exit code = %d, want 0", code)
		}
		serviceAfterBytes, _ := os.ReadFile(servicePath)
		serviceAfter := string(serviceAfterBytes)
		if strings.Count(serviceAfter, "new ResultAsync(baseTask.runResult())") != 4 {
			t.Fatalf("expected 4 new ResultAsync(baseTask.runResult()) wraps in service.ts:\n%s", serviceAfter)
		}
		foundAwaitedExportReview := false
		for _, item := range fixItems {
			if item.Kind == analyzer.MigrationReview && item.Category == "run-result-exported-contract" {
				foundAwaitedExportReview = true
			}
		}
		if !foundAwaitedExportReview {
			t.Fatalf("expected run-result-exported-contract review for exported unannotated fetchAwaitedOnly(), got: %#v", fixItems)
		}

		swapToRealV5Resultar(t, dir, resultarDir)
		assertZeroTypeScriptDiagnostics(t, configPath, appPath)
		runRealTscNoEmit(t, dir, resultarDir, appPath)

		// Pass 2 must emit 0 edits.
		code, secondPass := runMigrateJSON(t, configPath)
		if code != 0 {
			t.Fatalf("second pass exit code = %d, want 0", code)
		}
		for _, item := range secondPass {
			if item.Kind == analyzer.MigrationEdit {
				t.Errorf("expected 0 edits on second pass, got: %#v", item)
			}
		}

		afterOut := runNodeTS(t, dir, "run.mjs")
		if afterOut != beforeOut {
			t.Fatalf("runtime output differed!\nbefore: %s\nafter:  %s", beforeOut, afterOut)
		}
	})

	t.Run("exported unannotated service methods without local fluent callers emit review", func(t *testing.T) {
		source := `import { ResultTask } from "resultar";

const task = ResultTask.ok(42);

export class PriceLibrary {
  fetchPrice() {
    return task.runResult();
  }
  private internalOnly() {
    return task.runResult();
  }
}

export const priceObject = {
  fetchPrice() {
    return task.runResult();
  },
};
`
		_, configPath, _ := writeMigrateProject(t, source, v4RequestTypes)
		code, items := runMigrateJSON(t, configPath)
		if code != 0 {
			t.Fatalf("preview exit code = %d, want 0", code)
		}
		reviews := 0
		for _, item := range items {
			if item.Kind == analyzer.MigrationReview && item.Category == "run-result-exported-contract" {
				reviews++
			}
		}
		if reviews != 2 {
			t.Fatalf("expected 2 run-result-exported-contract reviews (public class method + exported object method, excluding private method), got %d: %#v", reviews, items)
		}
	})
}

func TestMigrateV5PrunesUnusedCoreImportAfterResultGen(t *testing.T) {
	resultarDir := findBuiltResultarDir(t)
	strictNoUnusedTsconfig := `{
  "compilerOptions": {
    "strict": true,
    "noUnusedLocals": true,
    "target": "ESNext",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}`

	onlyResultGen := `import { Result } from 'resultar'

async function* step() {
  return 42
}

export const out = Result.gen(step)
`
	mixedCoreAndGen := `import { ok, Result } from 'resultar'

async function* step() {
  return 42
}

export const syncVal = ok(1)
export const out = Result.gen(step)
`
	typeRefKept := `import { Result } from 'resultar'

async function* step() {
  return 42
}

export type OutResult = Result<number, never>
export const out = Result.gen(step)
`
	namespaceGen := `import * as R from 'resultar'

async function* step() {
  return 42
}

export const out = R.Result.gen(step)
`
	dir, configPath, appPath := writeMigrateProject(t, onlyResultGen, v4RequestTypes)
	if err := os.WriteFile(configPath, []byte(strictNoUnusedTsconfig), 0o644); err != nil {
		t.Fatal(err)
	}
	mixedPath := filepath.Join(dir, "src", "mixed.ts")
	typeKeptPath := filepath.Join(dir, "src", "type-kept.ts")
	nsPath := filepath.Join(dir, "src", "ns.ts")
	for p, src := range map[string]string{
		mixedPath:    mixedCoreAndGen,
		typeKeptPath: typeRefKept,
		nsPath:       namespaceGen,
	} {
		if err := os.WriteFile(p, []byte(src), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	installV4RuntimeAdapter(t, dir, resultarDir)

	runner := `import { out as out1 } from './src/app.ts'
import { syncVal, out as out2 } from './src/mixed.ts'
import { out as out3 } from './src/type-kept.ts'
import { out as out4 } from './src/ns.ts'
console.log(JSON.stringify({
  out1: (await out1).unwrapOr(0),
  syncVal: syncVal.unwrapOr(0),
  out2: (await out2).unwrapOr(0),
  out3: (await out3).unwrapOr(0),
  out4: (await out4).unwrapOr(0),
}))
`
	if err := os.WriteFile(filepath.Join(dir, "run.mjs"), []byte(runner), 0o644); err != nil {
		t.Fatal(err)
	}
	beforeOut := runNodeTS(t, dir, "run.mjs")
	if beforeOut != `{"out1":42,"syncVal":1,"out2":42,"out3":42,"out4":42}` {
		t.Fatalf("unexpected v4 baseline output: %s", beforeOut)
	}

	code, _ := runMigrateJSON(t, configPath, "--fix")
	if code != 0 {
		t.Fatalf("fix exit code = %d, want 0", code)
	}

	appAfter, _ := os.ReadFile(appPath)
	mixedAfter, _ := os.ReadFile(mixedPath)
	typeKeptAfter, _ := os.ReadFile(typeKeptPath)
	nsAfter, _ := os.ReadFile(nsPath)

	if strings.Contains(string(appAfter), `from 'resultar'`) || !strings.Contains(string(appAfter), `import { ResultAsync } from 'resultar/async'`) {
		t.Fatalf("expected unused `import { Result } from 'resultar'` to be replaced cleanly:\n%s", string(appAfter))
	}
	if !strings.Contains(string(mixedAfter), `import { ok } from 'resultar'`) || strings.Contains(string(mixedAfter), `import { ok, Result }`) {
		t.Fatalf("expected only `Result` to be pruned from mixed import:\n%s", string(mixedAfter))
	}
	if !strings.Contains(string(typeKeptAfter), `import { Result } from 'resultar'`) {
		t.Fatalf("expected `Result` import to stay when still used as a type:\n%s", string(typeKeptAfter))
	}
	if strings.Contains(string(nsAfter), `import * as R from 'resultar'`) || !strings.Contains(string(nsAfter), `import { ResultAsync } from 'resultar/async'`) {
		t.Fatalf("expected unused namespace `import * as R` to be replaced cleanly:\n%s", string(nsAfter))
	}

	swapToRealV5Resultar(t, dir, resultarDir)
	// Must pass tsgo semantic diagnostics AND real `tsc --noEmit` with `noUnusedLocals: true` (zero TS6133)!
	assertZeroTypeScriptDiagnostics(t, configPath, appPath)
	runRealTscNoEmit(t, dir, resultarDir, appPath)

	// Pass 2 must emit 0 edits across all 4 files.
	code, secondPass := runMigrateJSON(t, configPath)
	if code != 0 {
		t.Fatalf("second pass exit code = %d, want 0", code)
	}
	for _, item := range secondPass {
		if item.Kind == analyzer.MigrationEdit {
			t.Errorf("expected 0 edits on second pass, got: %#v", item)
		}
	}

	afterOut := runNodeTS(t, dir, "run.mjs")
	if afterOut != beforeOut {
		t.Fatalf("runtime output differed!\nbefore: %s\nafter:  %s", beforeOut, afterOut)
	}
}

func TestMigrateV5InterfaceImplementedServiceMethod(t *testing.T) {
	resultarDir := findBuiltResultarDir(t)

	source := `import { ResultTask, type StrictResultAsync } from "resultar";

interface PricePort {
  fetchPrice(): StrictResultAsync<number, Error>;
}

interface ArrowPort {
  fetchPrice: () => StrictResultAsync<number, Error>;
}

interface GenericPort<T> {
  fetchPrice(): StrictResultAsync<T, Error>;
}

interface SubPricePort extends GenericPort<number> {}

abstract class BasePriceService {
  abstract fetchPrice(): StrictResultAsync<number, Error>;
}

const task = ResultTask.ok(21);

// 1. Direct implements interface, non-exported class, inferred method return (TS2416 reproducer)
class PriceService implements PricePort {
  fetchPrice() {
    return task.runResult();
  }
}

// 2. Implements interface via class arrow property
class ArrowPriceService implements ArrowPort {
  fetchPrice = () => task.runResult();
}

// 3. Implements transitive generic interface
class SubPriceService implements SubPricePort {
  fetchPrice() {
    return task.runResult();
  }
}

// 4. Extends abstract base class
class ExtendedPriceService extends BasePriceService {
  fetchPrice() {
    return task.runResult();
  }
}

// 5. Structural interface assignment without implements
class StructuralPriceService {
  fetchPrice() {
    return task.runResult();
  }
}

const directService: PricePort = new PriceService();
const arrowService: ArrowPort = new ArrowPriceService();
const subService: SubPricePort = new SubPriceService();
const extendedService: BasePriceService = new ExtendedPriceService();
const structuralService: PricePort = new StructuralPriceService();
const objectService: PricePort = {
  fetchPrice() {
    return task.runResult();
  },
};

export async function runAllPorts() {
  return {
    direct: await directService.fetchPrice().map((n) => n * 2).unwrapOr(0),
    arrow: await arrowService.fetchPrice().map((n) => n * 2).unwrapOr(0),
    sub: await subService.fetchPrice().map((n) => n * 2).unwrapOr(0),
    extended: await extendedService.fetchPrice().map((n) => n * 2).unwrapOr(0),
    structural: await structuralService.fetchPrice().map((n) => n * 2).unwrapOr(0),
    object: await objectService.fetchPrice().map((n) => n * 2).unwrapOr(0),
  };
}
`
	dir, configPath, appPath := writeMigrateProject(t, source, v4RequestTypes)
	installV4RuntimeAdapter(t, dir, resultarDir)

	runner := `import { runAllPorts } from "./src/app.ts";
console.log(JSON.stringify(await runAllPorts()));
`
	if err := os.WriteFile(filepath.Join(dir, "run.mjs"), []byte(runner), 0o644); err != nil {
		t.Fatal(err)
	}
	beforeOut := runNodeTS(t, dir, "run.mjs")
	if beforeOut != `{"direct":42,"arrow":42,"sub":42,"extended":42,"structural":42,"object":42}` {
		t.Fatalf("unexpected v4 baseline output: %s", beforeOut)
	}

	// Preview must leave file byte-identical.
	code, _ := runMigrateJSON(t, configPath)
	if code != 0 {
		t.Fatalf("preview exit code = %d, want 0", code)
	}
	if b, _ := os.ReadFile(appPath); string(b) != source {
		t.Fatalf("preview modified app.ts!")
	}

	// --fix must wrap all 6 implementations in `new ResultAsync(task.runResult())`!
	code, _ = runMigrateJSON(t, configPath, "--fix")
	if code != 0 {
		t.Fatalf("fix exit code = %d, want 0", code)
	}
	afterBytes, _ := os.ReadFile(appPath)
	after := string(afterBytes)
	if strings.Count(after, "new ResultAsync(task.runResult())") != 6 {
		t.Fatalf("expected 6 new ResultAsync(task.runResult()) wraps across interface/base-class/structural/object implementations:\n%s", after)
	}

	swapToRealV5Resultar(t, dir, resultarDir)
	// Must pass tsgo semantic diagnostics AND real tsc --noEmit (zero TS2416)!
	assertZeroTypeScriptDiagnostics(t, configPath, appPath)
	runRealTscNoEmit(t, dir, resultarDir, appPath)

	// Pass 2 must emit 0 edits.
	code, secondPass := runMigrateJSON(t, configPath)
	if code != 0 {
		t.Fatalf("second pass exit code = %d, want 0", code)
	}
	for _, item := range secondPass {
		if item.Kind == analyzer.MigrationEdit {
			t.Errorf("expected 0 edits on second pass, got: %#v", item)
		}
	}

	afterOut := runNodeTS(t, dir, "run.mjs")
	if afterOut != beforeOut {
		t.Fatalf("runtime output differed!\nbefore: %s\nafter:  %s", beforeOut, afterOut)
	}
}
