package output

import (
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"path/filepath"
	"sort"
	"strings"

	"github.com/microsoft/typescript-go/resultar-check/internal/analyzer"
)

type Format string

const (
	FormatHuman Format = "human"
	FormatJSON  Format = "json"
	FormatSARIF Format = "sarif"
	FormatJUnit Format = "junit"
)

// Diagnostic is the format-neutral representation shared by the CLI and
// editor integrations. Rule diagnostics use Rule; compiler diagnostics use
// Type=typescript and Code.
type Diagnostic struct {
	Column   int            `json:"column,omitempty"`
	Code     int32          `json:"code,omitempty"`
	File     string         `json:"file,omitempty"`
	Length   int            `json:"length,omitempty"`
	Line     int            `json:"line,omitempty"`
	Message  string         `json:"message"`
	Rule     string         `json:"rule,omitempty"`
	Severity string         `json:"severity"`
	Start    int            `json:"start,omitempty"`
	Type     string         `json:"type,omitempty"`
	Fixes    []analyzer.Fix `json:"fixes,omitempty"`
}

func FromFinding(finding analyzer.Finding) Diagnostic {
	return Diagnostic{
		Column: finding.Column, File: finding.File, Length: finding.Length,
		Line: finding.Line, Message: finding.Message, Rule: finding.Rule,
		Severity: string(finding.Severity), Start: finding.Start, Type: finding.Type, Fixes: finding.Fixes,
	}
}

func Write(w io.Writer, diagnostics []Diagnostic, format Format, cwd string) error {
	switch format {
	case FormatJSON:
		encoder := json.NewEncoder(w)
		for _, diagnostic := range diagnostics {
			if err := encoder.Encode(diagnostic); err != nil {
				return err
			}
		}
		return nil
	case FormatSARIF:
		return writeSARIF(w, diagnostics, cwd)
	case FormatJUnit:
		return writeJUnit(w, diagnostics)
	default:
		return fmt.Errorf("unsupported output format %q", format)
	}
}

type sarifLog struct {
	XMLName xml.Name   `json:"-"`
	Version string     `json:"version"`
	Schema  string     `json:"$schema"`
	Runs    []sarifRun `json:"runs"`
}

type sarifRun struct {
	Tool    sarifTool     `json:"tool"`
	Results []sarifResult `json:"results"`
}

type sarifTool struct {
	Driver sarifDriver `json:"driver"`
}

type sarifDriver struct {
	Name  string      `json:"name"`
	Rules []sarifRule `json:"rules,omitempty"`
}

type sarifRule struct {
	ID string `json:"id"`
}

type sarifResult struct {
	RuleID    string          `json:"ruleId,omitempty"`
	Level     string          `json:"level"`
	Message   sarifMessage    `json:"message"`
	Locations []sarifLocation `json:"locations,omitempty"`
}

type sarifMessage struct {
	Text string `json:"text"`
}

type sarifLocation struct {
	PhysicalLocation sarifPhysicalLocation `json:"physicalLocation"`
}

type sarifPhysicalLocation struct {
	ArtifactLocation sarifArtifactLocation `json:"artifactLocation"`
	Region           sarifRegion           `json:"region"`
}

type sarifArtifactLocation struct {
	URI string `json:"uri"`
}

type sarifRegion struct {
	StartLine   int `json:"startLine,omitempty"`
	StartColumn int `json:"startColumn,omitempty"`
	CharLength  int `json:"charLength,omitempty"`
}

func writeSARIF(w io.Writer, diagnostics []Diagnostic, cwd string) error {
	rules := make(map[string]struct{})
	results := make([]sarifResult, 0, len(diagnostics))
	for _, diagnostic := range diagnostics {
		ruleID := diagnostic.Rule
		if ruleID == "" && diagnostic.Type == "typescript" && diagnostic.Code != 0 {
			ruleID = fmt.Sprintf("typescript/%d", diagnostic.Code)
		}
		if ruleID != "" {
			rules[ruleID] = struct{}{}
		}
		result := sarifResult{
			RuleID:  ruleID,
			Level:   sarifLevel(diagnostic.Severity),
			Message: sarifMessage{Text: diagnostic.Message},
		}
		if diagnostic.File != "" {
			uri := filepath.ToSlash(diagnostic.File)
			if relative, err := filepath.Rel(cwd, diagnostic.File); err == nil && !strings.HasPrefix(relative, "..") {
				uri = filepath.ToSlash(relative)
			}
			result.Locations = []sarifLocation{{PhysicalLocation: sarifPhysicalLocation{
				ArtifactLocation: sarifArtifactLocation{URI: uri},
				Region:           sarifRegion{StartLine: diagnostic.Line, StartColumn: diagnostic.Column, CharLength: diagnostic.Length},
			}}}
		}
		results = append(results, result)
	}
	ruleList := make([]sarifRule, 0, len(rules))
	ruleIDs := make([]string, 0, len(rules))
	for ruleID := range rules {
		ruleIDs = append(ruleIDs, ruleID)
	}
	sort.Strings(ruleIDs)
	for _, ruleID := range ruleIDs {
		ruleList = append(ruleList, sarifRule{ID: ruleID})
	}
	return json.NewEncoder(w).Encode(sarifLog{
		Version: "2.1.0", Schema: "https://json.schemastore.org/sarif-2.1.0.json",
		Runs: []sarifRun{{Tool: sarifTool{Driver: sarifDriver{Name: "resultar-check", Rules: ruleList}}, Results: results}},
	})
}

func sarifLevel(severity string) string {
	switch strings.ToLower(severity) {
	case "error":
		return "error"
	case "warning":
		return "warning"
	default:
		return "note"
	}
}

type junitTestSuite struct {
	XMLName   xml.Name        `xml:"testsuite"`
	Name      string          `xml:"name,attr"`
	Tests     int             `xml:"tests,attr"`
	Failures  int             `xml:"failures,attr"`
	TestCases []junitTestCase `xml:"testcase"`
}

type junitTestCase struct {
	Name      string        `xml:"name,attr"`
	Classname string        `xml:"classname,attr,omitempty"`
	Failure   *junitFailure `xml:"failure,omitempty"`
}

type junitFailure struct {
	Message string `xml:"message,attr"`
	Text    string `xml:",chardata"`
}

func writeJUnit(w io.Writer, diagnostics []Diagnostic) error {
	testCases := make([]junitTestCase, 0, len(diagnostics))
	for index, diagnostic := range diagnostics {
		name := diagnostic.Rule
		if name == "" {
			name = diagnostic.Type
		}
		if name == "" {
			name = "diagnostic"
		}
		name = fmt.Sprintf("%s[%d]", name, index+1)
		failure := &junitFailure{Message: diagnostic.Message, Text: diagnostic.Message}
		classname := diagnostic.File
		testCases = append(testCases, junitTestCase{Name: name, Classname: classname, Failure: failure})
	}
	suite := junitTestSuite{Name: "resultar-check", Tests: len(testCases), Failures: len(testCases), TestCases: testCases}
	_, err := io.WriteString(w, xml.Header)
	if err != nil {
		return err
	}
	encoder := xml.NewEncoder(w)
	encoder.Indent("", "  ")
	return encoder.Encode(suite)
}
