package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/microsoft/typescript-go/resultar-check/internal/analyzer"
	"github.com/microsoft/typescript-go/resultar-check/internal/config"
	"github.com/microsoft/typescript-go/resultar-check/internal/output"
	"github.com/microsoft/typescript-go/resultar-check/internal/project"
)

func matchesFile(path, filter, directory string) bool {
	if filter == "" {
		return true
	}
	if !filepath.IsAbs(filter) {
		filter = filepath.Join(directory, filter)
	}
	return filepath.Clean(path) == filepath.Clean(filter)
}
func printOverview(ctx context.Context, opened *project.Opened, options config.Options, filter string, format output.Format) int {
	overview, err := analyzer.BuildOverview(ctx, opened.Program, opened.Directory, options)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	entries := make([]analyzer.OverviewEntry, 0, len(overview.Entries))
	for _, entry := range overview.Entries {
		if matchesFile(entry.Declaration.File, filter, opened.Directory) || matchesFile(entry.ExportedFrom, filter, opened.Directory) {
			entries = append(entries, entry)
		}
	}
	overview.Entries = entries
	if format == output.FormatJSON {
		if err := json.NewEncoder(os.Stdout).Encode(overview); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return 0
	}
	for _, entry := range entries {
		fmt.Fprintf(os.Stdout, "%s %s (%s:%d:%d; exported from %s)\n", entry.Kind, entry.Name, entry.Declaration.File, entry.Declaration.Line, entry.Declaration.Column, entry.ExportedFrom)
		if entry.Channels.Success != "" {
			fmt.Fprintf(os.Stdout, "  T: %s\n  E: %s\n", entry.Channels.Success, entry.Channels.Error)
		}
		if entry.Channels.Requirements != "" {
			fmt.Fprintf(os.Stdout, "  R: %s\n", entry.Channels.Requirements)
		}
		if entry.Identifier != "" {
			fmt.Fprintf(os.Stdout, "  identifier: %s\n  contract: %s\n", entry.Identifier, entry.Contract)
		}
		if entry.Tag != "" {
			fmt.Fprintf(os.Stdout, "  tag: %s\n", entry.Tag)
		}
	}
	return 0
}
func printQuickfixes(opened *project.Opened, findings []analyzer.Finding, filter string, format output.Format) int {
	selected := []output.Diagnostic{}
	for _, finding := range findings {
		if len(finding.Fixes) == 0 || !matchesFile(finding.File, filter, opened.Directory) {
			continue
		}
		selected = append(selected, output.FromFinding(finding))
	}
	if format == output.FormatJSON {
		if err := output.Write(os.Stdout, selected, format, opened.Directory); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return 0
	}
	for _, finding := range selected {
		for _, fix := range finding.Fixes {
			fmt.Fprintf(os.Stdout, "%s:%d:%d %s [%s]\n", finding.File, finding.Line, finding.Column, fix.Title, fix.Kind)
			if fix.Description != "" {
				fmt.Fprintln(os.Stdout, fix.Description)
			}
			for _, file := range opened.Program.SourceFiles() {
				if filepath.Clean(file.FileName()) != filepath.Clean(finding.File) {
					continue
				}
				for _, edit := range fix.Edits {
					if edit.Start < 0 || edit.Start+edit.Length > len(file.Text()) {
						continue
					}
					fmt.Fprintf(os.Stdout, "- %s\n+ %s\n", file.Text()[edit.Start:edit.Start+edit.Length], edit.NewText)
				}
			}
		}
	}
	return 0
}
