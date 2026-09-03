package analyzer

import (
	"strings"

	"github.com/microsoft/typescript-go/internal/ast"
)

type suppression struct {
	line  int
	rules map[string]struct{}
}

func filterSuppressed(file *ast.SourceFile, findings []Finding) []Finding {
	suppressions := parseSuppressions(file.Text())
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

func parseSuppressions(text string) []suppression {
	lines := strings.Split(text, "\n")
	result := make([]suppression, 0)
	for index, line := range lines {
		for _, directive := range []struct {
			name   string
			offset int
		}{
			{name: "resultar-check-disable-next-line", offset: 1},
			{name: "resultar-check-disable-line", offset: 0},
		} {
			position := strings.Index(line, directive.name)
			commentPosition := strings.Index(line, "//")
			if position < 0 || commentPosition < 0 || position < commentPosition {
				continue
			}
			rest := strings.TrimSpace(line[position+len(directive.name):])
			rules := make(map[string]struct{})
			for _, rule := range strings.Fields(rest) {
				if strings.HasPrefix(rule, "//") || strings.HasPrefix(rule, "*/") {
					break
				}
				rules[canonicalRule(rule)] = struct{}{}
			}
			result = append(result, suppression{line: index + 1 + directive.offset, rules: rules})
		}
	}
	return result
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
