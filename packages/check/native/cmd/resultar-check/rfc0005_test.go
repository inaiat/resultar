package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/output"
)

func TestNoPromiseResultarCLIAndEditorIntegration(t *testing.T) {
	dir := t.TempDir()
	resultarTypes := `export interface Result<T, E> { readonly value: T; readonly error: E }
export type StrictResult<T, E extends Error> = Result<T, E>
export interface ResultAsync<T, E> extends PromiseLike<Result<T, E>> {}
export type StrictResultAsync<T, E extends Error> = ResultAsync<T, E>
export interface ResultTask<A, E = never, R = never> {
  readonly value: A
  readonly error: E
  readonly requirements: R
}
export declare const ResultTask: { ok<A>(value: A): ResultTask<A, never, never> }
export declare function ok<T>(value: T): Result<T, never>
export declare function okAsync<T>(value: T): ResultAsync<T, never>
`
	source := `import {ok, ResultTask, type Result} from "resultar"
export const loadTask = async () => ResultTask.ok(42)
export const loadResult = async () => ok("hello")
export async function wrapGeneric<T extends Result<number, Error>>(value: T): Promise<T> {
  return value
}
export type Heterogeneous = Promise<Result<number, Error> | ResultTask<string>>
// resultar-check-disable-next-line no-promise-resultar
export const suppressedTask = async () => ResultTask.ok(0)
`
	files := map[string]string{
		"package.json":                       `{"type":"module"}`,
		"node_modules/resultar/package.json": `{"name":"resultar","type":"module","types":"index.d.ts"}`,
		"node_modules/resultar/index.d.ts":   resultarTypes,
		"tsconfig.json": `{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "skipLibCheck": true,
    "plugins": [{
      "name": "resultar-check",
      "preferResultAsync": "off",
      "failOn": "error"
    }]
  },
  "include": ["src/**/*.ts"]
}`,
		"src/service.ts": source,
	}
	for name, contents := range files {
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	configPath := filepath.Join(dir, "tsconfig.json")
	servicePath := filepath.Join(dir, "src", "service.ts")

	// 1. CLI execution verifies exit code, JSON lines, rule, severity, locations, messages, and suppression.
	stdoutFile, err := os.CreateTemp(t.TempDir(), "cli-stdout")
	if err != nil {
		t.Fatal(err)
	}
	defer stdoutFile.Close()
	originalStdout := os.Stdout
	os.Stdout = stdoutFile
	exitCode := run([]string{"--project", configPath, "--json"})
	os.Stdout = originalStdout

	if exitCode != 1 {
		t.Fatalf("expected CLI exit code 1 for error-severity no-promise-resultar, got %d", exitCode)
	}
	raw, err := os.ReadFile(stdoutFile.Name())
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 4 {
		t.Fatalf("expected 4 JSON diagnostics (suppressedTask suppressed), got %d:\n%s", len(lines), string(raw))
	}

	var first, second, third, fourth output.Diagnostic
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(lines[1]), &second); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(lines[2]), &third); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(lines[3]), &fourth); err != nil {
		t.Fatal(err)
	}
	if first.Rule != "no-promise-resultar" || first.Severity != "error" || first.Line != 2 || first.Column != 14 || first.Length != len("loadTask") || !strings.Contains(first.Message, "ResultTask<number>") {
		t.Fatalf("unexpected first CLI diagnostic: %#v", first)
	}
	if second.Rule != "no-promise-resultar" || second.Severity != "error" || second.Line != 3 || second.Column != 14 || second.Length != len("loadResult") || !strings.Contains(second.Message, "ResultAsync<string, never>") {
		t.Fatalf("unexpected second CLI diagnostic: %#v", second)
	}
	if third.Rule != "no-promise-resultar" || third.Severity != "error" || third.Line != 4 || third.Length != len("Promise<T>") || !strings.Contains(third.Message, "ResultAsync<number, Error>") {
		t.Fatalf("unexpected third CLI diagnostic for constrained generic: %#v", third)
	}
	if fourth.Rule != "no-promise-resultar" || fourth.Severity != "error" || fourth.Line != 7 || !strings.Contains(fourth.Message, "ResultTask<number | string, Error>") || !strings.Contains(fourth.Message, "ResultAsync<number | string, Error>") {
		t.Fatalf("unexpected fourth CLI diagnostic for heterogeneous union: %#v", fourth)
	}

	// 2. Editor LSP integration verifies live diagnostics and live suppression / fix via unsaved overlay.
	uri := fileURI(servicePath)
	server := lspServer{project: configPath, writer: &bytes.Buffer{}, documents: map[string]lspDocument{}}
	diags, err := server.diagnostics()
	if err != nil || len(diags) != 4 {
		t.Fatalf("expected 4 LSP diagnostics on disk, got %#v (err=%v)", diags, err)
	}
	lspFirst := toLSPDiagnostic(diags[0])
	if lspFirst.Severity != 1 || lspFirst.Code != "no-promise-resultar" || lspFirst.Source != "resultar-check" || lspFirst.Range.Start.Line != 1 || lspFirst.Range.Start.Character != 13 || lspFirst.Range.End.Character != 13+len("loadTask") {
		t.Fatalf("unexpected LSP diagnostic range/code: %#v", lspFirst)
	}

	fixedOverlay := `import {okAsync, ResultTask} from "resultar"
export const loadTask = () => ResultTask.ok(42)
export const loadResult = () => okAsync("hello")
`
	openParams, _ := json.Marshal(map[string]any{
		"textDocument": map[string]any{"uri": uri, "version": 1, "text": fixedOverlay},
	})
	if err := server.handle(lspMessage{Method: "textDocument/didOpen", Params: openParams}); err != nil {
		t.Fatal(err)
	}
	afterFix, err := server.diagnostics()
	if err != nil || len(afterFix) != 0 {
		t.Fatalf("expected 0 LSP diagnostics after returning ResultTask/ResultAsync directly, got %#v (err=%v)", afterFix, err)
	}
}
