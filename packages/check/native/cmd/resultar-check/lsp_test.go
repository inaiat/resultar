package main

import (
	"bufio"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/analyzer"
	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/output"
)

func TestReadLSPMessage(t *testing.T) {
	payload := `{"jsonrpc":"2.0","id":7,"method":"initialize","params":{}}`
	message, err := readLSPMessage(bufio.NewReader(strings.NewReader("Content-Length: " + strconv.Itoa(len(payload)) + "\r\n\r\n" + payload)))
	if err != nil {
		t.Fatal(err)
	}
	if message.Method != "initialize" || string(message.ID) != "7" {
		t.Fatalf("unexpected message: %#v", message)
	}
}

func TestCodeActionsPreserveDiscardIntent(t *testing.T) {
	server := lspServer{}
	server.setDiagnosticCache([]output.Diagnostic{{
		File: "/tmp/fixture.ts", Line: 1, Column: 1, Length: 6,
		Rule: "no-discard", Fixes: []analyzer.Fix{{
			Title: "Intentionally discard", Kind: analyzer.FixIntentionalDiscard,
			Description: "Does not execute a lazy task", Edits: []analyzer.TextEdit{{NewText: "void "}},
		}},
	}}, time.Time{})
	actions, err := server.codeActions("file:///tmp/fixture.ts", lspRange{})
	if err != nil {
		t.Fatal(err)
	}
	if len(actions) != 1 || actions[0].Data.Kind != analyzer.FixIntentionalDiscard || actions[0].Data.Description == "" {
		t.Fatalf("fix intent lost in LSP action: %#v", actions)
	}
}

func TestToLSPDiagnostic(t *testing.T) {
	diagnostic := toLSPDiagnostic(output.Diagnostic{Rule: "no-throw", Severity: "warning", Line: 3, Column: 5, Length: 4, Message: "avoid throw"})
	if diagnostic.Severity != 2 || diagnostic.Range.Start.Line != 2 || diagnostic.Range.Start.Character != 4 || diagnostic.Range.End.Character != 8 {
		t.Fatalf("unexpected LSP diagnostic: %#v", diagnostic)
	}
}

func TestSemanticErrorKeepsResultTaskQuickFix(t *testing.T) {
	_, config, _ := writeMigrateProject(t, `import { ResultTask, type Result } from "resultar";
export async function read(): Promise<Result<number>> { return await ResultTask.ok(1) }
`, v4RequestTypes)
	server := lspServer{project: config}
	diagnostics, err := server.diagnostics()
	if err != nil {
		t.Fatal(err)
	}
	var semantic, quickFix bool
	for _, d := range diagnostics {
		semantic = semantic || d.Code != 0
		for _, fix := range d.Fixes {
			for _, edit := range fix.Edits {
				quickFix = quickFix || d.Rule == "no-await-result-task" && edit.NewText == ".runResult()"
			}
		}
	}
	if !semantic || !quickFix {
		t.Fatalf("want compiler error and ResultTask quickfix, got %+v", diagnostics)
	}
}
