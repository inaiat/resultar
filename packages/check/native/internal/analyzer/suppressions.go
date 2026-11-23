package analyzer

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/microsoft/TypeScript/tsc/internal/ast"
	"github.com/microsoft/TypeScript/tsc/internal/scanner"
	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/config"
)

type suppression struct {
	line    int
	start   int
	length  int
	rules   map[string]struct{}
	entries map[string][2]int
}

func filterSuppressed(file *ast.SourceFile, findings []Finding) []Finding {
	suppressions := parseSuppressions(file)
	if len(suppressions) == 0 {
		return findings
	}
	filtered := make([]Finding, 0, len(findings))
	for _, finding := range findings {
		if isSuppressed(suppressions, finding.Line, finding.Rule) {
			continue
		}
		filtered = append(filtered, finding)
	}
	return filtered
}

// sourceComments uses parsed literal boundaries so templates, regexes, and JSX text
// cannot turn their contents into directives or hide comments that follow them.
func sourceComments(file *ast.SourceFile) []ast.CommentRange {
	protected := map[int]int{}
	visit(file.AsNode(), func(node *ast.Node) {
		switch node.Kind {
		case ast.KindStringLiteral, ast.KindRegularExpressionLiteral, ast.KindNoSubstitutionTemplateLiteral,
			ast.KindTemplateHead, ast.KindTemplateMiddle, ast.KindTemplateTail:
			protected[scanner.SkipTrivia(file.Text(), node.Pos())] = node.End()
		case ast.KindJsxText:
			protected[node.Pos()] = node.End()
		}
	})
	result := []ast.CommentRange{}
	scan := scanner.NewScanner()
	scan.SetText(file.Text())
	scan.SetSkipTrivia(false)
	factory := &ast.NodeFactory{}
	for token := scan.Scan(); token != ast.KindEndOfFile; token = scan.Scan() {
		if end, ok := protected[scan.TokenStart()]; ok {
			scan.ResetPos(end)
			continue
		}
		if token == ast.KindSingleLineCommentTrivia || token == ast.KindMultiLineCommentTrivia {
			result = append(result, factory.NewCommentRange(token, scan.TokenStart(), scan.TokenEnd(), false))
		}
	}
	return result
}

func asciiLowerByte(b byte) byte {
	if b >= 'A' && b <= 'Z' {
		return b + ('a' - 'A')
	}
	return b
}

// indexASCIIFold locates a lowercase ASCII needle in s case-insensitively while
// preserving exact byte offsets in s (unlike strings.ToLower, which changes byte
// lengths for Unicode characters such as Ⱥ or İ).
func indexASCIIFold(s, lowerNeedle string) int {
	n := len(lowerNeedle)
	if n == 0 {
		return 0
	}
	if n > len(s) {
		return -1
	}
	for i := 0; i <= len(s)-n; i++ {
		matched := true
		for j := 0; j < n; j++ {
			if asciiLowerByte(s[i+j]) != lowerNeedle[j] {
				matched = false
				break
			}
		}
		if matched {
			return i
		}
	}
	return -1
}

// suppressionJustificationIndex returns the earliest byte offset in rest where an
// inline justification begins (`//` or whitespace-preceded `--`), or -1 if none.
func suppressionJustificationIndex(rest string) int {
	earliest := strings.Index(rest, "//")
	for i := 0; i < len(rest); {
		r, size := utf8.DecodeRuneInString(rest[i:])
		if unicode.IsSpace(r) {
			next := i + size
			if next+1 < len(rest) && rest[next] == '-' && rest[next+1] == '-' {
				if earliest < 0 || next < earliest {
					earliest = next
				}
				break
			}
		}
		i += size
	}
	return earliest
}

func parseSuppressions(file *ast.SourceFile) []suppression {
	text := file.Text()
	result := []suppression{}
	for _, range_ := range sourceComments(file) {
		if range_.Kind != ast.KindSingleLineCommentTrivia {
			continue
		}
		comment := text[range_.Pos():range_.End()]
		for _, directive := range []struct {
			name   string
			offset int
		}{{"resultar-check-disable-next-line", 1}, {"resultar-check-disable-line", 0}} {
			position := indexASCIIFold(comment, directive.name)
			if position < 0 {
				continue
			}
			start := range_.Pos() + position
			rest := comment[position+len(directive.name):]
			if justification := suppressionJustificationIndex(rest); justification >= 0 {
				rest = rest[:justification]
			}
			rules, entries := map[string]struct{}{}, map[string][2]int{}
			cursor := position + len(directive.name)
			for _, rule := range strings.Fields(rest) {
				relative := strings.Index(comment[cursor:], rule) + cursor
				key := canonicalRule(rule)
				rules[key] = struct{}{}
				entries[key] = [2]int{range_.Pos() + relative, len(rule)}
				cursor = relative + len(rule)
			}
			line, _ := scanner.GetECMALineAndUTF16CharacterOfPosition(file, range_.Pos())
			line += 1 + directive.offset
			trimmedRest := strings.TrimRightFunc(rest, unicode.IsSpace)
			result = append(result, suppression{line: line, start: start, length: len(directive.name) + len(trimmedRest), rules: rules, entries: entries})
		}
	}
	return result
}

func (a *Analyzer) applySuppressions(file *ast.SourceFile, findings []Finding) []Finding {
	filtered := filterSuppressed(file, findings)
	if a.options.UnusedSuppression == config.SeverityOff {
		return filtered
	}
	for _, item := range parseSuppressions(file) {
		report := func(start, length int, message string) {
			line, column := scanner.GetECMALineAndUTF16CharacterOfPosition(file, start)
			filtered = append(filtered, Finding{File: string(file.FileName()), Start: start, Length: length, Line: line + 1, Column: int(column) + 1, Rule: "unused-suppression", Severity: a.options.UnusedSuppression, Message: message, Fixes: []Fix{{Title: "Remove unused suppression", Kind: FixCorrection, Description: "Preserves unrelated comment text.", Edits: []TextEdit{{Start: start, Length: length, NewText: ""}}}}})
		}
		used := func(rule string) bool {
			for _, finding := range findings {
				if finding.Line == item.line && (rule == "" || canonicalRule(finding.Rule) == rule) {
					return true
				}
			}
			return false
		}
		if len(item.rules) == 0 {
			if !used("") {
				report(item.start, item.length, "This suppression no longer suppresses an enabled diagnostic.")
			}
			continue
		}
		keepDirective := false
		for rule := range item.rules {
			severity, known := config.RuleSeverity(a.options, rule)
			if used(rule) || (known && (severity == config.SeverityOff || severity == "")) {
				keepDirective = true
			}
		}
		for rule := range item.rules {
			severity, known := config.RuleSeverity(a.options, rule)
			span := item.entries[rule]
			start, length := span[0], span[1]
			// Removing every rule while retaining the directive would create a wildcard.
			if !keepDirective {
				start, length = item.start, item.length
			}
			if !known {
				report(start, length, fmt.Sprintf("Unknown suppressed rule %q.", rule))
				continue
			}
			if severity == config.SeverityOff || severity == "" || used(rule) {
				continue
			}
			report(start, length, fmt.Sprintf("The suppression for %s no longer suppresses an enabled diagnostic.", rule))
		}
	}
	return filtered
}

func isSuppressed(suppressions []suppression, line int, rule string) bool {
	canonical := canonicalRule(rule)
	for _, item := range suppressions {
		if item.line == line {
			if len(item.rules) == 0 {
				return true
			}
			if _, ok := item.rules[canonical]; ok {
				return true
			}
		}
	}
	return false
}

func canonicalRule(value string) string {
	value = strings.TrimPrefix(strings.TrimSpace(value), "resultar/")
	value = strings.ReplaceAll(value, "-", "")
	value = strings.ReplaceAll(value, "_", "")
	return strings.ToLower(value)
}
