package output

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/analyzer"
)

func TestWriteJSONLines(t *testing.T) {
	var buffer bytes.Buffer
	err := Write(&buffer, []Diagnostic{{Rule: "no-throw", Message: "avoid throw", Severity: "warning"}}, FormatJSON, ".")
	if err != nil {
		t.Fatal(err)
	}
	var diagnostic Diagnostic
	if err := json.Unmarshal(buffer.Bytes(), &diagnostic); err != nil {
		t.Fatal(err)
	}
	if diagnostic.Rule != "no-throw" || diagnostic.Message != "avoid throw" {
		t.Fatalf("unexpected diagnostic: %#v", diagnostic)
	}
}

func TestJSONPreservesFixIntent(t *testing.T) {
	var buffer bytes.Buffer
	finding := analyzer.Finding{Rule: "no-discard", Fixes: []analyzer.Fix{{
		Title: "Intentionally discard", Kind: analyzer.FixIntentionalDiscard,
		Description: "Does not execute a lazy task", Edits: []analyzer.TextEdit{{NewText: "void "}},
	}}}
	if err := Write(&buffer, []Diagnostic{FromFinding(finding)}, FormatJSON, "."); err != nil {
		t.Fatal(err)
	}
	var diagnostic Diagnostic
	if err := json.Unmarshal(buffer.Bytes(), &diagnostic); err != nil {
		t.Fatal(err)
	}
	if len(diagnostic.Fixes) != 1 || diagnostic.Fixes[0].Kind != analyzer.FixIntentionalDiscard || diagnostic.Fixes[0].Description == "" {
		t.Fatalf("fix intent lost in JSONL: %#v", diagnostic)
	}
}

func TestWriteSARIF(t *testing.T) {
	var buffer bytes.Buffer
	err := Write(&buffer, []Diagnostic{{Rule: "no-throw", File: "/tmp/src.ts", Line: 4, Column: 2, Length: 5, Message: "avoid throw", Severity: "error"}}, FormatSARIF, "/tmp")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buffer.String(), `"version":"2.1.0"`) || !strings.Contains(buffer.String(), `"ruleId":"no-throw"`) {
		t.Fatalf("unexpected SARIF: %s", buffer.String())
	}
}

func TestWriteJUnit(t *testing.T) {
	var buffer bytes.Buffer
	err := Write(&buffer, []Diagnostic{{Rule: "no-throw", Message: "avoid <throw>", Severity: "error"}}, FormatJUnit, ".")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buffer.String(), `<testsuite`) || !strings.Contains(buffer.String(), `avoid &lt;throw&gt;`) {
		t.Fatalf("unexpected JUnit: %s", buffer.String())
	}
}

func TestSARIFCharLengthUsesUTF16(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "source.ts")
	if err := os.WriteFile(path, []byte("x😀é"), 0644); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := Write(&buf, []Diagnostic{{File: path, Line: 1, Column: 2, Start: 1, Length: len("😀é")}}, FormatSARIF, dir); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), `"charLength":3`) {
		t.Fatal(buf.String())
	}
}
