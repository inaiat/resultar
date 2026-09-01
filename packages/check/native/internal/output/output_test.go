package output

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
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
