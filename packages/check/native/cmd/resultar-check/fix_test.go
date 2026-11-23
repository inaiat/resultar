package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/analyzer"
	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/output"
)

func writeFixTestProject(t *testing.T, sources map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	resultarTypes := `export interface Result<T, E> {
  readonly value: T
  readonly error: E
  map<U>(fn: (value: T) => U): Result<U, E>
  asVoid(): Result<void, E>
}
export declare function ok<T>(value: T): Result<T, never>
export declare function pipe<A>(value: A): A
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
      "failOn": "suggestion"
    }]
  },
  "include": ["src/**/*.ts"]
}`,
	}
	for name, content := range sources {
		files[name] = content
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
	return dir
}

func runCapturing(t *testing.T, args []string) (int, string, string) {
	t.Helper()
	stdoutFile, err := os.CreateTemp(t.TempDir(), "stdout")
	if err != nil {
		t.Fatal(err)
	}
	defer stdoutFile.Close()
	stderrFile, err := os.CreateTemp(t.TempDir(), "stderr")
	if err != nil {
		t.Fatal(err)
	}
	defer stderrFile.Close()

	origStdout, origStderr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = stdoutFile, stderrFile
	code := run(args)
	os.Stdout, os.Stderr = origStdout, origStderr

	outBytes, err := os.ReadFile(stdoutFile.Name())
	if err != nil {
		t.Fatal(err)
	}
	errBytes, err := os.ReadFile(stderrFile.Name())
	if err != nil {
		t.Fatal(err)
	}
	return code, string(outBytes), string(errBytes)
}

func TestFixAppliesSafeCorrectionsOnly(t *testing.T) {
	dir := writeFixTestProject(t, map[string]string{
		"src/clean.ts": `import { ok, pipe } from "resultar"
export const single = () => pipe(ok(1))
export const ignored = () => ok(2).map(() => undefined)
`,
	})
	configPath := filepath.Join(dir, "tsconfig.json")
	cleanPath := filepath.Join(dir, "src", "clean.ts")

	// Dry run previews fixes without modifying the file.
	code, _, stderr := runCapturing(t, []string{"--project", configPath, "--fix-dry-run"})
	if code != 1 {
		t.Fatalf("expected dry-run to keep exit code 1 for remaining findings, got %d (stderr: %s)", code, stderr)
	}
	if !strings.Contains(stderr, "would apply 2 safe fixes across 1 file (dry run)") {
		t.Fatalf("expected dry-run summary, got:\n%s", stderr)
	}
	afterDryRun, err := os.ReadFile(cleanPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(afterDryRun), "pipe(ok(1))") {
		t.Fatalf("dry run modified file unexpectedly:\n%s", string(afterDryRun))
	}

	// Real --fix applies safe correction fixes and re-analyzes cleanly to exit 0.
	code, _, stderr = runCapturing(t, []string{"--project", configPath, "--fix"})
	if code != 0 {
		t.Fatalf("expected exit 0 after applying all safe fixes, got %d (stderr: %s)", code, stderr)
	}
	if !strings.Contains(stderr, "applied 2 safe fixes across 1 file") {
		t.Fatalf("expected applied fix summary, got:\n%s", stderr)
	}
	fixed, err := os.ReadFile(cleanPath)
	if err != nil {
		t.Fatal(err)
	}
	fixedText := string(fixed)
	if strings.Contains(fixedText, "pipe(ok(1))") || !strings.Contains(fixedText, "export const single = () => ok(1)") {
		t.Fatalf("expected single-arg pipe unwrapped, got:\n%s", fixedText)
	}
	if !strings.Contains(fixedText, "ok(2).asVoid()") {
		t.Fatalf("expected map(() => undefined) rewritten to asVoid(), got:\n%s", fixedText)
	}
}

func TestFixNeverAppliesIntentionalDiscard(t *testing.T) {
	dir := writeFixTestProject(t, map[string]string{
		"src/mixed.ts": `import { ok, pipe } from "resultar"
export function runMixed() {
  ok(1)
  return pipe(ok(2))
}
`,
	})
	configPath := filepath.Join(dir, "tsconfig.json")
	mixedPath := filepath.Join(dir, "src", "mixed.ts")

	code, stdout, stderr := runCapturing(t, []string{"--project", configPath, "--fix", "--json"})
	if code != 1 {
		t.Fatalf("expected exit 1 because no-discard remains unfixed, got %d (stderr: %s)", code, stderr)
	}
	if !strings.Contains(stderr, "applied 1 safe fix across 1 file") {
		t.Fatalf("expected 1 safe fix applied, got:\n%s", stderr)
	}

	fixed, err := os.ReadFile(mixedPath)
	if err != nil {
		t.Fatal(err)
	}
	fixedText := string(fixed)
	if strings.Contains(fixedText, "void ok(1)") {
		t.Fatalf("--fix must never apply intentional-discard `void ` fix:\n%s", fixedText)
	}
	if !strings.Contains(fixedText, "return ok(2)") {
		t.Fatalf("expected safe correction fix to still apply:\n%s", fixedText)
	}

	// Verify --json stdout remains valid JSON lines with only the remaining no-discard diagnostic.
	lines := strings.Split(strings.TrimSpace(stdout), "\n")
	if len(lines) != 1 {
		t.Fatalf("expected 1 remaining JSON diagnostic, got %d:\n%s", len(lines), stdout)
	}
	var diag output.Diagnostic
	if err := json.Unmarshal([]byte(lines[0]), &diag); err != nil {
		t.Fatalf("invalid JSON diagnostic: %v\n%s", err, stdout)
	}
	if diag.Rule != "no-discard" {
		t.Fatalf("expected remaining no-discard diagnostic, got %#v", diag)
	}
}

func TestFixRespectsFileFilterAndRejectsInvalidCombinations(t *testing.T) {
	dir := writeFixTestProject(t, map[string]string{
		"src/a.ts": `import { ok, pipe } from "resultar"
export const a = pipe(ok(1))
`,
		"src/b.ts": `import { ok, pipe } from "resultar"
export const b = pipe(ok(2))
`,
	})
	configPath := filepath.Join(dir, "tsconfig.json")

	code, _, stderr := runCapturing(t, []string{"quickfixes", "--project", configPath, "--fix"})
	if code != 1 || !strings.Contains(stderr, "--fix and --fix-dry-run cannot be used with quickfixes") {
		t.Fatalf("expected error for quickfixes + --fix, got code=%d stderr=%s", code, stderr)
	}

	code, _, _ = runCapturing(t, []string{"--project", configPath, "--fix", "--file", "src/a.ts"})
	if code != 1 {
		t.Fatalf("expected exit 1 because src/b.ts still has a finding, got %d", code)
	}
	aText, _ := os.ReadFile(filepath.Join(dir, "src", "a.ts"))
	bText, _ := os.ReadFile(filepath.Join(dir, "src", "b.ts"))
	if strings.Contains(string(aText), "pipe(") {
		t.Fatalf("expected src/a.ts fixed, got:\n%s", string(aText))
	}
	if !strings.Contains(string(bText), "pipe(") {
		t.Fatalf("expected src/b.ts untouched due to --file filter, got:\n%s", string(bText))
	}
}

func TestEditConflictDetectionAndApplication(t *testing.T) {
	if !editsConflict(
		analyzer.TextEdit{Start: 5, Length: 4, NewText: "a"},
		analyzer.TextEdit{Start: 7, Length: 3, NewText: "b"},
	) {
		t.Fatal("expected overlapping ranges to conflict")
	}
	if !editsConflict(
		analyzer.TextEdit{Start: 5, Length: 0, NewText: "a"},
		analyzer.TextEdit{Start: 5, Length: 0, NewText: "b"},
	) {
		t.Fatal("expected identical zero-length insertions to conflict")
	}
	if editsConflict(
		analyzer.TextEdit{Start: 2, Length: 3, NewText: "a"},
		analyzer.TextEdit{Start: 5, Length: 3, NewText: "b"},
	) {
		t.Fatal("expected adjacent non-overlapping ranges not to conflict")
	}

	updated := applyEditsToText("alpha beta gamma", []analyzer.TextEdit{
		{Start: 0, Length: 5, NewText: "ALPHA"},
		{Start: 11, Length: 5, NewText: "GAMMA"},
	})
	if updated != "ALPHA beta GAMMA" {
		t.Fatalf("unexpected edit application result: %q", updated)
	}
}

func TestFileFilterPrefersProjectFileOnCollision(t *testing.T) {
	root := t.TempDir()
	t.Chdir(root)
	project := filepath.Join(root, "app")
	if err := os.Mkdir(project, 0755); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{root, project} {
		if err := os.WriteFile(filepath.Join(dir, "index.ts"), nil, 0644); err != nil {
			t.Fatal(err)
		}
	}
	if !matchesFile(filepath.Join(project, "index.ts"), "index.ts", project) || matchesFile(filepath.Join(root, "index.ts"), "index.ts", project) {
		t.Fatal("a project-relative filter must select only the project file")
	}
}
