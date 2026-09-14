package analyzer

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/microsoft/typescript-go/resultar-check/internal/config"
	"github.com/microsoft/typescript-go/resultar-check/internal/project"
)

const resultAsyncTypes = `
export interface Result<T, E> { readonly value: T; readonly error: E }
export type StrictResult<T, E extends Error> = Result<T, E>
export interface ResultAsync<T, E> extends PromiseLike<Result<T, E>> {
  map<U>(fn: (value: T) => U): ResultAsync<U, E>
}
export type StrictResultAsync<T, E extends Error> = ResultAsync<T, E>
export interface ResultTask<T, E> { readonly task: () => Result<T, E> }
export declare function ok<T>(value: T): Result<T, never>
export declare function fromPromise<T, E>(value: Promise<T>, mapError: (cause: unknown) => E): ResultAsync<T, E>
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
