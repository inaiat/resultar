package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/microsoft/TypeScript/tsc/internal/ast"
	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/analyzer"
)

const maxFixPasses = 5

type fileFixResult struct {
	File         string
	AppliedFixes int
	SkippedFixes int
}

type fixSummary struct {
	TotalFixes   int
	SkippedFixes int
	Files        []fileFixResult
}

type candidateFix struct {
	minStart int
	maxEnd   int
	edits    []analyzer.TextEdit
}

func (s *fixSummary) merge(pass fixSummary) {
	s.TotalFixes += pass.TotalFixes
	s.SkippedFixes += pass.SkippedFixes
	byFile := make(map[string]int, len(s.Files))
	for index, entry := range s.Files {
		byFile[entry.File] = index
	}
	for _, entry := range pass.Files {
		if index, ok := byFile[entry.File]; ok {
			s.Files[index].AppliedFixes += entry.AppliedFixes
			s.Files[index].SkippedFixes += entry.SkippedFixes
			continue
		}
		byFile[entry.File] = len(s.Files)
		s.Files = append(s.Files, entry)
	}
	sort.Slice(s.Files, func(i, j int) bool {
		return s.Files[i].File < s.Files[j].File
	})
}

func editsConflict(left, right analyzer.TextEdit) bool {
	leftEnd := left.Start + left.Length
	rightEnd := right.Start + right.Length
	if left.Length == 0 && right.Length == 0 {
		return left.Start == right.Start
	}
	if left.Length == 0 {
		return right.Start <= left.Start && left.Start < rightEnd
	}
	if right.Length == 0 {
		return left.Start <= right.Start && right.Start < leftEnd
	}
	return left.Start < rightEnd && right.Start < leftEnd
}

func editsValidAndDisjoint(edits []analyzer.TextEdit, textLen int) (int, int, bool) {
	if len(edits) == 0 {
		return 0, 0, false
	}
	minStart := edits[0].Start
	maxEnd := edits[0].Start + edits[0].Length
	for i, edit := range edits {
		if edit.Start < 0 || edit.Length < 0 || edit.Start+edit.Length > textLen {
			return 0, 0, false
		}
		if edit.Start < minStart {
			minStart = edit.Start
		}
		if end := edit.Start + edit.Length; end > maxEnd {
			maxEnd = end
		}
		for j := i + 1; j < len(edits); j++ {
			if editsConflict(edit, edits[j]) {
				return 0, 0, false
			}
		}
	}
	return minStart, maxEnd, true
}

func firstCorrectionFix(finding analyzer.Finding) (analyzer.Fix, bool) {
	for _, fix := range finding.Fixes {
		// Only apply safe semantic corrections; never auto-apply intentional-discard (`void ...`).
		if fix.Kind == analyzer.FixCorrection && len(fix.Edits) > 0 {
			return fix, true
		}
	}
	return analyzer.Fix{}, false
}

func applyEditsToText(source string, edits []analyzer.TextEdit) string {
	ordered := append([]analyzer.TextEdit(nil), edits...)
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].Start != ordered[j].Start {
			return ordered[i].Start > ordered[j].Start
		}
		return ordered[i].Length > ordered[j].Length
	})
	updated := source
	for _, edit := range ordered {
		updated = updated[:edit.Start] + edit.NewText + updated[edit.Start+edit.Length:]
	}
	return updated
}

func applyCorrectionFixes(
	files []*ast.SourceFile,
	findings []analyzer.Finding,
	fileFilter string,
	projectDir string,
	dryRun bool,
) (fixSummary, error) {
	sourceByFile := make(map[string]string, len(files))
	for _, file := range files {
		sourceByFile[filepath.Clean(string(file.FileName()))] = file.Text()
	}

	candidatesByFile := make(map[string][]candidateFix)
	for _, finding := range findings {
		if !matchesFile(finding.File, fileFilter, projectDir) {
			continue
		}
		fix, ok := firstCorrectionFix(finding)
		if !ok {
			continue
		}
		cleanPath := filepath.Clean(finding.File)
		source, exists := sourceByFile[cleanPath]
		if !exists {
			continue
		}
		minStart, maxEnd, valid := editsValidAndDisjoint(fix.Edits, len(source))
		if !valid {
			continue
		}
		candidatesByFile[cleanPath] = append(candidatesByFile[cleanPath], candidateFix{
			minStart: minStart,
			maxEnd:   maxEnd,
			edits:    fix.Edits,
		})
	}

	paths := make([]string, 0, len(candidatesByFile))
	for path := range candidatesByFile {
		paths = append(paths, path)
	}
	sort.Strings(paths)

	summary := fixSummary{}
	for _, path := range paths {
		candidates := candidatesByFile[path]
		sort.Slice(candidates, func(i, j int) bool {
			if candidates[i].minStart != candidates[j].minStart {
				return candidates[i].minStart < candidates[j].minStart
			}
			return candidates[i].maxEnd < candidates[j].maxEnd
		})

		acceptedEdits := make([]analyzer.TextEdit, 0, len(candidates))
		appliedCount := 0
		skippedCount := 0
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
				skippedCount++
				continue
			}
			acceptedEdits = append(acceptedEdits, candidate.edits...)
			appliedCount++
		}

		if appliedCount == 0 {
			continue
		}
		source := sourceByFile[path]
		updated := applyEditsToText(source, acceptedEdits)
		if updated == source {
			continue
		}

		if !dryRun {
			mode := os.FileMode(0o644)
			if info, err := os.Stat(path); err == nil {
				mode = info.Mode()
			}
			if err := os.WriteFile(path, []byte(updated), mode); err != nil {
				return summary, fmt.Errorf("write fixed file %s: %w", path, err)
			}
		}

		summary.TotalFixes += appliedCount
		summary.SkippedFixes += skippedCount
		summary.Files = append(summary.Files, fileFixResult{
			File:         path,
			AppliedFixes: appliedCount,
			SkippedFixes: skippedCount,
		})
	}
	return summary, nil
}

func printFixSummary(summary fixSummary, cwd string, dryRun bool) {
	if summary.TotalFixes == 0 {
		if dryRun {
			fmt.Fprintln(os.Stderr, "resultar-check: no safe correction fixes available (dry run)")
		} else {
			fmt.Fprintln(os.Stderr, "resultar-check: no safe correction fixes applied")
		}
		return
	}

	verb := "applied"
	suffix := ""
	if dryRun {
		verb = "would apply"
		suffix = " (dry run)"
	}
	fmt.Fprintf(
		os.Stderr,
		"resultar-check: %s %d safe %s across %d %s%s\n",
		verb,
		summary.TotalFixes,
		pluralize(summary.TotalFixes, "fix", "fixes"),
		len(summary.Files),
		pluralize(len(summary.Files), "file", "files"),
		suffix,
	)
	for _, entry := range summary.Files {
		displayPath := entry.File
		if relative, err := filepath.Rel(cwd, entry.File); err == nil {
			displayPath = relative
		}
		fmt.Fprintf(
			os.Stderr,
			"  %s (%d %s)\n",
			filepath.ToSlash(displayPath),
			entry.AppliedFixes,
			pluralize(entry.AppliedFixes, "fix", "fixes"),
		)
	}
}

func pluralize(count int, singular, plural string) string {
	if count == 1 {
		return singular
	}
	return plural
}
