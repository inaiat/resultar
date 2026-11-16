package analyzer

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/config"
	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/project"
)

func TestFromPromiseAcceptanceMatrix(t *testing.T) {
	library, err := filepath.Abs("../../../../resultar/dist/index.js")
	if err != nil {
		t.Fatal(err)
	}
	library = filepath.ToSlash(library)
	cases := []struct {
		name, source string
		want         map[string]int
	}{
		{"direct await", `export const task: TaskType<number, never> = TASK.fromPromise(async signal => { await Promise.resolve(1); return signal.aborted ? 0 : 1 }); void task`, nil},
		{"nested await", `export const task = TASK.fromPromise(async () => {
    const nested = async () => { await Promise.resolve(1) }; void nested; return 1
  }); void task`, map[string]int{"no-unsafe-await": 1}},
		{"unrelated factory", `const foreign = {fromPromise: (factory: () => Promise<number>) => factory()}
   export const external = foreign.fromPromise(async () => { await Promise.resolve(1); return 1 })`, map[string]int{"no-unsafe-await": 1}},
		{"typed boundary control", `const expected: TaskType<number, unknown> = TASK.tryPromise(() => Promise.resolve(1)); void expected`, map[string]int{"typed-catch-mapper": 1, "no-unknown-result-error": 1}},
		{"cause and typed recovery", `const task = TASK.fromPromise(() => Promise.resolve(1))
   export const instance = task.catchCause(() => TASK.ok(2))
   export const staticCall = TASK.catchCause(task, () => TASK.ok(2))
   export const curried = pipe(task, TASK.catchCause(() => TASK.ok(2)))
   export const instancePipe = task.pipe(TASK.catchCause(() => TASK.ok(2)))
   export const typedInstance = task.orElse(() => TASK.ok(2))
   export const typedStatic = TASK.orElse(task, () => TASK.ok(2))
   export const typedPipe = pipe(task, TASK.orElse(() => TASK.ok(2))); void instance; void staticCall; void curried; void instancePipe; void typedInstance; void typedStatic; void typedPipe`, map[string]int{"no-useless-recovery": 3}},
		{"discarded task", `TASK.fromPromise(() => Promise.resolve(1))`, map[string]int{"no-discard": 1}},
		{"returned and yielded", `export const returned = () => TASK.fromPromise(() => Promise.resolve(1))
   export const yielded = TASK.gen(function* () { return yield* TASK.fromPromise(() => Promise.resolve(1)) })
   export const consumed = TASK.fromPromise(() => Promise.resolve(1)).runExit(); void yielded`, nil},
		{"Promise success", `export const mapped = TASK.fromPromise(() => Promise.resolve(1)).map(value => Promise.resolve(value))
   export const sync = ok(Promise.resolve(1)); void mapped; void sync`, map[string]int{"no-promise-in-result-success": 2}},
		{"outer async contract", `export const outer = async () => TASK.fromPromise(async () => { await Promise.resolve(1); return 1 })`, map[string]int{"no-promise-resultar": 1}},
		{"scope propagation", `export const delegated = TASK.gen(function* () {
    return yield* TASK.acquireRelease({acquire: TASK.fromPromise(() => Promise.resolve(1)), release: () => TASK.fromPromise(() => Promise.resolve())})
   })
   export const scoped = TASK.scoped(TASK.gen(function* () {
    return yield* TASK.acquireRelease({acquire: TASK.fromPromise(() => Promise.resolve(1)), release: () => TASK.fromPromise(() => Promise.resolve())})
   })); void delegated; void scoped`, nil},
		{"disposable factories", `const acquire = TASK.fromPromise(() => Promise.resolve({[Symbol.asyncDispose]: () => Promise.resolve()}))
   declare function audit(): void
   const foreign = {fromPromise: (factory: () => Promise<void>) => TASK.fromPromise(factory)}
   export const direct = TASK.scoped(TASK.acquireRelease({acquire, release: resource => TASK.fromPromise(() => resource[Symbol.asyncDispose]())}))
   export const block = TASK.scoped(TASK.acquireRelease({acquire, release: resource => TASK.fromPromise(async () => { await resource[Symbol.asyncDispose]() })}))
   export const extra = TASK.scoped(TASK.acquireRelease({acquire, release: resource => TASK.fromPromise(() => {audit(); return resource[Symbol.asyncDispose]()})}))
   export const unrelated = TASK.scoped(TASK.acquireRelease({acquire, release: resource => foreign.fromPromise(() => resource[Symbol.asyncDispose]())})); void acquire; void direct; void block; void extra; void unrelated`, map[string]int{"prefer-acquire-disposable": 2}},
	}
	for _, imported := range []struct{ name, statement, task string }{
		{"direct", `import {ResultTask} from "` + library + `"`, "ResultTask"},
		{"alias", `import {ResultTask as Task} from "` + library + `"`, "Task"},
		{"namespace", `import * as api from "` + library + `"`, "api.ResultTask"},
		{"reexport", `import {Task} from "./barrel.js"`, "Task"},
	} {
		for _, test := range cases {
			t.Run(imported.name+"/"+test.name, func(t *testing.T) {
				source := "/// <reference lib=\"esnext.disposable\" />\n" + imported.statement + "\n" + `import {pipe, ok, type ResultTask as TaskType} from "` + library + `"` + "\n" + strings.ReplaceAll(test.source, "TASK", imported.task)
				directory := writeFixture(t, source)
				if err := os.WriteFile(filepath.Join(directory, "barrel.ts"), []byte(`export {ResultTask as Task} from "`+library+`"`), 0o600); err != nil {
					t.Fatal(err)
				}
				opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
				if err != nil || len(diagnostics) != 0 {
					t.Fatalf("open: %v %v", err, diagnostics)
				}
				options := config.Defaults()
				options.NoUnsafeAwait = config.SeverityWarning
				options.NoUnsafeAwaitMode = "all"
				options.TypedCatchMapper = config.SeverityWarning
				findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
				if err != nil {
					t.Fatal(err)
				}
				counts := map[string]int{}
				for _, finding := range findings {
					switch finding.Rule {
					case "no-unsafe-await", "typed-catch-mapper", "no-unknown-result-error", "no-useless-recovery", "no-discard", "no-promise-in-result-success", "no-promise-resultar", "prefer-acquire-disposable", "no-unscoped-acquire-release":
						counts[finding.Rule]++
						if finding.Rule == "no-useless-recovery" && strings.Contains(finding.Message, "catchCause") {
							t.Fatalf("cause recovery must remain reachable: %#v", finding)
						}
						if finding.Rule == "prefer-acquire-disposable" {
							line := strings.Split(source, "\n")[finding.Line-1]
							if !strings.Contains(line, "const direct =") && !strings.Contains(line, "const block =") {
								t.Fatalf("extra work and unrelated factories must not be rewritten: %#v", finding)
							}
						}
						if finding.Rule == "prefer-acquire-disposable" && len(finding.Fixes) != 0 {
							t.Fatalf("must not rewrite defect policy: %#v", finding)
						}
					}
				}
				want := test.want
				if want == nil {
					want = map[string]int{}
				}
				if !reflect.DeepEqual(counts, want) {
					t.Fatalf("got %v, want %v: %#v", counts, want, findings)
				}
			})
		}
	}
}
