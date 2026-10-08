package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"github.com/microsoft/typescript-go/resultar-check/internal/analyzer"
	"github.com/microsoft/typescript-go/resultar-check/internal/config"
	"github.com/microsoft/typescript-go/resultar-check/internal/project"
)

func toolingProject(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	files["tsconfig.json"] = `{"compilerOptions":{"strict":true,"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","types":[],"skipLibCheck":true},"include":["**/*.ts"]}`
	for name, text := range files {
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}
func fileURI(path string) string {
	return (&url.URL{Scheme: "file", Path: filepath.ToSlash(path)}).String()
}

func TestUnsavedDependencySnapshots(t *testing.T) {
	dir := toolingProject(t, map[string]string{"model.ts": "export const value = 1", "main.ts": "import {value} from './model.js'; export const count:number=value"})
	path := filepath.Join(dir, "model.ts")
	uri := fileURI(path)
	writer := &bytes.Buffer{}
	server := lspServer{project: filepath.Join(dir, "tsconfig.json"), writer: writer, documents: map[string]lspDocument{}}
	before, err := server.diagnostics()
	if err != nil || len(before) != 0 {
		t.Fatalf("baseline: %v %v", before, err)
	}
	params, _ := json.Marshal(map[string]any{"textDocument": map[string]any{"uri": uri, "version": 1, "text": "export const value='changed'"}})
	if err := server.handle(lspMessage{Method: "textDocument/didOpen", Params: params}); err != nil {
		t.Fatal(err)
	}
	after, err := server.diagnostics()
	if err != nil || len(after) != 1 || filepath.Base(after[0].File) != "main.ts" {
		t.Fatalf("dependent was analyzed from disk: %v %v", after, err)
	}
	disk, _ := os.ReadFile(path)
	if string(disk) != "export const value = 1" {
		t.Fatal("overlay changed disk")
	}
	change, _ := json.Marshal(map[string]any{"textDocument": map[string]any{"uri": uri, "version": 2}, "contentChanges": []map[string]any{{"text": "export const value=2"}}})
	if err := server.handle(lspMessage{Method: "textDocument/didChange", Params: change}); err != nil {
		t.Fatal(err)
	}
	after, err = server.diagnostics()
	if err != nil || len(after) != 0 {
		t.Fatalf("stale analysis: %v %v", after, err)
	}
	stale, _ := json.Marshal(map[string]any{"textDocument": map[string]any{"uri": uri, "version": 1}, "contentChanges": []map[string]any{{"text": "export const value='stale'"}}})
	if err := server.handle(lspMessage{Method: "textDocument/didChange", Params: stale}); err != nil {
		t.Fatal(err)
	}
	if server.documents[uri].Version != 2 {
		t.Fatal("accepted outdated document version")
	}
	closeParams, _ := json.Marshal(map[string]any{"textDocument": map[string]any{"uri": uri}})
	if err := server.handle(lspMessage{Method: "textDocument/didClose", Params: closeParams}); err != nil {
		t.Fatal(err)
	}
	after, err = server.diagnostics()
	if err != nil || len(after) != 0 {
		t.Fatalf("close failed to restore disk: %v %v", after, err)
	}
}

func TestNewUnsavedFilesRespectProjectInclusion(t *testing.T) {
	dir := toolingProject(t, map[string]string{"main.ts": "export const value=1"})
	path := filepath.Join(dir, "nested", "NewFile.ts")
	opened, diagnostics, err := project.OpenWithOverlay(filepath.Join(dir, "tsconfig.json"), map[string]string{path: "export const value:number='wrong'"})
	if err != nil || len(diagnostics) > 0 {
		t.Fatalf("open: %v %v", err, diagnostics)
	}
	findings := collectTypeScriptDiagnostics(context.Background(), opened.Program, opened.Program.SourceFiles())
	if len(findings) != 1 || filepath.Clean(findings[0].File) != filepath.Clean(path) {
		t.Fatalf("new overlay file missing: %#v", findings)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("new unsaved file was written")
	}
}

func TestVersionedFixesUseUnsavedUTF16Ranges(t *testing.T) {
	prefix := `type Result<T,E>={value:T;error:E};declare function save():Result<number,Error>;`
	disk := prefix + `const text="disk";save()`
	text := prefix + `const text="😀";save()` + "\r\nvoid text"
	dir := toolingProject(t, map[string]string{"fixture.ts": disk})
	path := filepath.Join(dir, "fixture.ts")
	uri := fileURI(path)
	server := lspServer{project: filepath.Join(dir, "tsconfig.json"), documents: map[string]lspDocument{uri: {Text: text, Version: 3}}}
	actions, err := server.codeActions(uri, lspRange{})
	if err != nil || len(actions) != 1 {
		t.Fatalf("actions: %#v %v", actions, err)
	}
	edit := actions[0].Edit.DocumentChanges[0]
	if edit.TextDocument.Version == nil || *edit.TextDocument.Version != 3 {
		t.Fatalf("unversioned edit: %#v", edit)
	}
	offset := strings.LastIndex(text, "save()")
	want := len(utf16.Encode([]rune(text[:offset])))
	if edit.Edits[0].Range.Start.Character != want || edit.Edits[0].NewText != "void " {
		t.Fatalf("byte-based edit: %#v, want character %d", edit, want)
	}
	start, end := positionsForText(text, strings.Index(text, "void text"), len("void"))
	if start.Line != 1 || start.Character != 0 || end.Character != 4 {
		t.Fatalf("CRLF range: %v %v", start, end)
	}
	if uriToPath(fileURI(filepath.Join(dir, "literal%20.ts"))) != filepath.Join(dir, "literal%20.ts") {
		t.Fatal("URI decoded twice")
	}
}

func TestOverviewResolvesBarrelsAndPreviewDoesNotWrite(t *testing.T) {
	source := `export declare class ResultTask<A,E=never,R=never>{readonly value:A;readonly error:E;readonly requirements:R};export interface Clock{now():number};export declare function load():ResultTask<number,Error,Clock>`
	dir := toolingProject(t, map[string]string{"tasks.ts": source, "index.ts": "export {load as fetchValue} from './tasks.js'", "preview.ts": "export {};type Result<T,E>={value:T;error:E};declare function save():Result<number,Error>;save()"})
	opened, _, err := project.Open(filepath.Join(dir, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	overview, err := analyzer.BuildOverview(context.Background(), opened.Program, opened.Directory, config.Defaults())
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, entry := range overview.Entries {
		if entry.Name == "fetchValue" {
			found = true
			if filepath.Base(entry.ExportedFrom) != "index.ts" || filepath.Base(entry.Declaration.File) != "tasks.ts" || entry.Channels.Requirements != "Clock" {
				t.Fatalf("barrel origin: %#v", entry)
			}
		}
	}
	if !found {
		t.Fatalf("missing barrel: %#v", overview)
	}
	before, _ := os.ReadFile(filepath.Join(dir, "tasks.ts"))
	writer, err := os.CreateTemp(t.TempDir(), "preview")
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	original := os.Stdout
	os.Stdout = writer
	defer func() { os.Stdout = original }()
	if code := run([]string{"overview", "--project", opened.ConfigPath, "--json", "--file", "index.ts"}); code != 0 {
		t.Fatalf("overview exit: %d", code)
	}
	if code := run([]string{"quickfixes", "--project", opened.ConfigPath, "--json"}); code != 0 {
		t.Fatalf("quickfixes exit: %d", code)
	}
	after, _ := os.ReadFile(filepath.Join(dir, "tasks.ts"))
	if !bytes.Equal(before, after) {
		t.Fatal("preview changed source")
	}
	if _, err := writer.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(writer)
	var inventory analyzer.Overview
	if err := decoder.Decode(&inventory); err != nil || inventory.SchemaVersion != 1 || len(inventory.Entries) != 1 {
		t.Fatalf("invalid inventory: %#v %v", inventory, err)
	}
	var finding struct {
		Rule  string         `json:"rule"`
		Fixes []analyzer.Fix `json:"fixes"`
	}
	if err := decoder.Decode(&finding); err != nil || finding.Rule != "no-discard" || len(finding.Fixes) != 1 {
		t.Fatalf("invalid fix preview: %#v %v", finding, err)
	}
}

func TestDebouncedDiagnosticsPublishLatestVersion(t *testing.T) {
	dir := toolingProject(t, map[string]string{"main.ts": "export const value:number=1"})
	uri := fileURI(filepath.Join(dir, "main.ts"))
	serverInput, clientOutput := io.Pipe()
	clientInput, serverOutput := io.Pipe()
	t.Cleanup(func() { serverInput.Close(); clientOutput.Close(); clientInput.Close(); serverOutput.Close() })
	server := lspServer{project: filepath.Join(dir, "tsconfig.json"), reader: bufio.NewReader(serverInput), writer: serverOutput, documents: map[string]lspDocument{}}
	completed := make(chan int, 1)
	go func() { completed <- server.serve(); serverInput.Close(); serverOutput.Close() }()
	messages := make(chan lspMessage, 8)
	go func() {
		reader := bufio.NewReader(clientInput)
		for {
			message, err := readLSPMessage(reader)
			if err != nil {
				return
			}
			messages <- message
		}
	}()
	send := func(method string, id any, params any) {
		t.Helper()
		payload, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": method, "id": id, "params": params})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = fmt.Fprintf(clientOutput, "Content-Length: %d\r\n\r\n%s", len(payload), payload); err != nil {
			t.Fatal(err)
		}
	}
	next := func() lspMessage {
		t.Helper()
		select {
		case message := <-messages:
			return message
		case <-time.After(3 * time.Second):
			t.Fatal("timed out waiting for LSP response")
			return lspMessage{}
		}
	}
	send("textDocument/didOpen", nil, map[string]any{"textDocument": map[string]any{"uri": uri, "version": 1, "text": "export const value:number='wrong'"}})
	if next().Method != "textDocument/publishDiagnostics" {
		t.Fatal("missing initial diagnostics")
	}
	for version := 2; version <= 4; version++ {
		text := "export const value:number=1"
		if version == 3 {
			text = "export const value:number='wrong'"
		}
		send("textDocument/didChange", nil, map[string]any{"textDocument": map[string]any{"uri": uri, "version": version}, "contentChanges": []map[string]any{{"text": text}}})
	}
	message := next()
	var published struct {
		Version     int             `json:"version"`
		Diagnostics []lspDiagnostic `json:"diagnostics"`
	}
	if err := json.Unmarshal(message.Params, &published); err != nil || published.Version != 4 || len(published.Diagnostics) != 0 {
		t.Fatalf("stale publication: %s %v", message.Params, err)
	}
	send("shutdown", 1, nil)
	if string(next().ID) != "1" {
		t.Fatal("missing shutdown response")
	}
	send("exit", nil, nil)
	select {
	case code := <-completed:
		if code != 0 {
			t.Fatalf("server exit: %d", code)
		}
	case <-time.After(time.Second):
		t.Fatal("server did not exit")
	}
}
