package analyzer

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/checker"
	"github.com/microsoft/typescript-go/internal/compiler"
	"github.com/microsoft/typescript-go/resultar-check/internal/config"
)

type Analyzer struct {
	checker    *checker.Checker
	options    config.Options
	projectDir string
}

func Run(ctx context.Context, program *compiler.Program, projectDir string, options config.Options) ([]Finding, error) {
	checker_, done := program.GetTypeChecker(ctx)
	defer done()
	if checker_ == nil {
		return nil, fmt.Errorf("unable to acquire TypeScript checker")
	}
	analyzer := Analyzer{checker: checker_, options: options, projectDir: projectDir}
	findings := make([]Finding, 0)
	for _, file := range program.SourceFiles() {
		if options.ShouldInspect(file.FileName(), projectDir) {
			fileAnalyzer := analyzer
			fileAnalyzer.options = options.ForFile(file.FileName(), projectDir)
			findings = append(findings, filterSuppressed(file, fileAnalyzer.analyzeFile(file))...)
		}
	}
	sort.SliceStable(findings, func(left, right int) bool {
		if findings[left].File != findings[right].File {
			return filepath.ToSlash(findings[left].File) < filepath.ToSlash(findings[right].File)
		}
		if findings[left].Start != findings[right].Start {
			return findings[left].Start < findings[right].Start
		}
		return findings[left].Rule < findings[right].Rule
	})
	return findings, nil
}

func (a *Analyzer) analyzeFile(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	if a.options.NoDiscard != config.SeverityOff {
		findings = append(findings, a.noDiscard(file)...)
	}
	if a.options.NoPromiseInResultSuccess != config.SeverityOff {
		findings = append(findings, a.noPromiseInResultSuccess(file)...)
	}
	if a.options.NoUnknownResultError != config.SeverityOff {
		findings = append(findings, a.noUnknownResultError(file)...)
	}
	if a.options.PreferMapErr != config.SeverityOff {
		findings = append(findings, a.preferMapErr(file)...)
	}
	if a.options.PreferAndThen != config.SeverityOff {
		findings = append(findings, a.preferAndThen(file)...)
	}
	if a.options.TypedCatchMapper != config.SeverityOff {
		findings = append(findings, a.typedCatchMapper(file)...)
	}
	if a.options.PreferMap != config.SeverityOff {
		findings = append(findings, a.preferMap(file)...)
	}
	if a.options.PreferFirstSuccessOf != config.SeverityOff {
		findings = append(findings, a.preferFirstSuccessOf(file)...)
	}
	if a.options.PreferResultForEach != config.SeverityOff {
		findings = append(findings, a.preferResultForEach(file)...)
	}
	if a.options.PreferCatchReason != config.SeverityOff {
		findings = append(findings, a.preferCatchReason(file)...)
	}
	if a.options.NoThrow != config.SeverityOff {
		findings = append(findings, a.noThrow(file)...)
	}
	if a.options.NoTryCatch != config.SeverityOff {
		findings = append(findings, a.noTryCatch(file)...)
	}
	if a.options.YieldStarInSafeTry != config.SeverityOff {
		findings = append(findings, a.yieldStarInSafeTry(file)...)
	}
	if a.options.YieldStarInResultTaskGen != config.SeverityOff {
		findings = append(findings, a.yieldStarInResultTaskGen(file)...)
	}
	if a.options.NoAwaitInSafeTry != config.SeverityOff {
		findings = append(findings, a.noAwaitInSafeTry(file)...)
	}
	if a.options.NoTryCatchInSafeTry != config.SeverityOff {
		findings = append(findings, a.noTryCatchInSafeTry(file)...)
	}
	if a.options.PreferTaggedError != config.SeverityOff {
		findings = append(findings, a.preferTaggedError(file)...)
	}
	if a.options.TaggedErrorNameMatch != config.SeverityOff {
		findings = append(findings, a.taggedErrorNameMatch(file)...)
	}
	if a.options.NoTaggedErrorConstructorOverride != config.SeverityOff {
		findings = append(findings, a.noTaggedErrorConstructorOverride(file)...)
	}
	if a.options.NoUselessRecovery != config.SeverityOff {
		findings = append(findings, a.noUselessRecovery(file)...)
	}
	if a.options.UnsafeResultTypeAssertion != config.SeverityOff {
		findings = append(findings, a.unsafeResultTypeAssertion(file)...)
	}
	if a.options.NoUnsafeAwait != config.SeverityOff {
		findings = append(findings, a.noUnsafeAwait(file)...)
	}
	return findings
}

func visit(root *ast.Node, visitor func(*ast.Node)) {
	visitor(root)
	root.ForEachChild(func(child *ast.Node) bool {
		visit(child, visitor)
		return false
	})
}
