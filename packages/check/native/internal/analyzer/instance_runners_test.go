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

const instanceRunnerAPIFixture = `
export interface Result<A, E = never> { readonly value: A; readonly error: E }
export interface Exit<A, E> { readonly valueType: A; readonly errorType: E; readonly _tag: 'Success' | 'Failure' }
export interface FiberHandle<A, E> { readonly valueType: A; readonly errorType: E }
type RunOptions<R> = [R] extends [never] ? { readonly services?: never } : { readonly services: R }
type RunArguments<R> = [R] extends [never] ? [options?: RunOptions<R>] : [options: RunOptions<R>]
export declare class ResultTask<A, E = never, R = never> {
  readonly valueType: A
  readonly errorType: E
  readonly requirements: R
  map<B>(fn: (value: A) => B): ResultTask<B, E, R>
  runResult(...args: RunArguments<R>): Promise<Result<A, E>>
  runPromise(...args: RunArguments<R>): Promise<A>
  runExit(...args: RunArguments<R>): Promise<Exit<A, E>>
  runFork(...args: RunArguments<R>): FiberHandle<A, E>
  static ok<A>(value: A): ResultTask<A>
  static gen<Y, A>(body: () => Generator<Y, A, unknown>): ResultTask<A>
  static fn<Y, A>(body: () => Generator<Y, A, unknown>): () => ResultTask<A>
  static runResult<A, E>(task: ResultTask<A, E>): Promise<Result<A, E>>
  static runPromise<A, E>(task: ResultTask<A, E>): Promise<A>
  static runExit<A, E>(task: ResultTask<A, E>): Promise<Exit<A, E>>
  static runFork<A, E>(task: ResultTask<A, E>): FiberHandle<A, E>
  [Symbol.iterator](): Generator<unknown, A, unknown>
}
export declare const Result: {
  gen<Y, A>(body: () => Generator<Y, A, unknown>): Result<A, never>
  fn<Y, A>(body: () => Generator<Y, A, unknown>): () => Result<A, never>
}
export declare function safeTry<Y, A, E>(body: () => Generator<Y, Result<A, E>, unknown>): Result<A, E>
`

func TestNoDiscardConsumesInstanceTaskRunners(t *testing.T) {
	source := `
import { ResultTask as Task } from './api.js'
const resultTask = Task.ok(1)
resultTask.runResult()
const promiseTask = Task.ok(2)
promiseTask.runPromise()
const exitTask = Task.ok(3)
exitTask.runExit()
const forkTask = Task.ok(4)
forkTask.runFork()
const chainedTask = Task.ok(5)
chainedTask.map(value => value + 1).runResult()
declare function needsServices(): Task<number, string, { Logger: { info(message: string): void } }>
const serviceTask = needsServices()
serviceTask.runResult({ services: { Logger: { info: () => {} } } })
const unrunTask = Task.ok(6)
`
	options := config.Defaults()
	options.NoDiscard = config.SeverityWarning
	options.NoDiscardMode = "must-use"
	findings := instanceRunnerFindings(t, source, options, "no-discard")
	assertInstanceRunnerFindingLines(t, source, findings, []string{"const unrunTask = Task.ok(6)"})
}

func TestNoDiscardDoesNotConsumeUnrelatedInstanceRunners(t *testing.T) {
	for _, method := range []string{"runResult", "runPromise", "runExit", "runFork"} {
		t.Run(method, func(t *testing.T) {
			source := fmt.Sprintf(`
import { Result, ResultTask as Task } from './api.js'
declare function resultWithRunner(): Result<number, string> & { %s(): void }
const unrelatedResult = resultWithRunner()
unrelatedResult.%s()
declare const other: { %s(task: Task<number>): void }
const unconsumedTask = Task.ok(1)
other.%s(unconsumedTask)
`, method, method, method, method)
			options := config.Defaults()
			options.NoDiscard = config.SeverityWarning
			options.NoDiscardMode = "must-use"
			findings := instanceRunnerFindings(t, source, options, "no-discard")
			assertInstanceRunnerFindingLines(t, source, findings, []string{
				"const unrelatedResult = resultWithRunner()",
				"const unconsumedTask = Task.ok(1)",
			})
		})
	}
}

func TestNoRunInsideGenRecognizesInstanceRunners(t *testing.T) {
	for _, test := range []struct{ name, generator, result string }{
		{"ResultTask.gen alias", "Task.gen", "1"},
		{"ResultTask.fn alias", "Task.fn", "1"},
		{"Result.gen alias", "Results.gen", "1"},
		{"Result.fn alias", "Results.fn", "1"},
		{"safeTry alias", "legacy", "{ value: 1, error: 'legacy' }"},
		{"ResultTask namespace", "api.ResultTask.gen", "1"},
		{"ResultTask reexport", "Work.gen", "1"},
	} {
		t.Run(test.name, func(t *testing.T) {
			source := fmt.Sprintf(`
import { ResultTask as Task, Result as Results, safeTry as legacy } from './api.js'
import * as api from './api.js'
import { Work } from './barrel.js'
declare const task: Task<number, string, { Logger: { info(message: string): void } }>
declare const other: { runResult(): void; runPromise(): void; runExit(): void; runFork(): void }
const options = { services: { Logger: { info: () => {} } } }
void %s(function* () {
  task.runResult(options)
  task.runPromise(options)
  task.runExit(options)
  task.runFork(options)
  other.runResult()
  other.runPromise()
  other.runExit()
  other.runFork()
  const deferred = () => task.runResult(options)
  void deferred
  return %s
})
`, test.generator, test.result)
			options := config.Defaults()
			options.NoDiscard = config.SeverityOff
			options.NoRunInsideGen = config.SeverityWarning
			findings := instanceRunnerFindings(t, source, options, "no-run-inside-gen")
			assertInstanceRunnerFindingLines(t, source, findings, []string{
				"task.runResult(options)",
				"task.runPromise(options)",
				"task.runExit(options)",
				"task.runFork(options)",
			})
			for _, finding := range findings {
				if len(finding.Fixes) != 0 {
					t.Fatalf("executing a runner is not a safe automatic rewrite: %#v", finding)
				}
			}
		})
	}
}

func TestNoUnsafeAwaitInstanceTaskRunners(t *testing.T) {
	source := `
import { Result, ResultTask as Task } from './api.js'
declare const task: Task<number, string>
declare const withServices: Task<number, string, { Logger: { info(message: string): void } }>
declare const other: { runResult(): Promise<number>; runExit(): Promise<void>; runPromise(): Promise<number>; runFork(): Promise<void> }
declare const mixedReceiver: Task<number> | { runExit(): Promise<void> }
async function main(): Promise<Result<number, string>> {
  await task.runResult()
  await task.runExit()
  await task.runPromise()
  await Task.runResult(task)
  await Task.runExit(task)
  await Task.runPromise(task)
  await withServices.runResult({ services: { Logger: { info: () => {} } } })
  await withServices.runExit({ services: { Logger: { info: () => {} } } })
  await withServices.runPromise({ services: { Logger: { info: () => {} } } })
  await other.runResult()
  await other.runExit()
  await other.runPromise()
  await other.runFork()
  await mixedReceiver.runExit()
  return { value: 1, error: 'done' }
}
`
	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.NoUnsafeAwait = config.SeverityWarning
	options.NoUnsafeAwaitMode = "all"
	findings := instanceRunnerFindings(t, source, options, "no-unsafe-await")
	assertInstanceRunnerFindingLines(t, source, findings, []string{
		"await task.runPromise()",
		"await Task.runPromise(task)",
		"await withServices.runPromise({ services: { Logger: { info: () => {} } } })",
		"await other.runResult()",
		"await other.runExit()",
		"await other.runPromise()",
		"await other.runFork()",
		"await mixedReceiver.runExit()",
	})
}

func TestNoUnsafeAwaitInstanceRunResultPreservesRawPromiseBoundaryPolicy(t *testing.T) {
	source := `
import { ResultTask as Task } from './api.js'
declare const task: Task<number, string>
async function main() {
  await task.runResult()
  await Task.runResult(task)
}
`
	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.NoUnsafeAwait = config.SeverityWarning
	options.NoUnsafeAwaitMode = "all"
	findings := instanceRunnerFindings(t, source, options, "no-unsafe-await")
	assertInstanceRunnerFindingLines(t, source, findings, []string{
		"await task.runResult()",
		"await Task.runResult(task)",
	})
	for _, finding := range findings {
		if !strings.HasPrefix(finding.Message, "Do not unwrap a Resultar async value") {
			t.Fatalf("runResult must keep the existing channel diagnostic: %#v", finding)
		}
	}
}

func instanceRunnerFindings(t *testing.T, source string, options config.Options, rule string) []Finding {
	t.Helper()
	directory := writeFixture(t, source)
	for name, content := range map[string]string{
		"api.ts":    instanceRunnerAPIFixture,
		"barrel.ts": `export { ResultTask as Work } from './api.js'`,
	} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}
	options.UnusedSuppression = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	filtered := make([]Finding, 0)
	for _, finding := range findings {
		if finding.Rule == rule {
			filtered = append(filtered, finding)
		}
	}
	return filtered
}

func assertInstanceRunnerFindingLines(t *testing.T, source string, findings []Finding, expected []string) {
	t.Helper()
	if len(findings) != len(expected) {
		t.Fatalf("got %d findings, want %d: %#v", len(findings), len(expected), findings)
	}
	lines := strings.Split(source, "\n")
	for index, finding := range findings {
		if filepath.Base(finding.File) != "fixture.ts" || finding.Line < 1 || finding.Line > len(lines) {
			t.Fatalf("unexpected finding location: %#v", finding)
		}
		if actual := strings.TrimSpace(lines[finding.Line-1]); actual != expected[index] {
			t.Errorf("finding %d on %q, want %q: %#v", index, actual, expected[index], finding)
		}
	}
}
