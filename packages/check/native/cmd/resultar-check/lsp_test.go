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

func TestRangeIntersectsDoesNotTreatOriginAsWildcard(t *testing.T) {
	origin := lspRange{Start: lspPosition{Line: 0, Character: 0}, End: lspPosition{Line: 0, Character: 0}}
	lineOneStart := lspRange{Start: lspPosition{Line: 0, Character: 0}, End: lspPosition{Line: 0, Character: 5}}
	lineOneLater := lspRange{Start: lspPosition{Line: 0, Character: 10}, End: lspPosition{Line: 0, Character: 15}}
	lineFive := lspRange{Start: lspPosition{Line: 4, Character: 2}, End: lspPosition{Line: 4, Character: 8}}

	if !rangeIntersects(lineOneStart, origin) {
		t.Fatal("expected origin cursor to intersect range starting at 0:0")
	}
	if rangeIntersects(lineOneLater, origin) {
		t.Fatal("origin cursor at 0:0 must not match range starting at 0:10")
	}
	if rangeIntersects(lineFive, origin) {
		t.Fatal("origin cursor at 0:0 must not match range on line 5")
	}
}

func TestSameFilePathForOSInLSP(t *testing.T) {
	if !sameFilePathForOS(`C:\Work\App.ts`, `c:\work\app.ts`, "windows") {
		t.Fatal("expected case-insensitive path match on windows")
	}
	if sameFilePathForOS(`/Work/App.ts`, `/work/app.ts`, "linux") {
		t.Fatal("expected case-sensitive path match on linux")
	}
}

func TestLSPDebounceTimerNotResetByHoverAndClearedOnSave(t *testing.T) {
	_, config, path := writeMigrateProject(t, `export const value = 1`, v4RequestTypes)
	uri := fileURI(path)
	var out strings.Builder
	server := lspServer{
		project:   config,
		writer:    &out,
		documents: map[string]lspDocument{uri: {Text: `export const value = 1`, Version: 1}},
	}

	changeParams := []byte(`{"textDocument":{"uri":"` + uri + `","version":2},"contentChanges":[{"text":"export const value = 2"}]}`)
	if err := server.handle(lspMessage{Method: "textDocument/didChange", Params: changeParams}); err != nil {
		t.Fatal(err)
	}
	if !server.pendingPublish || !server.resetPublishTimer {
		t.Fatalf("expected didChange to schedule debounced publish: pending=%v reset=%v", server.pendingPublish, server.resetPublishTimer)
	}

	// Simulate serve() consuming resetPublishTimer once.
	server.resetPublishTimer = false

	// Unrelated hover / diagnostic / codeAction requests must NOT reset the debounce timer.
	hoverParams := []byte(`{"textDocument":{"uri":"` + uri + `"},"position":{"line":0,"character":13}}`)
	if err := server.handle(lspMessage{ID: []byte("1"), Method: "textDocument/hover", Params: hoverParams}); err != nil {
		t.Fatal(err)
	}
	if server.resetPublishTimer {
		t.Fatal("hover request must not reset pendingPublish debounce timer")
	}
	if !server.pendingPublish {
		t.Fatal("hover request must keep pendingPublish intact until timer fires")
	}

	// didSave publishes immediately and clears pendingPublish so no duplicate publish occurs later.
	saveParams := []byte(`{"textDocument":{"uri":"` + uri + `"}}`)
	if err := server.handle(lspMessage{Method: "textDocument/didSave", Params: saveParams}); err != nil {
		t.Fatal(err)
	}
	if server.pendingPublish || server.resetPublishTimer {
		t.Fatalf("didSave must clear pendingPublish after immediate publish: pending=%v reset=%v", server.pendingPublish, server.resetPublishTimer)
	}
}
