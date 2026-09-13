package analyzer

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/microsoft/typescript-go/resultar-check/internal/config"
	"github.com/microsoft/typescript-go/resultar-check/internal/project"
)

const importedAPIFixture = `
export interface Result<T, E> { readonly value?: T; readonly error?: E }
export declare function ok<T>(value: T): Result<T, never>
export declare function safeTry(body: unknown): unknown
export declare const Result: { gen: typeof safeTry }
export declare class ResultTask<T, E = never, R = never> {
  static sync<T>(body: () => T): ResultTask<T>
  static gen(body: unknown): ResultTask<unknown>
  static scoped<T>(task: ResultTask<T>): ResultTask<T>
  static acquireRelease(options: object): ResultTask<number>
  static runExit<T>(task: ResultTask<T>): Promise<unknown>
  [Symbol.iterator](): Generator<unknown, T, unknown>
}
export declare const Other: { gen: typeof safeTry; sync: typeof ResultTask.sync }
`

func TestGeneratorRulesFollowImportedSymbols(t *testing.T) {
	cases := []struct{ name, imports, call string }{
		{"safeTry", `import {safeTry as compose} from './api'`, "compose"},
		{"safeTry namespace", `import * as api from './api'`, "api.safeTry"},
		{"safeTry reexport", `import {compose} from './barrel'`, "compose"},
		{"Result.gen", `import {Result} from './api'`, "Result.gen"},
		{"Result alias", `import {Result as R} from './api'`, "R.gen"},
		{"Result namespace", `import * as api from './api'`, "api.Result.gen"},
		{"Result reexport", `import {R} from './barrel'`, "R.gen"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			source := test.imports + `
import {ok} from './api'
` + test.call + `(async function* () {
  await Promise.resolve(1)
  yield ok(1)
  try {} catch {}
  return ok(1)
})`
			findings := importedFindings(t, source)
			rules := make([]string, 0, len(findings))
			for _, finding := range findings {
				rules = append(rules, finding.Rule)
			}
			slices.Sort(rules)
			expected := []string{"no-await-in-safe-try", "no-try-catch-in-safe-try", "yield-star-in-safe-try"}
			if !slices.Equal(rules, expected) {
				t.Fatalf("got %v, want %v", rules, expected)
			}
		})
	}
}

func TestTaskRulesFollowImportedSymbols(t *testing.T) {
	cases := []struct{ name, imports, task string }{
		{"direct", `import {ResultTask} from './api'`, "ResultTask"},
		{"alias", `import {ResultTask as Task} from './api'`, "Task"},
		{"namespace", `import * as api from './api'`, "api.ResultTask"},
		{"reexport", `import {Task} from './barrel'`, "Task"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			source := test.imports + `
import {ok} from './api'
void ` + test.task + `.sync(() => { throw 'defect' })
void ` + test.task + `.gen(function* () { yield ok(1); return ok(1) })
void ` + test.task + `.scoped(` + test.task + `.gen(function* () {
  return yield* ` + test.task + `.acquireRelease({})
}))`
			findings := importedFindings(t, source)
			rules := make([]string, 0, len(findings))
			for _, finding := range findings {
				rules = append(rules, finding.Rule)
			}
			slices.Sort(rules)
			expected := []string{"no-result-in-task-gen", "no-throw-in-task-sync", "yield-star-in-result-task-gen"}
			if !slices.Equal(rules, expected) {
				t.Fatalf("got %v, want %v", rules, expected)
			}
		})
	}
}

func TestLocalSpellingDoesNotOverrideImportedSymbol(t *testing.T) {
	findings := importedFindings(t, `
import {Other as Result, Other as ResultTask, Other as safeTry, ok} from './api'
void Result.gen(async function* () { await Promise.resolve(1); yield ok(1); return ok(1) })
void ResultTask.sync(() => { throw 'defect' })
void safeTry.gen(function* () { yield ok(1); return ok(1) })
`)
	if len(findings) != 0 {
		t.Fatalf("unrelated imports should not trigger Resultar generator rules: %#v", findings)
	}
}

func importedFindings(t *testing.T, source string) []Finding {
	t.Helper()
	directory := writeFixture(t, source)
	for name, contents := range map[string]string{
		"api.d.ts":  importedAPIFixture,
		"barrel.ts": `export {safeTry as compose, Result as R, ResultTask as Task} from './api'`,
	} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(contents), 0o600); err != nil {
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
	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.NoUnknownResultError = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	return findings
}
