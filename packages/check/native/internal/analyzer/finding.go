package analyzer

import (
	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/scanner"
	"github.com/microsoft/typescript-go/resultar-check/internal/config"
)

type Finding struct {
	Column   int             `json:"column"`
	File     string          `json:"file"`
	Length   int             `json:"length"`
	Line     int             `json:"line"`
	Message  string          `json:"message"`
	Rule     string          `json:"rule"`
	Severity config.Severity `json:"severity"`
	Start    int             `json:"start"`
	Type     string          `json:"type,omitempty"`
	Fixes    []Fix           `json:"fixes,omitempty"`
}

type Fix struct {
	Title string     `json:"title"`
	Edits []TextEdit `json:"edits"`
}

type TextEdit struct {
	Start   int    `json:"start"`
	Length  int    `json:"length"`
	NewText string `json:"newText"`
}

func newFinding(file *ast.SourceFile, node *ast.Node, rule string, severity config.Severity, message, typeName string) Finding {
	range_ := scanner.GetRangeOfTokenAtPosition(file, node.Pos()).WithEnd(node.End())
	line, column := scanner.GetECMALineAndUTF16CharacterOfPosition(file, range_.Pos())
	return Finding{
		Column:   int(column) + 1,
		File:     file.FileName(),
		Length:   range_.Len(),
		Line:     line + 1,
		Message:  message,
		Rule:     rule,
		Severity: severity,
		Start:    range_.Pos(),
		Type:     typeName,
	}
}

func renameFix(file *ast.SourceFile, node *ast.Node, title, newText string) Fix {
	range_ := scanner.GetRangeOfTokenAtPosition(file, node.Pos()).WithEnd(node.End())
	return Fix{Title: title, Edits: []TextEdit{{Start: range_.Pos(), Length: range_.Len(), NewText: newText}}}
}

func insertFix(file *ast.SourceFile, node *ast.Node, title, newText string) Fix {
	position := scanner.GetRangeOfTokenAtPosition(file, node.Pos()).Pos()
	return Fix{Title: title, Edits: []TextEdit{{Start: position, NewText: newText}}}
}

func replaceTokenFix(file *ast.SourceFile, node *ast.Node, title, newText string) Fix {
	range_ := scanner.GetRangeOfTokenAtPosition(file, node.Pos())
	return Fix{Title: title, Edits: []TextEdit{{Start: range_.Pos(), Length: range_.Len(), NewText: newText}}}
}
