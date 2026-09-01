package main

import (
	"bufio"
	"strconv"
	"strings"
	"testing"

	"github.com/microsoft/typescript-go/resultar-check/internal/output"
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

func TestToLSPDiagnostic(t *testing.T) {
	diagnostic := toLSPDiagnostic(output.Diagnostic{Rule: "no-throw", Severity: "warning", Line: 3, Column: 5, Length: 4, Message: "avoid throw"})
	if diagnostic.Severity != 2 || diagnostic.Range.Start.Line != 2 || diagnostic.Range.Start.Character != 4 || diagnostic.Range.End.Character != 8 {
		t.Fatalf("unexpected LSP diagnostic: %#v", diagnostic)
	}
}
