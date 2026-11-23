package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/analyzer"
	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/config"
	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/project"
)

const migrateV5Usage = `Usage: resultar-check migrate-v5 [flags]

Preview or apply mechanical v4 -> v5 migration edits and list calls that need review.

Flags:
  --fix                     Apply non-overlapping mechanical edits in place.
  --file <path>             Filter migration output and edits to matching source file(s).
  -p, --project <path>      TypeScript project. Defaults to tsconfig.json.
  --format <human|json>     Output format (default: human).
  --json                    Alias for --format json (JSON lines).
  -h, --help                Show this help.
`

func runMigrateV5(args []string) int {
	flags := flag.NewFlagSet("migrate-v5", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	var projectPath string
	var fileFilter string
	var fixMode bool
	var jsonOutput bool
	var formatName string
	var help bool
	flags.StringVar(&projectPath, "project", "tsconfig.json", "TypeScript project")
	flags.StringVar(&projectPath, "p", "tsconfig.json", "TypeScript project")
	flags.StringVar(&fileFilter, "file", "", "filter by source file")
	flags.BoolVar(&fixMode, "fix", false, "apply mechanical migration edits in place")
	flags.BoolVar(&jsonOutput, "json", false, "emit JSON lines")
	flags.StringVar(&formatName, "format", "human", "output format (human or json)")
	flags.BoolVar(&help, "help", false, "show help")
	flags.BoolVar(&help, "h", false, "show help")
	if err := flags.Parse(args); err != nil {
		return 1
	}
	if help {
		fmt.Print(migrateV5Usage)
		return 0
	}
	if flags.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "Unknown argument: %s\n", flags.Arg(0))
		return 1
	}
	if jsonOutput {
		formatName = "json"
	}
	if formatName != "human" && formatName != "json" {
		fmt.Fprintf(os.Stderr, "migrate-v5 supports human or json output, got %q.\n", formatName)
		return 1
	}

	ctx := context.Background()
	overlay := make(map[string]string)
	seenStates := make(map[[sha256.Size]byte]bool)
	var items []analyzer.MigrationItem
	seenReviews := map[[4]string]bool{}
	for pass := 0; ; pass++ {
		opened, diagnostics, err := project.OpenWithOverlay(projectPath, overlay)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		if len(diagnostics) > 0 {
			printHumanDiagnostics(tsDiagnostics(diagnostics))
			return 1
		}
		if syntax := collectSyntacticDiagnostics(ctx, opened.Program, opened.Program.SourceFiles()); len(syntax) > 0 {
			printHumanDiagnostics(syntax)
			return 1
		}
		options, err := config.Load(opened.ConfigPath)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		raw, err := analyzer.MigrateV5(ctx, opened.Program, opened.Directory, options)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		var batch []analyzer.MigrationItem
		for _, item := range raw {
			if matchesFile(item.File, fileFilter, opened.Directory) {
				batch = append(batch, item)
			}
		}
		stageMigrationEdits(opened, batch, overlay)
		changed := false
		for _, item := range batch {
			if item.Kind == analyzer.MigrationReview {
				key := [4]string{item.File, item.Category, item.Original, item.Reason}
				if pass == 0 || !seenReviews[key] {
					items = append(items, item)
					seenReviews[key] = true
				}
			}
			if item.Applied {
				changed = true
				item.Applied = fixMode
				items = append(items, item)
			}
		}
		if !changed {
			break
		}
		// JSON orders map keys, so equivalent overlays have the same fingerprint.
		contents, err := json.Marshal(overlay)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		state := sha256.Sum256(contents)
		if seenStates[state] {
			fmt.Fprintln(os.Stderr, "Migration did not converge: repeated source state.")
			return 1
		}
		seenStates[state] = true
	}
	if fixMode {
		for path, contents := range overlay {
			if err := os.WriteFile(path, []byte(contents), 0644); err != nil {
				fmt.Fprintln(os.Stderr, err)
				return 1
			}
		}
	}

	cwd := mustGetwd()
	if formatName == "json" {
		encoder := json.NewEncoder(os.Stdout)
		for _, item := range items {
			out := item
			if relative, relErr := filepath.Rel(cwd, out.File); relErr == nil {
				out.File = filepath.ToSlash(relative)
			}
			if err := encoder.Encode(out); err != nil {
				fmt.Fprintln(os.Stderr, err)
				return 1
			}
		}
		return 0
	}

	printHumanMigrationReport(items, cwd, fixMode)
	return 0
}

func stageMigrationEdits(opened *project.Opened, items []analyzer.MigrationItem, overlay map[string]string) {
	sourceByFile := make(map[string]string, len(opened.Program.SourceFiles()))
	for _, file := range opened.Program.SourceFiles() {
		sourceByFile[filepath.Clean(string(file.FileName()))] = file.Text()
	}

	type indexedCandidate struct {
		itemIndex int
		minStart  int
		maxEnd    int
		edits     []analyzer.TextEdit
	}
	byFile := make(map[string][]indexedCandidate)
	for i := range items {
		if items[i].Kind != analyzer.MigrationEdit || len(items[i].Edits) == 0 {
			continue
		}
		cleanPath := filepath.Clean(items[i].File)
		source, ok := sourceByFile[cleanPath]
		if !ok {
			continue
		}
		minStart, maxEnd, valid := editsValidAndDisjoint(items[i].Edits, len(source))
		if !valid {
			continue
		}
		byFile[cleanPath] = append(byFile[cleanPath], indexedCandidate{
			itemIndex: i,
			minStart:  minStart,
			maxEnd:    maxEnd,
			edits:     items[i].Edits,
		})
	}

	paths := make([]string, 0, len(byFile))
	for path := range byFile {
		paths = append(paths, path)
	}
	sort.Strings(paths)

	for _, path := range paths {
		candidates := byFile[path]
		sort.SliceStable(candidates, func(i, j int) bool {
			if candidates[i].minStart != candidates[j].minStart {
				return candidates[i].minStart < candidates[j].minStart
			}
			return candidates[i].maxEnd < candidates[j].maxEnd
		})

		acceptedEdits := make([]analyzer.TextEdit, 0, len(candidates))
		acceptedIndices := make([]int, 0, len(candidates))
		for _, candidate := range candidates {
			conflicts := false
			for _, edit := range candidate.edits {
				for _, accepted := range acceptedEdits {
					if editsConflict(edit, accepted) {
						conflicts = true
						break
					}
				}
				if conflicts {
					break
				}
			}
			if conflicts {
				continue
			}
			acceptedEdits = append(acceptedEdits, candidate.edits...)
			acceptedIndices = append(acceptedIndices, candidate.itemIndex)
		}
		if len(acceptedEdits) == 0 {
			continue
		}
		source := sourceByFile[path]
		updated := applyEditsToText(source, acceptedEdits)
		if updated == source {
			continue
		}
		overlay[path] = updated
		for _, idx := range acceptedIndices {
			items[idx].Applied = true
		}
	}
}

func printHumanMigrationReport(items []analyzer.MigrationItem, cwd string, fixMode bool) {
	editCount := 0
	appliedCount := 0
	reviewCount := 0
	for _, item := range items {
		displayPath := item.File
		if relative, err := filepath.Rel(cwd, item.File); err == nil {
			displayPath = relative
		}
		displayPath = filepath.ToSlash(displayPath)
		if item.Kind == analyzer.MigrationEdit {
			editCount++
			tag := "edit"
			if item.Applied {
				appliedCount++
				tag = "applied"
			}
			fmt.Fprintf(os.Stdout, "%s:%d:%d [%s] %s: %s -> %s (%s)\n",
				displayPath, item.Line, item.Column, tag, item.Category, item.Original, item.Replacement, item.Reason)
		} else {
			reviewCount++
			fmt.Fprintf(os.Stdout, "%s:%d:%d [review] %s: %s — %s\n",
				displayPath, item.Line, item.Column, item.Category, item.Original, item.Reason)
		}
	}
	if fixMode {
		fmt.Fprintf(os.Stderr, "resultar-check migrate-v5: applied %d of %d mechanical %s; %d manual review %s.\n",
			appliedCount, editCount, pluralize(editCount, "edit", "edits"), reviewCount, pluralize(reviewCount, "item", "items"))
	} else {
		fmt.Fprintf(os.Stderr, "resultar-check migrate-v5 (preview): %d mechanical %s; %d manual review %s. Re-run with --fix to apply.\n",
			editCount, pluralize(editCount, "edit", "edits"), reviewCount, pluralize(reviewCount, "item", "items"))
	}
}
