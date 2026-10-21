package analyzer

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/config"
	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/project"
)

const resultAsyncTypes = `
export interface Result<T, E> {
  readonly value: T
  readonly error: E
  match<U>(handlers: { readonly ok: (value: T) => U; readonly err: (error: E) => U }): U
}
export declare const Result: {
  match<T, E, U>(handlers: { readonly ok: (value: T) => U; readonly err: (error: E) => U }): (result: Result<T, E>) => U
  unwrapOr<T2>(fallback: T2): <T, E>(result: Result<T, E>) => T | T2
  map<T, U>(fn: (value: T) => U): <E>(result: Result<T, E>) => Result<U, E>
  combine<T, E>(results: readonly Result<T, E>[]): Result<T[], E>
}
export type StrictResult<T, E extends Error> = Result<T, E>
export interface ResultAsync<T, E> extends PromiseLike<Result<T, E>> {
  map<U>(fn: (value: T) => U): ResultAsync<U, E>
}
export type StrictResultAsync<T, E extends Error> = ResultAsync<T, E>
export interface ResultTask<T, E> {
  readonly task: () => Result<T, E>
  runResult(): ResultAsync<T, E>
}
export declare function ok<T>(value: T): Result<T, never>
export declare function fromPromise<T, E>(value: Promise<T>, mapError: (cause: unknown) => E): ResultAsync<T, E>
export declare function identity<A>(value: A): A
export declare function flow<A, B, C>(ab: (a: A) => B, bc: (b: B) => C): (a: A) => C
export declare function pipe<A, B>(a: A, ab: (a: A) => B): B
export declare function pipe<A, B, C>(a: A, ab: (a: A) => B, bc: (b: B) => C): C
`

func TestPreferResultAsyncContractsAndInference(t *testing.T) {
	cases := []struct {
		name, source string
		locations    []string
	}{
		{"service contract", `import type {StrictResult} from "resultar"
export interface UsersService {
  readonly findById: (id: string) => Promise<StrictResult<string, Error>>
}`, []string{"Promise<StrictResult<string, Error>>"}},
		{"annotated async function", `import {ok, type Result} from "resultar"
export async function load(): Promise<Result<number, Error>> { return ok(1) }`, []string{"Promise<Result<number, Error>>"}},
		{"inferred functions", `import {ok} from "resultar"
export const arrow = async () => ok(1)
export async function load() { return ok(2) }
export class Service { async find() { return ok(3) } }`, []string{"arrow", "load", "find"}},
		{"renamed import and generic aliases", `import type {Result as Outcome} from "resultar"
type Later<T> = Promise<T>
type Reply<T, E> = Outcome<T, E>
export type Pending = Later<Reply<number, Error>>`, []string{"Later<Reply<number, Error>>"}},
		{"namespace and reexport", `import type * as r from "resultar"
import type {DomainResult} from "./barrel.js"
export type First = Promise<r.Result<number, Error>>
export type Second = Promise<DomainResult<string, Error>>`, []string{"Promise<r.Result<number, Error>>", "Promise<DomainResult<string, Error>>"}},
		{"union and intersection", `import type {Result} from "resultar"
export type Union = Promise<Result<number, Error> | Result<string, TypeError>>
export type Decorated = Promise<Result<number, Error> & {readonly trace: string}>`, []string{"Promise<Result<number, Error> | Result<string, TypeError>>", "Promise<Result<number, Error> & {readonly trace: string}>"}},
		{"line suppression", `import type {Result} from "resultar"
// resultar-check-disable-next-line prefer-result-async
export type NativeBoundary = Promise<Result<number, Error>>`, nil},
		{"ordinary promises and native thenables", `import type {Result} from "resultar"
export type Value = Promise<number>
export type Mixed = Promise<Result<number, Error> | undefined>
export type Thenable = PromiseLike<Result<number, Error>>
export const load = async () => 1`, nil},
		{"Resultar async contracts", `import type {Result, ResultAsync, StrictResultAsync, ResultTask} from "resultar"
export interface Services {
  find(): StrictResultAsync<number, Error>
  read(): ResultAsync<number, string>
  pure(): Result<number, Error>
  lazy(): ResultTask<number, Error>
}`, nil},
		{"unrelated Result name", `interface Result<T, E> {value: T; error: E}
export type External = Promise<Result<number, Error>>`, nil},
		{"unrelated Promise name", `import type {Result} from "resultar"
declare namespace Foreign {
  interface Promise<T> {readonly value: T}
}
export type External = Foreign.Promise<Result<number, Error>>`, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			directory := writeResultAsyncFixture(t, tc.source)
			opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
			if err != nil || len(diagnostics) != 0 {
				t.Fatalf("open: %v, compiler diagnostics: %v", err, diagnostics)
			}
			options := config.Defaults()
			options.NoDiscard = config.SeverityOff
			options.NoUnknownResultError = config.SeverityOff
			findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
			if err != nil {
				t.Fatal(err)
			}
			if len(findings) != len(tc.locations) {
				t.Fatalf("got %#v, want locations %v", findings, tc.locations)
			}
			for index, finding := range findings {
				if finding.Rule != "prefer-result-async" || finding.Severity != config.SeverityWarning {
					t.Errorf("unexpected finding: %#v", finding)
				}
				location := tc.source[finding.Start : finding.Start+finding.Length]
				if location != tc.locations[index] {
					t.Errorf("location = %q, want %q", location, tc.locations[index])
				}
				if !strings.Contains(finding.Message, "StrictResultAsync") || !strings.Contains(finding.Message, "Remove the async wrapper") {
					t.Errorf("missing migration guidance: %s", finding.Message)
				}
				if len(finding.Fixes) != 0 {
					t.Error("an annotation-only autofix would leave async implementations incompatible")
				}
			}
			options.PreferResultAsync = config.SeverityError
			findings, err = Run(context.Background(), opened.Program, opened.Directory, options)
			if err != nil || len(findings) != len(tc.locations) {
				t.Fatalf("error severity: %v, findings: %#v", err, findings)
			}
			for _, finding := range findings {
				if finding.Severity != config.SeverityError {
					t.Errorf("expected configured error severity: %#v", finding)
				}
			}
			options.PreferResultAsync = config.SeverityOff
			findings, err = Run(context.Background(), opened.Program, opened.Directory, options)
			if err != nil || len(findings) != 0 {
				t.Fatalf("disabled rule: %v, findings: %#v", err, findings)
			}
		})
	}
}

func TestPreferResultAsyncAllContracts(t *testing.T) {
	cases := []struct {
		name, source string
		locations    []string
	}{
		{"raw repository contract", `type User = {readonly id: string}
export interface UsersRepository {
  readonly findById: (id: string) => Promise<User | undefined>
}`, []string{"Promise<User | undefined>"}},
		{"methods and readiness properties", `export interface Repository {
  find(id: string): Promise<string | undefined>
  readonly ready: Promise<void>
}`, []string{"Promise<string | undefined>", "Promise<void>"}},
		{"inferred raw returns", `export const load = async () => 1
export function read() { return Promise.resolve(2) }
export class Repository { async find() { return undefined } }`, []string{"load", "read", "find"}},
		{"annotated function", `export async function find(): Promise<string | undefined> { return undefined }`, []string{"Promise<string | undefined>"}},
		{"generic aliases", `type Pending<T> = Promise<T>
export interface Repository { find(): Pending<string> }`, []string{"Promise<T>", "Pending<string>"}},
		{"unions and intersections", `type Pending = Promise<number> | undefined
type Traced = Promise<string> & {readonly trace: string}
export interface Repository { find(): Pending; read(): Traced }
export function maybe(found: boolean) { return found ? Promise.resolve(1) : undefined }`, []string{"Promise<number>", "Promise<string>", "Pending", "Traced", "maybe"}},
		{"result contract reported once", `import type {StrictResult} from "resultar"
export interface Service { find(): Promise<StrictResult<number, Error>> }`, []string{"Promise<StrictResult<number, Error>>"}},
		{"Resultar and unrelated thenables", `import type {StrictResultAsync, ResultAsync, ResultTask} from "resultar"
declare namespace Foreign { interface Promise<T> {readonly value: T} }
export interface Repository {
  find(): StrictResultAsync<number, Error>
  read(): ResultAsync<number, string>
  lazy(): ResultTask<number, Error>
  foreign(): Foreign.Promise<number>
  interoperability(): PromiseLike<number>
}`, nil},
		{"native boundaries and driver adaptation", `import {fromPromise, type StrictResultAsync} from "resultar"
import {read} from "./native.js"
export const repository = { find: (): StrictResultAsync<number, Error> => fromPromise(read(), error => Error(String(error))) }
// Native framework bootstrap intentionally owns rejection handling.
// resultar-check-disable-next-line prefer-result-async
export async function start(): Promise<void> {}
export type Callback = () => Promise<void> // resultar-check-disable-line prefer-result-async`, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			directory := writeResultAsyncFixture(t, tc.source)
			opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
			if err != nil || len(diagnostics) != 0 {
				t.Fatalf("open: %v, compiler diagnostics: %v", err, diagnostics)
			}
			options := config.Defaults()
			options.NoDiscard = config.SeverityOff
			options.NoUnknownResultError = config.SeverityOff
			options.PreferResultAsync = config.SeverityError
			options.PreferResultAsyncMode = "all"
			findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
			if err != nil || len(findings) != len(tc.locations) {
				t.Fatalf("run: %v; got %#v, want locations %v", err, findings, tc.locations)
			}
			for index, finding := range findings {
				location := tc.source[finding.Start : finding.Start+finding.Length]
				if finding.Rule != "prefer-result-async" || finding.Severity != config.SeverityError || location != tc.locations[index] {
					t.Errorf("unexpected finding at %q (want %q): %#v", location, tc.locations[index], finding)
				}
				if !strings.Contains(finding.Message, "StrictResultAsync") || !strings.Contains(finding.Message, "typed errors in the adapter") || len(finding.Fixes) != 0 {
					t.Errorf("expected actionable migration guidance without an annotation-only autofix: %#v", finding)
				}
			}
			options.PreferResultAsync = config.SeverityOff
			findings, err = Run(context.Background(), opened.Program, opened.Directory, options)
			if err != nil || len(findings) != 0 {
				t.Fatalf("disabled all mode: %v, findings: %#v", err, findings)
			}
		})
	}
}

func writeResultAsyncFixture(t *testing.T, source string) string {
	t.Helper()
	directory := writeFixture(t, source)
	files := map[string]string{
		"package.json":                       `{"type":"module"}`,
		"node_modules/resultar/package.json": `{"name":"resultar","type":"module","types":"index.d.ts"}`,
		"node_modules/resultar/index.d.ts":   resultAsyncTypes,
		"barrel.ts":                          `export type {StrictResult as DomainResult} from "resultar"`,
		"native.d.ts":                        `export declare function read(): Promise<number>`,
		"handlers.ts": `import {Result} from "resultar"
export function foldImported(result: Result<number, Error>): number {
  return result.match({ ok: value => value, err: () => 0 })
}
export function ignoreImported(_result: Result<number, Error>): number {
  return 0
}
export const matchAlias = Result.match
`,
	}
	for name, contents := range files {
		path := filepath.Join(directory, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return directory
}

func TestNoDiscardResultAsyncAwaitTransfer(t *testing.T) {
	source := `import type {ResultTask} from "resultar"
declare const task: ResultTask<number, Error>
export async function runHandled(): Promise<number> {
  const pending = task.runResult()
  const resolved = await pending
  return resolved.match({ ok: value => value, err: () => 0 })
}
export async function runPromiseResolveHandled(): Promise<number> {
  const pending = task.runResult()
  const resolved = await Promise.resolve(pending)
  return resolved.match({ ok: value => value, err: () => 0 })
}
export async function runPromiseResolveVariableHandled(): Promise<number> {
  const pending = task.runResult()
  const native = Promise.resolve(pending)
  const resolved = await native
  return resolved.match({ ok: value => value, err: () => 0 })
}
export async function runPromiseResolveThenHandled(): Promise<number> {
  const pending = task.runResult()
  return Promise.resolve(pending).then(resolved => resolved.match({ ok: value => value, err: () => 0 }))
}
export async function runPromiseAllDestructuredHandled(): Promise<number> {
  const pending = task.runResult()
  const [resolved] = await Promise.all([pending])
  return resolved.match({ ok: value => value, err: () => 0 })
}
export async function runPromiseAllVariableIndexedHandled(): Promise<number> {
  const pending = task.runResult()
  const results = await Promise.all([pending])
  return results[0].match({ ok: value => value, err: () => 0 })
}
export async function runPromiseAllIntermediateHandled(): Promise<number> {
  const pending = task.runResult()
  const all = Promise.all([pending])
  const [resolved] = await all
  return resolved.match({ ok: value => value, err: () => 0 })
}
export async function runPromiseAllThenDestructuredHandled(): Promise<number> {
  const pending = task.runResult()
  return Promise.all([pending]).then(([resolved]) => resolved.match({ ok: value => value, err: () => 0 }))
}
export async function runUnhandled(): Promise<void> {
  const pendingUnhandled = task.runResult()
  const unhandledResolved = await pendingUnhandled
  const pendingBareAwait = task.runResult()
  await pendingBareAwait
  const neverAwaited = task.runResult()
  const pendingPromiseResolveUnhandled = task.runResult()
  const unhandledFromResolve = await Promise.resolve(pendingPromiseResolveUnhandled)
  const pendingPromiseResolveBare = task.runResult()
  await Promise.resolve(pendingPromiseResolveBare)
  const pendingPromiseAllUnhandled = task.runResult()
  const [unhandledFromAll] = await Promise.all([pendingPromiseAllUnhandled])
  const pendingPromiseAllBare = task.runResult()
  await Promise.all([pendingPromiseAllBare])
}
`
	directory := writeResultAsyncFixture(t, source)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil || len(diagnostics) != 0 {
		t.Fatalf("open: %v, compiler diagnostics: %v", err, diagnostics)
	}
	options := config.Defaults()
	options.NoUnsafeAwait = config.SeverityOff
	options.PreferResultAsync = config.SeverityOff
	options.NoDiscard = config.SeverityWarning
	options.NoDiscardMode = "must-use"
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	assertInstanceRunnerFindingLines(t, source, findings, []string{
		"const unhandledResolved = await pendingUnhandled",
		"await pendingBareAwait",
		"const neverAwaited = task.runResult()",
		"const unhandledFromResolve = await Promise.resolve(pendingPromiseResolveUnhandled)",
		"await Promise.resolve(pendingPromiseResolveBare)",
		"const [unhandledFromAll] = await Promise.all([pendingPromiseAllUnhandled])",
		"const pendingPromiseAllBare = task.runResult()",
	})
}

func TestNoDiscardResultAsyncRegressions(t *testing.T) {
	source := `import {Result, identity, flow, pipe, type ResultTask} from "resultar"
import * as namespace from "./handlers.js"
import {foldImported} from "./handlers.js"
declare const task: ResultTask<number, Error>
declare const dynamicIdx: number

export async function runVarSelfCycleUnhandled(): Promise<void> {
  const pendingCycleUnhandled = task.runResult()
  var native = Promise.resolve(pendingCycleUnhandled)
  var native = Promise.resolve(native)
  await native
}

export async function runVarSelfCycleHandled(): Promise<number> {
  const pendingCycleHandled = task.runResult()
  var native = Promise.resolve(pendingCycleHandled)
  var native = Promise.resolve(native)
  const resolved = await native
  return resolved.match({ ok: value => value, err: () => 0 })
}

export async function runStringAndTemplateIndexHandled(): Promise<number> {
  const first = task.runResult()
  const second = task.runResult()
  const results = await Promise.all([first, second])
  return results["0"].match({ ok: value => value, err: () => 0 }) + results[` + "`1`" + `].match({ ok: value => value, err: () => 0 })
}

export async function runConstIndexPartialUnhandled(): Promise<number> {
  const handledFirst = task.runResult()
  const ignoredSecond = task.runResult()
  const results = await Promise.all([handledFirst, ignoredSecond])
  const idx = 0
  return results[idx].match({ ok: value => value, err: () => 0 })
}

export async function runDynamicIndexUnhandled(): Promise<number | undefined> {
  const dynamicFirst = task.runResult()
  const results = await Promise.all([dynamicFirst])
  return results[dynamicIdx]?.match({ ok: value => value, err: () => 0 })
}

export function runPromiseAllThenIgnoredCallback(): Promise<number> {
  const ignoredAllFirst = task.runResult()
  const ignoredAllSecond = task.runResult()
  return Promise.all([ignoredAllFirst, ignoredAllSecond]).then(() => 0)
}

export function runDirectThenIgnoredCallback(): PromiseLike<number> {
  const ignoredDirectThen = task.runResult()
  return ignoredDirectThen.then(() => 0)
}

export async function runTupleMapIgnoredCallback(): Promise<number[]> {
  const ignoredMapFirst = task.runResult()
  const results = await Promise.all([ignoredMapFirst])
  return results.map(() => 0)
}

export async function runTupleMapHandledCallback(): Promise<number[]> {
  const handledMapFirst = task.runResult()
  const results = await Promise.all([handledMapFirst])
  return results.map(item => item.match({ ok: value => value, err: () => 0 }))
}

export function runPromiseAllThenForwardTupleThenIgnored(): Promise<number> {
  const ignoredForwardFirst = task.runResult()
  const ignoredForwardSecond = task.runResult()
  return Promise.all([ignoredForwardFirst, ignoredForwardSecond]).then(results => results).then(() => 0)
}

export function runPromiseAllThenForwardDestructuredPartial(): Promise<number> {
  const handledDestructuredForwardFirst = task.runResult()
  const ignoredDestructuredForwardSecond = task.runResult()
  return Promise.all([handledDestructuredForwardFirst, ignoredDestructuredForwardSecond])
    .then(([x, y]) => [x, y] as const)
    .then(([u]) => u.match({ ok: value => value, err: () => 0 }))
}

export async function runTupleForEachIdentityUnhandled(): Promise<void> {
  const ignoredForEachIdentity = task.runResult()
  const results = await Promise.all([ignoredForEachIdentity])
  results.forEach(item => item)
}

export function runDirectThenSwallowedBeforeOuterChain(): Promise<number> {
  const swallowedBeforeOuter = task.runResult()
  const replacement = task.runResult()
  return swallowedBeforeOuter
    .then(() => replacement)
    .then(resolved => resolved.match({ ok: value => value, err: () => 0 }))
}

export async function runRestDestructuringPartialUnhandled(): Promise<number> {
  const restHandledFirst = task.runResult()
  const restHandledSecond = task.runResult()
  const restIgnoredThird = task.runResult()
  const [first, ...rest] = await Promise.all([restHandledFirst, restHandledSecond, restIgnoredThird])
  return first.match({ ok: value => value, err: () => 0 }) + rest[0].match({ ok: value => value, err: () => 0 })
}

export async function runPromiseAllVarSelfCycleUnhandled(): Promise<void> {
  const pendingAllCycleUnhandled = task.runResult()
  var all = Promise.all([pendingAllCycleUnhandled])
  var all = all
  await all
}

export async function runVarAwaitSameSymbolUnhandled(): Promise<void> {
  var pendingVarAwaitUnhandled = task.runResult()
  var pendingVarAwaitUnhandled = await pendingVarAwaitUnhandled
}

export async function runVarAwaitSameSymbolHandled(): Promise<number> {
  var pendingVarAwaitHandled = task.runResult()
  var pendingVarAwaitHandled = await pendingVarAwaitHandled
  return pendingVarAwaitHandled.match({ ok: value => value, err: () => 0 })
}

export async function runVarPromiseAllDestructuredSameSymbolUnhandled(): Promise<void> {
  var pendingVarAllUnhandled = task.runResult()
  var [pendingVarAllUnhandled] = await Promise.all([pendingVarAllUnhandled])
}

export async function runVarPromiseAllDestructuredSameSymbolHandled(): Promise<number> {
  var pendingVarAllHandled = task.runResult()
  var [pendingVarAllHandled] = await Promise.all([pendingVarAllHandled])
  return pendingVarAllHandled.match({ ok: value => value, err: () => 0 })
}

declare const declaredZeroIdx: 0
declare function produceZero(): 0

export async function runUnaryAndLiteralTypedIndicesHandled(paramIdx: 0): Promise<number> {
  const unaryPlusZero = task.runResult()
  const unaryMinusZero = task.runResult()
  const constTypedZero = task.runResult()
  const letTypedZero = task.runResult()
  const paramTypedZero = task.runResult()
  const declaredTypedZero = task.runResult()
  const floatLiteralZero = task.runResult()
  const unaryPlusFloatZero = task.runResult()

  const r1 = await Promise.all([unaryPlusZero])
  const r2 = await Promise.all([unaryMinusZero])
  const r3 = await Promise.all([constTypedZero])
  const r4 = await Promise.all([letTypedZero])
  const r5 = await Promise.all([paramTypedZero])
  const r6 = await Promise.all([declaredTypedZero])
  const r7 = await Promise.all([floatLiteralZero])
  const r8 = await Promise.all([unaryPlusFloatZero])

  const constIdx: 0 = produceZero()
  let letIdx: 0 = 0

  return (
    r1[+0].match({ ok: value => value, err: () => 0 }) +
    r2[-0].match({ ok: value => value, err: () => 0 }) +
    r3[constIdx].match({ ok: value => value, err: () => 0 }) +
    r4[letIdx].match({ ok: value => value, err: () => 0 }) +
    r5[paramIdx].match({ ok: value => value, err: () => 0 }) +
    r6[declaredZeroIdx].match({ ok: value => value, err: () => 0 }) +
    r7[0.0].match({ ok: value => value, err: () => 0 }) +
    r8[+0.0].match({ ok: value => value, err: () => 0 })
  )
}

export function runDeepPromiseAllThenChainHandled(): Promise<number> {
  const first = task.runResult()
  const second = task.runResult()
  return Promise.all([first, second])
    .then(results => results)
    .then(results => results)
    .then(results => results)
    .then(results => results)
    .then(results => results)
    .then(([a, b]) => a.match({ ok: value => value, err: () => 0 }) + b.match({ ok: value => value, err: () => 0 }))
}

export function runDeepSingleThenChainHandled(): PromiseLike<number> {
  const single = task.runResult()
  return single
    .then(result => result)
    .then(result => result)
    .then(result => result)
    .then(result => result)
    .then(result => result.match({ ok: value => value, err: () => 0 }))
}

export function runDeepPromiseAllThenChainPartialUnhandled(): Promise<number> {
  const deepHandledFirst = task.runResult()
  const deepIgnoredSecond = task.runResult()
  return Promise.all([deepHandledFirst, deepIgnoredSecond])
    .then(results => results)
    .then(results => results)
    .then(results => results)
    .then(results => results)
    .then(([a]) => a.match({ ok: value => value, err: () => 0 }))
}

export async function runMutualVarCycleAndSelfReassignUnhandled(): Promise<void> {
  const mutualCyclePending = task.runResult()
  var a = Promise.all([mutualCyclePending])
  var b = a.then(results => results)
  var a = b.then(results => results)
  var b = a.then(results => results)
  await a

  var pendingVarAllThenUnhandled = task.runResult()
  var [pendingVarAllThenUnhandled] = await Promise.all([pendingVarAllThenUnhandled]).then(results => results)

  var pendingVarElementAccessUnhandled = task.runResult()
  var pendingVarElementAccessUnhandled = (await Promise.all([pendingVarElementAccessUnhandled]))[0]

  const pendingVarResolveUnhandled = task.runResult()
  var results = await Promise.all([pendingVarResolveUnhandled])
  var results = await Promise.resolve(results)
}

export function runNestedPromiseResolveCompositionHandled(): Promise<number> {
  const a = task.runResult()
  const b = task.runResult()
  const handlers = { ok: (value: number) => value, err: () => 0 }
  return Promise.all([a, b]).then(results =>
    Promise.resolve(results).then(([x, y]) =>
      x.match(handlers) + y.match(handlers)
    )
  )
}

export async function runPromiseResolveTupleVariantsHandled(): Promise<number> {
  const c = task.runResult()
  const d = task.runResult()
  const e = task.runResult()
  const f = task.runResult()
  const g = task.runResult()
  const h = task.runResult()
  const handlers = { ok: (value: number) => value, err: () => 0 }

  const v1 = await Promise.all([c, d])
    .then(results => Promise.resolve(results))
    .then(([x, y]) => x.match(handlers) + y.match(handlers))

  const v2 = await Promise.resolve(await Promise.all([e, f])).then(
    ([x, y]) => x.match(handlers) + y.match(handlers)
  )

  const tuple = await Promise.all([g, h])
  const resolved = Promise.resolve(tuple)
  const v3 = await resolved.then(([x, y]) => x.match(handlers) + y.match(handlers))

  return v1 + v2 + v3
}

export function runNestedPromiseResolveCompositionPartialUnhandled(): Promise<number> {
  const nestedResolvedHandledFirst = task.runResult()
  const nestedResolvedIgnoredSecond = task.runResult()
  const handlers = { ok: (value: number) => value, err: () => 0 }
  return Promise.all([nestedResolvedHandledFirst, nestedResolvedIgnoredSecond]).then(results =>
    Promise.resolve(results).then(([x, _y]) => x.match(handlers))
  )
}

export async function runNestedPromiseAllAndAliasHandled(): Promise<number> {
  const p1 = task.runResult()
  const p2 = task.runResult()
  const p3 = task.runResult()
  const p4 = task.runResult()
  const handlers = { ok: (value: number) => value, err: () => 0 }

  const v1 = await Promise.all([p1, p2]).then(results =>
    Promise.all(results).then(([x, y]) => {
      const aliasX = x
      const aliasY = y
      return aliasX.match(handlers) + aliasY.match(handlers)
    })
  )

  const v2 = await Promise.all(await Promise.all([p3, p4])).then(
    ([x, y]) => x.match(handlers) + y.match(handlers)
  )

  const p5 = task.runResult()
  const p6 = task.runResult()
  const v3 = await Promise.all([p5, p6]).then(([x, y]) => {
    const pair = [x, y] as const
    return Promise.resolve(pair).then(([u, v]) => u.match(handlers) + v.match(handlers))
  })

  return v1 + v2 + v3
}

export function runPassthroughThenChain(): PromiseLike<number> {
  const pending = task.runResult()
  const handlers = { ok: (value: number) => value, err: () => 0 }
  return pending.then().then(result => result.match(handlers))
}

export function runPassthroughThenReturn(): PromiseLike<Result<number, string>> {
  const pending = task.runResult()
  return pending.then()
}

export function runNullFulfilledThenReturn(
  recover: (reason: unknown) => PromiseLike<never>
): PromiseLike<Result<number, string>> {
  const pending = task.runResult()
  return pending.then(null, recover)
}

export function runUndefinedFulfilledThenChain(
  recover: (reason: unknown) => PromiseLike<never>
): PromiseLike<number> {
  const pending = task.runResult()
  const handlers = { ok: (value: number) => value, err: () => 0 }
  return pending.then(undefined, recover).then(result => result.match(handlers))
}

export function runPromiseAllPassthroughThen(
  recover: (reason: unknown) => PromiseLike<never>
): PromiseLike<number> {
  const a = task.runResult()
  const b = task.runResult()
  const handlers = { ok: (value: number) => value, err: () => 0 }
  return Promise.all([a, b])
    .then()
    .then(null, recover)
    .then(([x, y]) => x.match(handlers) + y.match(handlers))
}

export function runNamedCallbacksHandled(): PromiseLike<number> {
  const pending1 = task.runResult()
  const pending2 = task.runResult()
  const pending3 = task.runResult()
  const allFirst = task.runResult()
  const allSecond = task.runResult()
  const handlers = { ok: (value: number) => value, err: () => 0 }

  function handleResultFn(result: Result<number, string>): number {
    return result.match(handlers)
  }
  const handleResultConst = (result: Result<number, string>): number => result.match(handlers)
  const forwardResult = (result: Result<number, string>): Result<number, string> => result
  function handlePair([x, y]: [Result<number, string>, Result<number, string>]): number {
    return x.match(handlers) + y.match(handlers)
  }

  function handleTuple(results: [Result<number, string>, Result<number, string>]): number {
    return results[0].match(handlers) + results[1].match(handlers)
  }

  void pending1.then(handleResultFn)
  void pending2.then(handleResultConst)
  void Promise.all([allFirst, allSecond]).then(handlePair)
  void Promise.all([task.runResult(), task.runResult()]).then(handleTuple)
  return pending3.then(forwardResult).then(handleResultFn)
}

export function runShadowedUndefinedInspectingCallback(): PromiseLike<number> {
  const pending = task.runResult()
  const handlers = { ok: (value: number) => value, err: () => 0 }
  function undefined(result: Result<number, string>): number {
    return result.match(handlers)
  }
  return pending.then(undefined)
}

export function runToStringDiscarded(): string {
  const toStringAssignedUnhandled = task.runResult()
  const toStringDirectUnhandled = task.runResult()
  const label = toStringAssignedUnhandled.toString()
  if (dynamicIdx > 0) {
    return toStringDirectUnhandled.toString()
  }
  return label
}

export function runNamedCallbackAndShadowedUndefinedUnhandled(): PromiseLike<number> {
  const namedIgnoredCallback = task.runResult()
  const namedForwardIgnored = task.runResult()
  const namedReassignedLet = task.runResult()
  const namedAllHandledFirst = task.runResult()
  const namedAllIgnoredSecond = task.runResult()
  const shadowedUndefinedFnUnhandled = task.runResult()
  const shadowedUndefinedConstUnhandled = task.runResult()
  const handlers = { ok: (value: number) => value, err: () => 0 }

  function ignoreResult(_result: Result<number, string>): number {
    return 0
  }
  const forwardResult = (result: Result<number, string>): Result<number, string> => result
  let mutableHandler = (result: Result<number, string>): number => result.match(handlers)
  mutableHandler = () => 0
  function handleOnlyFirst([x, _y]: [Result<number, string>, Result<number, string>]): number {
    return x.match(handlers)
  }
  function undefined(): number {
    return 0
  }

  void namedIgnoredCallback.then(ignoreResult)
  void namedForwardIgnored.then(forwardResult).then(ignoreResult)
  void namedReassignedLet.then(mutableHandler)
  void Promise.all([namedAllHandledFirst, namedAllIgnoredSecond]).then(handleOnlyFirst)
  void shadowedUndefinedFnUnhandled.then(undefined)
  {
    const undefined = () => 0
    return shadowedUndefinedConstUnhandled.then(undefined)
  }
}

export function runThenWrappedInObjectOrConditionalUnhandled(
  recover: (reason: unknown) => PromiseLike<never>
): PromiseLike<number> {
  const wrappedInObjectUnhandled = task.runResult()
  const conditionalUnionUnhandled = task.runResult()
  const pairHandledFirst = task.runResult()
  const pairIgnoredSecond = task.runResult()
  const ignoredPassthroughThen = task.runResult()
  const ignoredNullThen = task.runResult()
  const ignoredPassthroughChain = task.runResult()
  const handlers = { ok: (value: number) => value, err: () => 0 }
  void Promise.all([pairHandledFirst, pairIgnoredSecond]).then(([x, y]) => {
    const pair = [x, y] as const
    return Promise.resolve(pair).then(([u, _v]) => u.match(handlers))
  })
  void wrappedInObjectUnhandled.then(x => ({ x })).then(() => 0)
  ignoredPassthroughThen.then()
  ignoredNullThen.then(null, recover)
  void ignoredPassthroughChain.then().then(() => 0)
  return conditionalUnionUnhandled.then(x => (dynamicIdx > 0 ? x : 0)).then(() => 0)
}

export function runCallAndMemberCallbacksHandled(): PromiseLike<number> {
  const pendingMatch = task.runResult()
  const pendingUnwrapOr = task.runResult()
  const pendingMapThenMatch = task.runResult()
  const pendingNamespaceFold = task.runResult()
  const pendingNamespaceBracketFold = task.runResult()
  const pendingDirectImportedFold = task.runResult()
  const pendingObjectFold = task.runResult()
  const pendingDestructuredFold = task.runResult()
  const pendingHigherOrder = task.runResult()
  const pendingNamespaceMatchAlias = task.runResult()
  const combineFirst = task.runResult()
  const combineSecond = task.runResult()
  const pendingCurriedArrowMatch = task.runResult()
  const pendingCurriedBlockMatch = task.runResult()
  const pendingCurriedMapThenMatch = task.runResult()
  const pendingIdentityThenMatch = task.runResult()
  const pendingInlineIdentityThenMatch = task.runResult()
  const pendingIdentityWrappedMatch = task.runResult()
  const pendingIdentityReceiverMatch = task.runResult()
  const pendingFlowMatch = task.runResult()
  const pendingFlowMapMatch = task.runResult()
  const pendingPipeMatch = task.runResult()
  const pendingIdentityWrappedTarget = task.runResult()
  const allIdentityFirst = task.runResult()
  const allIdentitySecond = task.runResult()
  const pendingSafeDerivedFold = task.runResult()
  const pendingGoodSpreadFold = task.runResult()

  const handlers = { ok: (value: number) => value, err: () => 0 }
  const tupleHandlers = { ok: (values: number[]) => values.length, err: () => 0 }
  const localBox = {
    fold: foldImported,
  }
  const { fold: destructuredFold } = localBox
  const makeHandler = () => (result: Result<number, Error>) => result.match(handlers)

  class SafeBase {
    fold(result: Result<number, Error>): number {
      return result.match(handlers)
    }
  }
  class SafeDerived extends SafeBase {
    override fold(result: Result<number, Error>): number {
      return result.match({ ok: value => value + 1, err: () => 0 })
    }
  }
  const safeHandler: SafeBase = new SafeDerived()
  const badBaseObj = { fold: (_r: Result<number, Error>) => 0 }
  const goodSpreadObj: typeof badBaseObj = { ...badBaseObj, fold: foldImported }

  void pendingMatch.then(Result.match(handlers))
  void pendingUnwrapOr.then(Result.unwrapOr(0))
  void pendingMapThenMatch.then(Result.map((value: number) => value + 1)).then(Result.match(handlers))
  void pendingNamespaceFold.then(namespace.foldImported)
  void pendingNamespaceBracketFold.then(namespace["foldImported"])
  void pendingDirectImportedFold.then(foldImported)
  void pendingObjectFold.then(localBox.fold)
  void pendingDestructuredFold.then(destructuredFold)
  void pendingHigherOrder.then(makeHandler())
  void Promise.all([combineFirst, combineSecond]).then(Result.combine).then(Result.match(tupleHandlers))
  void pendingCurriedArrowMatch.then(r => Result.match(handlers)(r))
  void pendingCurriedBlockMatch.then(r => {
    return Result.match(handlers)(r)
  })
  void pendingCurriedMapThenMatch.then(r => Result.map((value: number) => value + 1)(r)).then(Result.match(handlers))
  void pendingIdentityThenMatch.then(identity).then(Result.match(handlers))
  void pendingInlineIdentityThenMatch.then(r => identity(r)).then(Result.match(handlers))
  void pendingIdentityWrappedMatch.then(identity(Result.match(handlers)))
  void pendingIdentityReceiverMatch.then(r => identity(r).match(handlers))
  void pendingFlowMatch.then(flow(identity, Result.match(handlers)))
  void pendingFlowMapMatch.then(flow(Result.map((value: number) => value + 1), Result.match(handlers)))
  void pendingPipeMatch.then(r => pipe(r, identity, Result.match(handlers)))
  void identity(pendingIdentityWrappedTarget).then(Result.match(handlers))
  void Promise.all([allIdentityFirst, allIdentitySecond])
    .then(identity)
    .then(([x, y]) => x.match(handlers) + y.match(handlers))
  void pendingSafeDerivedFold.then(safeHandler.fold)
  void pendingGoodSpreadFold.then(goodSpreadObj.fold)
  return pendingNamespaceMatchAlias.then(namespace.matchAlias(handlers))
}

export function runCallAndMemberCallbacksUnhandled(): PromiseLike<number> {
  const curriedMapThenIgnored = task.runResult()
  const namespaceIgnoreUnhandled = task.runResult()
  const mutatedObjectFoldUnhandled = task.runResult()
  const mutatedBracketObjectFoldUnhandled = task.runResult()
  const higherOrderIgnoredUnhandled = task.runResult()
  const combineThenIgnoredFirst = task.runResult()
  const combineThenIgnoredSecond = task.runResult()
  const shadowedResultMatchUnhandled = task.runResult()
  const aliasMutatedFoldUnhandled = task.runResult()
  const objectAssignMutatedFoldUnhandled = task.runResult()
  const reflectSetMutatedFoldUnhandled = task.runResult()
  const helperMutatedFoldUnhandled = task.runResult()
  const overriddenMethodViaBaseAnnotationUnhandled = task.runResult()
  const overriddenMethodViaAsCastUnhandled = task.runResult()
  const overriddenSpreadObjectUnhandled = task.runResult()
  const localClassResultMatchUnhandled = task.runResult()
  const curriedMapArrowThenIgnoredUnhandled = task.runResult()
  const identityChainThenIgnoredUnhandled = task.runResult()
  const pendingBareIdentityThenUnhandled = task.runResult()
  const flowMapThenIgnoredUnhandled = task.runResult()

  const handlers = { ok: (value: number) => value, err: () => 0 }

  const mutableBox: { fold: (result: Result<number, Error>) => number } = {
    fold: foldImported,
  }
  mutableBox.fold = () => 0

  const bracketBox: Record<string, (result: Result<number, Error>) => number> = {
    fold: foldImported,
  }
  bracketBox["fold"] = () => 0

  const aliasedBox: { fold: (result: Result<number, Error>) => number } = {
    fold: foldImported,
  }
  const boxAlias = aliasedBox
  boxAlias.fold = () => 0

  const assignedBox: { fold: (result: Result<number, Error>) => number } = {
    fold: foldImported,
  }
  Object.assign(assignedBox, { fold: () => 0 })

  const reflectBox: { fold: (result: Result<number, Error>) => number } = {
    fold: foldImported,
  }
  Reflect.set(reflectBox, "fold", () => 0)

  const passedBox: { fold: (result: Result<number, Error>) => number } = {
    fold: foldImported,
  }
  function clobberBox(target: { fold: (result: Result<number, Error>) => number }) {
    target.fold = () => 0
  }
  clobberBox(passedBox)

  class BaseHandler {
    fold(result: Result<number, Error>): number {
      return result.match(handlers)
    }
  }
  class DerivedHandler extends BaseHandler {
    override fold(_result: Result<number, Error>): number {
      return 0
    }
  }
  const baseTypedHandler: BaseHandler = new DerivedHandler()

  function runWithBaseParam(h: BaseHandler) {
    const overriddenMethodViaParameterUnhandled = task.runResult()
    void overriddenMethodViaParameterUnhandled.then(h.fold)
  }
  runWithBaseParam(new DerivedHandler())

  const baseObj: { fold: (result: Result<number, Error>) => number } = { fold: foldImported }
  const spreadOverriddenObj: typeof baseObj = { ...baseObj, fold: () => 0 }

  function runWithFakeResultParam(Result: { match: (_h: unknown) => (_r: Result<number, Error>) => number }) {
    const paramResultMatchUnhandled = task.runResult()
    void paramResultMatchUnhandled.then(Result.match(handlers))
  }
  runWithFakeResultParam({ match: () => () => 0 })

  const makeIgnoredHandler = () => (_result: Result<number, Error>) => 0

  void curriedMapThenIgnored.then(Result.map((value: number) => value + 1)).then(() => 0)
  void namespaceIgnoreUnhandled.then(namespace.ignoreImported)
  void mutatedObjectFoldUnhandled.then(mutableBox.fold)
  void mutatedBracketObjectFoldUnhandled.then(bracketBox["fold"])
  void aliasMutatedFoldUnhandled.then(aliasedBox.fold)
  void objectAssignMutatedFoldUnhandled.then(assignedBox.fold)
  void reflectSetMutatedFoldUnhandled.then(reflectBox.fold)
  void helperMutatedFoldUnhandled.then(passedBox.fold)
  void overriddenMethodViaBaseAnnotationUnhandled.then(baseTypedHandler.fold)
  void overriddenMethodViaAsCastUnhandled.then((new DerivedHandler() as BaseHandler).fold)
  void overriddenSpreadObjectUnhandled.then(spreadOverriddenObj.fold)
  void higherOrderIgnoredUnhandled.then(makeIgnoredHandler())
  void Promise.all([combineThenIgnoredFirst, combineThenIgnoredSecond]).then(Result.combine).then(() => 0)
  void curriedMapArrowThenIgnoredUnhandled.then(r => Result.map((value: number) => value + 1)(r)).then(() => 0)
  void identityChainThenIgnoredUnhandled.then(identity).then(() => 0)
  pendingBareIdentityThenUnhandled.then(identity)
  void flowMapThenIgnoredUnhandled.then(flow(identity, Result.map((value: number) => value + 1))).then(() => 0)
  {
    class Result {
      static match(_h: unknown) {
        return (_r: unknown) => 0
      }
    }
    void localClassResultMatchUnhandled.then(Result.match(handlers))
  }
  {
    const Result = {
      match: (_h: unknown) => (_r: Result<number, Error>) => 0,
    }
    return shadowedResultMatchUnhandled.then(Result.match({}))
  }
}
`
	directory := writeResultAsyncFixture(t, source)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil || len(diagnostics) != 0 {
		t.Fatalf("open: %v, compiler diagnostics: %v", err, diagnostics)
	}
	options := config.Defaults()
	options.NoUnsafeAwait = config.SeverityOff
	options.PreferResultAsync = config.SeverityOff
	options.NoDiscard = config.SeverityWarning
	options.NoDiscardMode = "must-use"
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	assertInstanceRunnerFindingLines(t, source, findings, []string{
		"await native",
		"const ignoredSecond = task.runResult()",
		"const dynamicFirst = task.runResult()",
		"const ignoredAllFirst = task.runResult()",
		"const ignoredAllSecond = task.runResult()",
		"const ignoredDirectThen = task.runResult()",
		"const ignoredMapFirst = task.runResult()",
		"const ignoredForwardFirst = task.runResult()",
		"const ignoredForwardSecond = task.runResult()",
		"const ignoredDestructuredForwardSecond = task.runResult()",
		"const ignoredForEachIdentity = task.runResult()",
		"const swallowedBeforeOuter = task.runResult()",
		"const restIgnoredThird = task.runResult()",
		"const pendingAllCycleUnhandled = task.runResult()",
		"var pendingVarAwaitUnhandled = task.runResult()",
		"var pendingVarAwaitUnhandled = await pendingVarAwaitUnhandled",
		"var pendingVarAllUnhandled = task.runResult()",
		"var [pendingVarAllUnhandled] = await Promise.all([pendingVarAllUnhandled])",
		"const deepIgnoredSecond = task.runResult()",
		"const mutualCyclePending = task.runResult()",
		"var pendingVarAllThenUnhandled = task.runResult()",
		"var [pendingVarAllThenUnhandled] = await Promise.all([pendingVarAllThenUnhandled]).then(results => results)",
		"var pendingVarElementAccessUnhandled = task.runResult()",
		"var pendingVarElementAccessUnhandled = (await Promise.all([pendingVarElementAccessUnhandled]))[0]",
		"const pendingVarResolveUnhandled = task.runResult()",
		"const nestedResolvedIgnoredSecond = task.runResult()",
		"const toStringAssignedUnhandled = task.runResult()",
		"const toStringDirectUnhandled = task.runResult()",
		"const namedIgnoredCallback = task.runResult()",
		"const namedForwardIgnored = task.runResult()",
		"const namedReassignedLet = task.runResult()",
		"const namedAllIgnoredSecond = task.runResult()",
		"const shadowedUndefinedFnUnhandled = task.runResult()",
		"const shadowedUndefinedConstUnhandled = task.runResult()",
		"const wrappedInObjectUnhandled = task.runResult()",
		"const conditionalUnionUnhandled = task.runResult()",
		"const pairIgnoredSecond = task.runResult()",
		"const ignoredPassthroughThen = task.runResult()",
		"const ignoredNullThen = task.runResult()",
		"const ignoredPassthroughChain = task.runResult()",
		"const curriedMapThenIgnored = task.runResult()",
		"const namespaceIgnoreUnhandled = task.runResult()",
		"const mutatedObjectFoldUnhandled = task.runResult()",
		"const mutatedBracketObjectFoldUnhandled = task.runResult()",
		"const higherOrderIgnoredUnhandled = task.runResult()",
		"const combineThenIgnoredFirst = task.runResult()",
		"const combineThenIgnoredSecond = task.runResult()",
		"const shadowedResultMatchUnhandled = task.runResult()",
		"const aliasMutatedFoldUnhandled = task.runResult()",
		"const objectAssignMutatedFoldUnhandled = task.runResult()",
		"const reflectSetMutatedFoldUnhandled = task.runResult()",
		"const helperMutatedFoldUnhandled = task.runResult()",
		"const overriddenMethodViaBaseAnnotationUnhandled = task.runResult()",
		"const overriddenMethodViaAsCastUnhandled = task.runResult()",
		"const overriddenSpreadObjectUnhandled = task.runResult()",
		"const localClassResultMatchUnhandled = task.runResult()",
		"const curriedMapArrowThenIgnoredUnhandled = task.runResult()",
		"const identityChainThenIgnoredUnhandled = task.runResult()",
		"const pendingBareIdentityThenUnhandled = task.runResult()",
		"const flowMapThenIgnoredUnhandled = task.runResult()",
		"const overriddenMethodViaParameterUnhandled = task.runResult()",
		"const paramResultMatchUnhandled = task.runResult()",
	})
}

func TestNoDiscardRecursiveCallbacksDoNotStackOverflow(t *testing.T) {
	source := `import {Result, identity, type ResultTask} from "resultar"
declare const task: ResultTask<number, Error>
const handlers = { ok: (value: number) => value, err: () => 0 }

const userId = <T>(x: T): T => x
function userIdDecl<T>(x: T): T {
  return x
}
const userIdAlias = userId
const recBadId = <T>(x: T): T => recBadId(x)

function handleRec(r: Result<number, Error>): number {
  return Math.random() > 0.5 ? handleRec(r) : r.match(handlers)
}

const handleArrow = (r: Result<number, Error>): number =>
  Math.random() > 0.5 ? handleArrow(r) : r.match(handlers)

const stepMultiArg = (r: Result<number, Error>, n = 2): number =>
  n > 0 ? stepMultiArg(r, n - 1) : r.match(handlers)

const stepMultiArgSecondPos = (n: number, r: Result<number, Error>): number =>
  n > 0 ? stepMultiArgSecondPos(n - 1, r) : r.match(handlers)

const stepMultiArgUnhandled = (r: Result<number, Error>, n = 2): number =>
  n > 0 ? stepMultiArgUnhandled(r, n - 1) : 0

function mutualA(r: Result<number, Error>): number {
  return Math.random() > 0.5 ? mutualB(r) : r.match(handlers)
}
function mutualB(r: Result<number, Error>): number {
  return Math.random() > 0.5 ? mutualA(r) : r.match(handlers)
}

function makeHandler(n: number): (r: Result<number, Error>) => number {
  return n > 0 ? makeHandler(n - 1) : Result.match(handlers)
}

function makeWrappedHandler(n: number): (r: Result<number, Error>) => number {
  return n > 0 ? userId(makeWrappedHandler(n - 1)).bind(null) : Result.match(handlers)
}

function makeMutualFactoryA(n: number): (r: Result<number, Error>) => number {
  return n > 0 ? makeMutualFactoryB(n - 1) : Result.match(handlers)
}
function makeMutualFactoryB(n: number): (r: Result<number, Error>) => number {
  return n > 0 ? makeMutualFactoryA(n - 1) : Result.match(handlers)
}

function makeReceiver(n: number): { readonly fold: (r: Result<number, Error>) => number } {
  return n > 0 ? userId(makeReceiver(n - 1)) : { fold: Result.match(handlers) }
}

function makeInfiniteHandler(n: number): (r: Result<number, Error>) => number {
  return makeInfiniteHandler(n - 1)
}

function pureRecUnhandled(r: Result<number, Error>): number {
  return pureRecUnhandled(r)
}

function forwardRec(r: Result<number, Error>): Result<number, Error> {
  return Math.random() > 0.5 ? forwardRec(r) : r
}

function handleTupleRec(pair: readonly [Result<number, Error>, Result<number, Error>]): number {
  return Math.random() > 0.5 ? handleTupleRec(pair) : pair[0].match(handlers) + pair[1].match(handlers)
}

const stepTupleMultiArg = (pair: readonly [Result<number, Error>, Result<number, Error>], n = 2): number =>
  n > 0 ? stepTupleMultiArg(pair, n - 1) : pair[0].match(handlers) + pair[1].match(handlers)

export function runRecursiveCallbacks(): PromiseLike<number> {
  const recDeclHandled = task.runResult()
  void recDeclHandled.then(handleRec)

  const recArrowHandled = task.runResult()
  void recArrowHandled.then(handleArrow)

  const stepPointFreeHandled = task.runResult()
  void stepPointFreeHandled.then(stepMultiArg)

  const stepInlineHandled = task.runResult()
  void stepInlineHandled.then((r) => stepMultiArg(r, 2))

  const stepSecondPosHandled = task.runResult()
  void stepSecondPosHandled.then((r) => stepMultiArgSecondPos(2, r))

  const userIdHandled = task.runResult()
  void userIdHandled.then(userId(Result.match(handlers)))

  const userIdDeclHandled = task.runResult()
  void userIdDeclHandled.then(userIdDecl( userIdAlias(Result.match(handlers)) ))

  const mutualHandled = task.runResult()
  void mutualHandled.then(mutualA)

  const factoryHandled = task.runResult()
  void factoryHandled.then(makeHandler(2))

  const wrappedFactoryHandled = task.runResult()
  void wrappedFactoryHandled.then(makeWrappedHandler(2))

  const mutualFactoryHandled = task.runResult()
  void mutualFactoryHandled.then(makeMutualFactoryA(2))

  const receiverFactoryHandled = task.runResult()
  void receiverFactoryHandled.then(makeReceiver(2).fold)

  const forwardThenHandled = task.runResult()
  void forwardThenHandled.then(forwardRec).then(Result.match(handlers))

  const tupleFirstHandled = task.runResult()
  const tupleSecondHandled = task.runResult()
  void Promise.all([tupleFirstHandled, tupleSecondHandled]).then(handleTupleRec)

  const tupleStepFirstHandled = task.runResult()
  const tupleStepSecondHandled = task.runResult()
  void Promise.all([tupleStepFirstHandled, tupleStepSecondHandled]).then((pair) => stepTupleMultiArg(pair, 2))

  const infiniteFactoryUnhandled = task.runResult()
  void infiniteFactoryUnhandled.then(makeInfiniteHandler(2))

  const pureRecTaskUnhandled = task.runResult()
  void pureRecTaskUnhandled.then(pureRecUnhandled)

  const stepPointFreeUnhandled = task.runResult()
  void stepPointFreeUnhandled.then(stepMultiArgUnhandled)

  const stepInlineUnhandled = task.runResult()
  void stepInlineUnhandled.then((r) => stepMultiArgUnhandled(r, 2))

  const recBadIdUnhandled = task.runResult()
  void recBadIdUnhandled.then(recBadId(Result.match(handlers)))

  const forwardBareUnhandled = task.runResult()
  forwardBareUnhandled.then(forwardRec)

  const forwardSwallowedUnhandled = task.runResult()
  void forwardSwallowedUnhandled.then(forwardRec).then(() => 0)

  return identity(task.runResult()).then(handleRec)
}
`
	directory := writeResultAsyncFixture(t, source)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil || len(diagnostics) != 0 {
		t.Fatalf("open: %v, compiler diagnostics: %v", err, diagnostics)
	}
	options := config.Defaults()
	options.NoUnsafeAwait = config.SeverityOff
	options.PreferResultAsync = config.SeverityOff
	options.NoDiscard = config.SeverityWarning
	options.NoDiscardMode = "must-use"
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	assertInstanceRunnerFindingLines(t, source, findings, []string{
		"const infiniteFactoryUnhandled = task.runResult()",
		"const pureRecTaskUnhandled = task.runResult()",
		"const stepPointFreeUnhandled = task.runResult()",
		"const stepInlineUnhandled = task.runResult()",
		"const recBadIdUnhandled = task.runResult()",
		"const forwardBareUnhandled = task.runResult()",
		"const forwardSwallowedUnhandled = task.runResult()",
	})
}

func TestNoDiscardCurriedCallbacksScaleLinearly(t *testing.T) {
	var b strings.Builder
	b.WriteString(`import {Result, type ResultTask} from "resultar"` + "\n")
	b.WriteString(`declare const task: ResultTask<number, Error>` + "\n")
	b.WriteString(`export function runMany(): void {` + "\n")
	for i := range 500 {
		fmt.Fprintf(&b, "  const p_%d = task.runResult()\n", i)
		fmt.Fprintf(&b, "  void p_%d.then(Result.match({ ok: (x: number) => x, err: () => 0 }))\n", i)
	}
	b.WriteString("}\n")
	source := b.String()

	t.Run("package declaration files", func(t *testing.T) {
		directory := writeResultAsyncFixture(t, source)
		opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
		if err != nil || len(diagnostics) != 0 {
			t.Fatalf("open: %v, compiler diagnostics: %v", err, diagnostics)
		}
		options := config.Defaults()
		options.NoUnsafeAwait = config.SeverityOff
		options.PreferResultAsync = config.SeverityOff
		options.NoDiscard = config.SeverityWarning
		options.NoDiscardMode = "must-use"
		findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
		if err != nil {
			t.Fatal(err)
		}
		if len(findings) != 0 {
			t.Fatalf("expected 0 findings for 500 curried Result.match calls, got %d", len(findings))
		}
	})

	t.Run("workspace source files", func(t *testing.T) {
		directory := t.TempDir()
		workspacePkg := `export interface Result<T, E> {
  readonly value: T
  readonly error: E
  match<U>(handlers: { readonly ok: (value: T) => U; readonly err: (error: E) => U }): U
}
export class BaseResult<T, E> {
  match<U>(handlers: { readonly ok: (value: T) => U; readonly err: (error: E) => U }): U {
    return handlers.ok(undefined as unknown as T)
  }
}
export const Result = {
  match<T, E, U>(handlers: { readonly ok: (value: T) => U; readonly err: (error: E) => U }): (result: Result<T, E>) => U {
    return (result) => result.match(handlers)
  },
}
export interface ResultAsync<T, E> extends PromiseLike<Result<T, E>> {}
export interface ResultTask<T, E> {
  readonly task: () => Result<T, E>
  runResult(): ResultAsync<T, E>
}
`
		files := map[string]string{
			"tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "paths": {
      "resultar": ["./packages/resultar/src/index.ts"]
    }
  },
  "include": ["src/**/*.ts", "packages/**/*.ts"]
}`,
			"packages/resultar/src/index.ts": workspacePkg,
			"src/index.ts":                   source,
		}
		for name, contents := range files {
			path := filepath.Join(directory, name)
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
		if err != nil || len(diagnostics) != 0 {
			t.Fatalf("open: %v, compiler diagnostics: %v", err, diagnostics)
		}
		options := config.Defaults()
		options.NoUnsafeAwait = config.SeverityOff
		options.PreferResultAsync = config.SeverityOff
		options.NoDiscard = config.SeverityWarning
		options.NoDiscardMode = "must-use"
		findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
		if err != nil {
			t.Fatal(err)
		}
		if len(findings) != 0 {
			t.Fatalf("expected 0 findings for 500 workspace curried Result.match calls, got %d", len(findings))
		}
	})
}

