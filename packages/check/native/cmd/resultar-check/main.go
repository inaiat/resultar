package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/compiler"
	"github.com/microsoft/typescript-go/internal/scanner"
	"github.com/microsoft/typescript-go/resultar-check/internal/analyzer"
	"github.com/microsoft/typescript-go/resultar-check/internal/config"
	"github.com/microsoft/typescript-go/resultar-check/internal/output"
	"github.com/microsoft/typescript-go/resultar-check/internal/project"
)

const usage = `Usage: resultar-check

Commands:
  init                      Create a portable Zed LSP setup.
  doctor                    Check the project, binary, pnpm, and Zed setup.

Flags:
  --mode <direct|must-use>  Override noDiscardMode.
  -p, --project <path>      TypeScript project. Defaults to tsconfig.json.
  --format <human|json|sarif|junit>  Diagnostic output format (default: human).
  --json                    Alias for --format json (JSON lines).
  --fail-on <severity>      Exit 1 at or above this severity (default: message).
  -h, --help                Show this help.
`

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) > 0 {
		switch args[0] {
		case "help":
			fmt.Print(usage)
			return 0
		case "lsp":
			return runLSP(args[1:])
		case "check":
			fmt.Fprintln(os.Stderr, "The check subcommand was removed. Use resultar-check.")
			return 1
		case "doctor", "patch", "unpatch":
			fmt.Fprintf(os.Stderr, "%s was removed. Use resultar-check with TypeScript 7.\n", args[0])
			return 1
		}
	}

	flags := flag.NewFlagSet("resultar-check", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	var projectPath string
	var mode string
	var jsonOutput bool
	var formatName string
	var failOnName string
	var help bool
	flags.StringVar(&projectPath, "project", "tsconfig.json", "TypeScript project")
	flags.StringVar(&projectPath, "p", "tsconfig.json", "TypeScript project")
	flags.StringVar(&mode, "mode", "", "no-discard mode")
	flags.StringVar(&formatName, "format", string(output.FormatHuman), "diagnostic output format")
	flags.StringVar(&failOnName, "fail-on", "", "minimum severity that fails the command")
	flags.BoolVar(&jsonOutput, "json", false, "emit JSON lines")
	flags.BoolVar(&help, "help", false, "show help")
	flags.BoolVar(&help, "h", false, "show help")
	if err := flags.Parse(args); err != nil {
		return 1
	}
	if help {
		fmt.Print(usage)
		return 0
	}
	if flags.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "Unknown argument: %s\n", flags.Arg(0))
		return 1
	}
	if mode != "" && mode != "direct" && mode != "must-use" {
		fmt.Fprintf(os.Stderr, "Unknown --mode value: %s\n", mode)
		return 1
	}
	if failOnName != "" && !validSeverity(failOnName) {
		fmt.Fprintf(os.Stderr, "Unknown --fail-on value: %s\n", failOnName)
		return 1
	}
	if jsonOutput {
		formatName = string(output.FormatJSON)
	}
	format := output.Format(formatName)
	if format != output.FormatHuman && format != output.FormatJSON && format != output.FormatSARIF && format != output.FormatJUnit {
		fmt.Fprintf(os.Stderr, "Unknown --format value: %s\n", formatName)
		return 1
	}

	opened, diagnostics, err := project.Open(projectPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if len(diagnostics) > 0 {
		if err := writeDiagnostics(format, tsDiagnostics(diagnostics)); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
		return 1
	}
	options, err := config.Load(opened.ConfigPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if mode != "" {
		options.NoDiscardMode = mode
	}
	if failOnName != "" {
		options.FailOn = config.Severity(failOnName)
	}

	ctx := context.Background()
	tsFindings := collectTypeScriptDiagnostics(ctx, opened.Program, opened.Program.SourceFiles())
	if len(tsFindings) > 0 {
		if err := writeDiagnostics(format, tsFindings); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
		return 1
	}
	findings, err := analyzer.Run(ctx, opened.Program, opened.Directory, options)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if format == output.FormatHuman {
		cwd, _ := os.Getwd()
		printHumanFindings(tsFindings, findings, cwd)
	} else {
		all := append(append([]output.Diagnostic(nil), tsFindings...), findingDiagnostics(findings)...)
		if err := output.Write(os.Stdout, all, format, mustGetwd()); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
	}
	if hasFailingFindings(findings, options.FailOn) {
		return 1
	}
	return 0
}

func validSeverity(value string) bool {
	switch config.Severity(value) {
	case config.SeverityError, config.SeverityWarning, config.SeveritySuggestion, config.SeverityMessage, config.SeverityOff:
		return true
	default:
		return false
	}
}

func hasFailingFindings(findings []analyzer.Finding, failOn config.Severity) bool {
	for _, finding := range findings {
		if config.Fails(finding.Severity, failOn) {
			return true
		}
	}
	return false
}

func mustGetwd() string {
	cwd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return cwd
}

func writeDiagnostics(format output.Format, diagnostics []output.Diagnostic) error {
	if format == output.FormatHuman {
		printHumanDiagnostics(diagnostics)
		return nil
	}
	return output.Write(os.Stdout, diagnostics, format, mustGetwd())
}

func findingDiagnostics(findings []analyzer.Finding) []output.Diagnostic {
	result := make([]output.Diagnostic, 0, len(findings))
	for _, finding := range findings {
		result = append(result, output.FromFinding(finding))
	}
	return result
}

func printHumanFindings(tsFindings []output.Diagnostic, findings []analyzer.Finding, cwd string) {
	printHumanDiagnostics(tsFindings)
	for _, finding := range findings {
		file := finding.File
		if relative, err := filepath.Rel(cwd, file); err == nil {
			file = relative
		}
		fmt.Fprintf(os.Stderr, "%s:%d:%d resultar/%s (%s) - %s\n", filepath.ToSlash(file), finding.Line, finding.Column, finding.Rule, finding.Severity, finding.Message)
	}
}

func printHumanDiagnostics(diagnostics []output.Diagnostic) {
	for _, diagnostic := range diagnostics {
		if diagnostic.File != "" && diagnostic.Line > 0 {
			fmt.Fprintf(os.Stderr, "%s:%d:%d - TS%d: %s\n", diagnostic.File, diagnostic.Line, diagnostic.Column, diagnostic.Code, diagnostic.Message)
		} else {
			fmt.Fprintf(os.Stderr, "TS%d: %s\n", diagnostic.Code, diagnostic.Message)
		}
	}
}

func collectTypeScriptDiagnostics(ctx context.Context, program *compiler.Program, files []*ast.SourceFile) []output.Diagnostic {
	findings := make([]output.Diagnostic, 0)
	for _, file := range files {
		diagnostics := program.GetSyntacticDiagnostics(ctx, file)
		findings = append(findings, tsDiagnostics(diagnostics)...)
	}
	semantic := program.GetSemanticDiagnosticsWithoutNoEmitFiltering(ctx, files)
	for _, file := range files {
		diagnostics := compiler.FilterNoEmitSemanticDiagnostics(semantic[file], program.Options())
		findings = append(findings, tsDiagnostics(diagnostics)...)
	}
	findings = append(findings, tsDiagnostics(program.GetGlobalDiagnostics(ctx))...)
	return findings
}

func tsDiagnostics(items []*ast.Diagnostic) []output.Diagnostic {
	findings := make([]output.Diagnostic, 0, len(items))
	for _, diagnostic := range items {
		finding := output.Diagnostic{Code: diagnostic.Code(), Message: diagnosticMessage(diagnostic), Severity: diagnostic.Category().Name(), Type: "typescript"}
		if file := diagnostic.File(); file != nil && diagnostic.Pos() >= 0 {
			line, column := scanner.GetECMALineAndUTF16CharacterOfPosition(file, diagnostic.Pos())
			finding.Column = int(column) + 1
			finding.File = file.FileName()
			finding.Length = diagnostic.Len()
			finding.Line = line + 1
			finding.Start = diagnostic.Pos()
		}
		findings = append(findings, finding)
	}
	return findings
}

func diagnosticMessage(diagnostic *ast.Diagnostic) string {
	message := diagnostic.String()
	if chain := diagnostic.MessageChain(); len(chain) > 0 {
		parts := []string{message}
		for _, child := range chain {
			parts = append(parts, child.String())
		}
		message = strings.Join(parts, " ")
	}
	return message
}
