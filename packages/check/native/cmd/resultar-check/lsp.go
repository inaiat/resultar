package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/microsoft/typescript-go/resultar-check/internal/analyzer"
	"github.com/microsoft/typescript-go/resultar-check/internal/config"
	"github.com/microsoft/typescript-go/resultar-check/internal/output"
	"github.com/microsoft/typescript-go/resultar-check/internal/project"
)

type lspServer struct {
	reader           *bufio.Reader
	writer           io.Writer
	project          string
	rootPath         string
	shutdown         bool
	exited           bool
	documents        map[string]lspDocument
	cacheDiagnostics []output.Diagnostic
	cacheProjectTime time.Time
	cacheValid       bool
	cacheOpened      *project.Opened
	pendingPublish   bool
}

type lspDocument struct {
	Text    string
	Version int
}

type lspMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type lspInitializeParams struct {
	RootURI  string `json:"rootUri"`
	RootPath string `json:"rootPath"`
}

type lspPosition struct {
	Line      int `json:"line"`
	Character int `json:"character"`
}
type lspRange struct {
	Start lspPosition `json:"start"`
	End   lspPosition `json:"end"`
}
type lspDiagnostic struct {
	Range    lspRange `json:"range"`
	Severity int      `json:"severity,omitempty"`
	Code     any      `json:"code,omitempty"`
	Source   string   `json:"source,omitempty"`
	Message  string   `json:"message"`
}

type lspCodeAction struct {
	Title string           `json:"title"`
	Kind  string           `json:"kind"`
	Edit  lspWorkspaceEdit `json:"edit"`
	Data  lspFixData       `json:"data"`
}

type lspFixData struct {
	Kind        analyzer.FixKind `json:"kind"`
	Description string           `json:"description,omitempty"`
}

type lspWorkspaceEdit struct {
	Changes         map[string][]lspTextEdit `json:"changes,omitempty"`
	DocumentChanges []lspDocumentEdit        `json:"documentChanges,omitempty"`
}

type lspDocumentEdit struct {
	TextDocument lspVersionedDocument `json:"textDocument"`
	Edits        []lspTextEdit        `json:"edits"`
}
type lspVersionedDocument struct {
	URI     string `json:"uri"`
	Version *int   `json:"version"`
}

type lspTextEdit struct {
	Range   lspRange `json:"range"`
	NewText string   `json:"newText"`
}

func runLSP(args []string) int {
	flags := flag.NewFlagSet("resultar-check lsp", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	projectPath := "tsconfig.json"
	help := false
	stdio := false
	flags.StringVar(&projectPath, "project", projectPath, "TypeScript project")
	flags.StringVar(&projectPath, "p", projectPath, "TypeScript project")
	flags.BoolVar(&help, "help", false, "show help")
	flags.BoolVar(&help, "h", false, "show help")
	flags.BoolVar(&stdio, "stdio", false, "use stdio transport")
	if err := flags.Parse(args); err != nil {
		return 1
	}
	if help {
		fmt.Fprintln(os.Stdout, "Usage: resultar-check lsp [--project tsconfig.json]")
		return 0
	}
	if flags.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "Unknown argument: %s\n", flags.Arg(0))
		return 1
	}
	server := &lspServer{
		documents: make(map[string]lspDocument),
		reader:    bufio.NewReader(os.Stdin),
		writer:    os.Stdout,
		project:   projectPath,
	}
	return server.serve()
}

func (s *lspServer) serve() int {
	type event struct {
		message lspMessage
		err     error
	}
	incoming := make(chan event, 32)
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		for {
			message, err := readLSPMessage(s.reader)
			select {
			case incoming <- event{message, err}:
			case <-finished:
				return
			}
			if err != nil {
				return
			}
		}
	}()
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	defer timer.Stop()
	for {
		select {
		case next := <-incoming:
			if next.err == io.EOF {
				return 0
			}
			if next.err != nil {
				fmt.Fprintln(os.Stderr, "resultar-check lsp:", next.err)
				return 1
			}
			if err := s.handle(next.message); err != nil {
				fmt.Fprintln(os.Stderr, "resultar-check lsp:", err)
				return 1
			}
			if s.exited {
				return 0
			}
			if s.pendingPublish && !s.shutdown {
				timer.Reset(150 * time.Millisecond)
			}
		case <-timer.C:
			if s.pendingPublish && !s.shutdown {
				s.pendingPublish = false
				if err := s.publishAll(); err != nil {
					fmt.Fprintln(os.Stderr, err)
					return 1
				}
			}
		}
	}
}

func (s *lspServer) handle(message lspMessage) error {
	switch message.Method {
	case "initialize":
		var params lspInitializeParams
		_ = json.Unmarshal(message.Params, &params)
		if params.RootURI != "" {
			s.rootPath = uriToPath(params.RootURI)
		}
		if s.rootPath == "" && params.RootPath != "" {
			s.rootPath = params.RootPath
		}
		if s.rootPath != "" && s.project == "tsconfig.json" {
			s.project = filepath.Join(s.rootPath, s.project)
		}
		return s.respond(message.ID, map[string]any{
			"capabilities": map[string]any{
				"textDocumentSync": map[string]any{
					"change":    1,
					"openClose": true,
					"save":      map[string]any{"includeText": false},
				},
				"codeActionProvider": map[string]any{"codeActionKinds": []string{"quickfix", "refactor.rewrite"}},
				"hoverProvider":      true,
				"diagnosticProvider": map[string]any{"interFileDependencies": true, "workspaceDiagnostics": false},
			},
		})
	case "shutdown":
		s.shutdown = true
		return s.respond(message.ID, nil)
	case "exit":
		s.exited = true
		return nil
	case "textDocument/didOpen":
		var params struct {
			TextDocument struct {
				URI     string `json:"uri"`
				Text    string `json:"text"`
				Version int    `json:"version"`
			} `json:"textDocument"`
		}
		if err := json.Unmarshal(message.Params, &params); err != nil {
			return err
		}
		if s.documents == nil {
			s.documents = map[string]lspDocument{}
		}
		s.documents[params.TextDocument.URI] = lspDocument{Text: params.TextDocument.Text, Version: params.TextDocument.Version}
		s.invalidateDiagnostics()
		return s.publishAll()
	case "textDocument/didChange":
		var params struct {
			TextDocument struct {
				URI     string `json:"uri"`
				Version int    `json:"version"`
			} `json:"textDocument"`
			ContentChanges []struct {
				Text string `json:"text"`
			} `json:"contentChanges"`
		}
		if err := json.Unmarshal(message.Params, &params); err != nil {
			return err
		}
		if previous, ok := s.documents[params.TextDocument.URI]; ok && params.TextDocument.Version <= previous.Version {
			return nil
		}
		if len(params.ContentChanges) > 0 {
			s.documents[params.TextDocument.URI] = lspDocument{
				Text:    params.ContentChanges[len(params.ContentChanges)-1].Text,
				Version: params.TextDocument.Version,
			}
		}
		s.invalidateDiagnostics()
		s.pendingPublish = true
		return nil
	case "textDocument/didSave":
		var params struct {
			TextDocument struct {
				URI string `json:"uri"`
			} `json:"textDocument"`
		}
		if err := json.Unmarshal(message.Params, &params); err != nil {
			return err
		}
		s.invalidateDiagnostics()
		return s.publishAll()
	case "textDocument/didClose":
		var params struct {
			TextDocument struct {
				URI string `json:"uri"`
			} `json:"textDocument"`
		}
		if err := json.Unmarshal(message.Params, &params); err != nil {
			return err
		}
		delete(s.documents, params.TextDocument.URI)
		s.invalidateDiagnostics()
		if err := s.publishDiagnostics(params.TextDocument.URI, nil); err != nil {
			return err
		}
		return s.publishAll()
	case "workspace/didChangeWatchedFiles":
		s.invalidateDiagnostics()
		return s.publishAll()
	case "textDocument/hover":
		var params struct {
			TextDocument struct {
				URI string `json:"uri"`
			} `json:"textDocument"`
			Position lspPosition `json:"position"`
		}
		if err := json.Unmarshal(message.Params, &params); err != nil {
			return err
		}
		if _, err := s.diagnostics(); err != nil || s.cacheOpened == nil {
			return s.respond(message.ID, nil)
		}
		text := s.snapshotText(uriToPath(params.TextDocument.URI))
		hover, err := analyzer.HoverAt(context.Background(), s.cacheOpened.Program, uriToPath(params.TextDocument.URI), offsetForPosition(text, params.Position))
		if err != nil || hover == "" {
			return s.respond(message.ID, nil)
		}
		return s.respond(message.ID, map[string]any{"contents": map[string]any{"kind": "markdown", "value": hover}})
	case "textDocument/diagnostic":
		var params struct {
			TextDocument struct {
				URI string `json:"uri"`
			} `json:"textDocument"`
		}
		if err := json.Unmarshal(message.Params, &params); err != nil {
			return err
		}
		diagnostics, err := s.diagnostics()
		if err != nil {
			return s.respond(message.ID, map[string]any{"kind": "full", "items": []lspDiagnostic{{Message: err.Error(), Severity: 1, Source: "resultar-check"}}})
		}
		items := []lspDiagnostic{}
		for _, diagnostic := range diagnostics {
			if filepath.Clean(diagnostic.File) == filepath.Clean(uriToPath(params.TextDocument.URI)) {
				items = append(items, s.diagnostic(diagnostic))
			}
		}
		return s.respond(message.ID, map[string]any{"kind": "full", "items": items})
	case "textDocument/codeAction":
		var params struct {
			TextDocument struct {
				URI string `json:"uri"`
			} `json:"textDocument"`
			Range   lspRange `json:"range"`
			Context struct {
				Only []string `json:"only"`
			} `json:"context"`
		}
		if err := json.Unmarshal(message.Params, &params); err != nil {
			return err
		}
		actions, err := s.codeActions(params.TextDocument.URI, params.Range)
		if err != nil {
			return s.respond(message.ID, []lspCodeAction{})
		}
		if len(params.Context.Only) > 0 {
			filtered := []lspCodeAction{}
			for _, action := range actions {
				for _, kind := range params.Context.Only {
					if action.Kind == kind || strings.HasPrefix(action.Kind, kind+".") {
						filtered = append(filtered, action)
						break
					}
				}
			}
			actions = filtered
		}
		return s.respond(message.ID, actions)
	default:
		if len(message.ID) > 0 && string(message.ID) != "null" {
			return s.respond(message.ID, nil)
		}
		return nil
	}
}

func (s *lspServer) publish(uri string) error {
	diagnostics, err := s.diagnostics()
	if err != nil {
		return s.publishDiagnostics(uri, []lspDiagnostic{{Message: err.Error(), Severity: 1, Source: "resultar-check"}})
	}
	path := uriToPath(uri)
	filtered := make([]lspDiagnostic, 0, len(diagnostics))
	for _, diagnostic := range diagnostics {
		if path == "" || filepath.Clean(path) == filepath.Clean(diagnostic.File) {
			filtered = append(filtered, s.diagnostic(diagnostic))
		}
	}
	return s.publishDiagnostics(uri, filtered)
}

func (s *lspServer) diagnostics() ([]output.Diagnostic, error) {
	projectTime := modificationTime(s.project)
	if s.cacheValid && projectTime.Equal(s.cacheProjectTime) {
		return s.cacheDiagnostics, nil
	}
	overlay := map[string]string{}
	for uri, document := range s.documents {
		path := uriToPath(uri)
		if path != "" {
			overlay[path] = document.Text
		}
	}
	opened, openDiagnostics, err := project.OpenWithOverlay(s.project, overlay)
	if err != nil {
		return nil, err
	}
	if len(openDiagnostics) > 0 {
		diagnostics := tsDiagnostics(openDiagnostics)
		s.setDiagnosticCache(diagnostics, projectTime)
		return diagnostics, nil
	}
	s.cacheOpened = opened
	options, err := config.Load(opened.ConfigPath)
	if err != nil {
		return nil, err
	}
	ctx := context.Background()
	findings := collectTypeScriptDiagnostics(ctx, opened.Program, opened.Program.SourceFiles())
	if len(findings) > 0 {
		s.setDiagnosticCache(findings, projectTime)
		return findings, nil
	}
	analysis, err := analyzer.Run(ctx, opened.Program, opened.Directory, options)
	if err != nil {
		return nil, err
	}
	diagnostics := findingDiagnostics(analysis)
	s.setDiagnosticCache(diagnostics, projectTime)
	return diagnostics, nil
}

func (s *lspServer) invalidateDiagnostics() {
	s.cacheValid = false
	s.cacheOpened = nil
}

func (s *lspServer) setDiagnosticCache(diagnostics []output.Diagnostic, projectTime time.Time) {
	s.cacheDiagnostics = diagnostics
	s.cacheProjectTime = projectTime
	s.cacheValid = true
}

func modificationTime(fileName string) time.Time {
	info, err := os.Stat(fileName)
	if err != nil {
		return time.Time{}
	}
	return info.ModTime()
}

func (s *lspServer) publishDiagnostics(uri string, diagnostics []lspDiagnostic) error {
	params := map[string]any{"uri": uri, "diagnostics": diagnostics}
	if document, ok := s.documents[uri]; ok {
		params["version"] = document.Version
	}
	return s.notify("textDocument/publishDiagnostics", params)
}

func (s *lspServer) codeActions(uri string, requested lspRange) ([]lspCodeAction, error) {
	diagnostics, err := s.diagnostics()
	if err != nil {
		return nil, err
	}
	path := uriToPath(uri)
	actions := make([]lspCodeAction, 0)
	for _, diagnostic := range diagnostics {
		if path != "" && filepath.Clean(path) != filepath.Clean(diagnostic.File) {
			continue
		}
		if !rangeIntersects(s.diagnostic(diagnostic).Range, requested) {
			continue
		}
		for _, fix := range diagnostic.Fixes {
			edits := make([]lspTextEdit, 0, len(fix.Edits))
			for _, edit := range fix.Edits {
				start, end := positionsForText(s.snapshotText(diagnostic.File), edit.Start, edit.Length)
				edits = append(edits, lspTextEdit{Range: lspRange{Start: start, End: end}, NewText: edit.NewText})
			}
			actions = append(actions, lspCodeAction{Title: fix.Title, Kind: "quickfix", Edit: s.versionedEdit(uri, edits), Data: lspFixData{Kind: fix.Kind, Description: fix.Description}})
		}
	}
	canRefactor := s.cacheOpened != nil
	for _, diagnostic := range diagnostics {
		if diagnostic.Type == "typescript" {
			canRefactor = false
			break
		}
	}
	if canRefactor {
		fixes, err := analyzer.Refactors(context.Background(), s.cacheOpened.Program, path)
		if err == nil {
			for _, fix := range fixes {
				edits := []lspTextEdit{}
				for _, edit := range fix.Edits {
					start, end := positionsForText(s.snapshotText(path), edit.Start, edit.Length)
					edits = append(edits, lspTextEdit{Range: lspRange{Start: start, End: end}, NewText: edit.NewText})
				}
				if len(edits) > 0 && rangeIntersects(edits[0].Range, requested) {
					actions = append(actions, lspCodeAction{Title: fix.Title, Kind: "refactor.rewrite", Edit: s.versionedEdit(uri, edits), Data: lspFixData{Kind: fix.Kind, Description: fix.Description}})
				}
			}
		}
	}

	return actions, nil
}

func rangeIntersects(left, right lspRange) bool {
	if right.Start.Line == 0 && right.Start.Character == 0 && right.End.Line == 0 && right.End.Character == 0 {
		return true
	}
	return positionBefore(left.Start, right.End) && positionBefore(right.Start, left.End)
}

func positionBefore(left, right lspPosition) bool {
	return left.Line < right.Line || left.Line == right.Line && left.Character <= right.Character
}

func (s *lspServer) respond(id json.RawMessage, result any) error {
	return s.write(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(id), "result": result})
}

func (s *lspServer) notify(method string, params any) error {
	return s.write(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func (s *lspServer) write(value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(s.writer, "Content-Length: %d\r\n\r\n%s", len(payload), payload)
	return err
}

func readLSPMessage(reader *bufio.Reader) (lspMessage, error) {
	length := -1
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return lspMessage{}, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) == 2 && strings.EqualFold(strings.TrimSpace(parts[0]), "Content-Length") {
			length, err = strconv.Atoi(strings.TrimSpace(parts[1]))
			if err != nil {
				return lspMessage{}, fmt.Errorf("invalid Content-Length")
			}
		}
	}
	if length < 0 {
		return lspMessage{}, fmt.Errorf("missing Content-Length")
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return lspMessage{}, err
	}
	var message lspMessage
	if err := json.NewDecoder(bytes.NewReader(payload)).Decode(&message); err != nil {
		return lspMessage{}, err
	}
	return message, nil
}

func uriToPath(value string) string {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" {
		return value
	}
	if parsed.Scheme != "file" {
		return ""
	}
	path := parsed.Path
	if len(path) > 2 && filepath.VolumeName(path[1:]) != "" {
		path = path[1:]
	}
	if parsed.Host != "" && parsed.Host != "localhost" {
		path = "//" + parsed.Host + path
	}
	return filepath.FromSlash(path)
}

func toLSPDiagnostic(diagnostic output.Diagnostic) lspDiagnostic {
	severity := 3
	switch strings.ToLower(diagnostic.Severity) {
	case "error":
		severity = 1
	case "warning":
		severity = 2
	case "suggestion":
		severity = 4
	}
	code := any(diagnostic.Rule)
	if diagnostic.Type == "typescript" {
		code = diagnostic.Code
	}
	start := lspPosition{Line: max(0, diagnostic.Line-1), Character: max(0, diagnostic.Column-1)}
	end := start
	if diagnostic.Length > 0 {
		end.Character += diagnostic.Length
	}
	return lspDiagnostic{Range: lspRange{Start: start, End: end}, Severity: severity, Code: code, Source: "resultar-check", Message: diagnostic.Message}
}

func positionForOffset(fileName string, offset, length int) (lspPosition, lspPosition) {
	contents, err := os.ReadFile(fileName)
	if err != nil {
		return lspPosition{}, lspPosition{}
	}
	return positionsForText(string(contents), offset, length)
}

func positionsForText(text string, offset, length int) (lspPosition, lspPosition) {
	offset = max(0, min(offset, len(text)))
	endOffset := max(offset, min(offset+length, len(text)))
	position := func(end int) lspPosition {
		line, character := 0, 0
		for _, r := range text[:end] {
			if r == '\n' {
				line++
				character = 0
			} else {
				character += utf16.RuneLen(r)
			}
		}
		return lspPosition{Line: line, Character: character}
	}
	return position(offset), position(endOffset)
}
func offsetForPosition(text string, position lspPosition) int {
	line, character := 0, 0
	for offset, r := range text {
		if line == position.Line && character >= position.Character {
			return offset
		}
		if r == '\n' {
			if line == position.Line {
				return offset
			}
			line++
			character = 0
		} else {
			character += utf16.RuneLen(r)
		}
	}
	return len(text)
}
func (s *lspServer) snapshotText(path string) string {
	for uri, document := range s.documents {
		if filepath.Clean(uriToPath(uri)) == filepath.Clean(path) {
			return document.Text
		}
	}
	if s.cacheOpened != nil {
		for _, file := range s.cacheOpened.Program.SourceFiles() {
			if filepath.Clean(file.FileName()) == filepath.Clean(path) {
				return file.Text()
			}
		}
	}
	text, _ := os.ReadFile(path)
	return string(text)
}
func (s *lspServer) diagnostic(d output.Diagnostic) lspDiagnostic {
	result := toLSPDiagnostic(d)
	text := s.snapshotText(d.File)
	if text != "" {
		start, end := positionsForText(text, d.Start, d.Length)
		result.Range = lspRange{Start: start, End: end}
	}
	return result
}
func (s *lspServer) versionedEdit(uri string, edits []lspTextEdit) lspWorkspaceEdit {
	var version *int
	if document, ok := s.documents[uri]; ok {
		value := document.Version
		version = &value
	}
	return lspWorkspaceEdit{DocumentChanges: []lspDocumentEdit{{TextDocument: lspVersionedDocument{URI: uri, Version: version}, Edits: edits}}}
}
func (s *lspServer) publishAll() error {
	uris := make([]string, 0, len(s.documents))
	for uri := range s.documents {
		uris = append(uris, uri)
	}
	sort.Strings(uris)
	for _, uri := range uris {
		if err := s.publish(uri); err != nil {
			return err
		}
	}
	return nil
}

func max(left, right int) int {
	if left > right {
		return left
	}
	return right
}
