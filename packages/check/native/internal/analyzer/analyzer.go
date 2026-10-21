package analyzer

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"

	"github.com/microsoft/TypeScript/tsc/internal/ast"
	"github.com/microsoft/TypeScript/tsc/internal/checker"
	"github.com/microsoft/TypeScript/tsc/internal/compiler"
	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/config"
)

type Analyzer struct {
	program    *compiler.Program
	checker    *checker.Checker
	options    config.Options
	projectDir string
	cache      *analyzerCache
}

func Run(ctx context.Context, program *compiler.Program, projectDir string, options config.Options) ([]Finding, error) {
	checker_, done := program.GetTypeChecker(ctx)
	defer done()
	if checker_ == nil {
		return nil, fmt.Errorf("unable to acquire TypeScript checker")
	}
	analyzer := Analyzer{program: program, checker: checker_, options: options, projectDir: projectDir, cache: newAnalyzerCache()}
	findings := make([]Finding, 0)
	for _, file := range program.SourceFiles() {
		fileName := string(file.FileName())
		if options.ShouldInspect(fileName, projectDir) {
			fileAnalyzer := analyzer
			fileAnalyzer.options = options.ForFile(fileName, projectDir)
			findings = append(findings, fileAnalyzer.applySuppressions(file, fileAnalyzer.analyzeFile(file))...)
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
	if a.options.NoUnknownTaskRequirements != config.SeverityOff {
		findings = append(findings, a.noUnknownTaskRequirements(file)...)
	}
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
	if a.options.PreferResultAsync != config.SeverityOff {
		findings = append(findings, a.preferResultAsync(file)...)
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
	if a.options.NoInvalidLifetime != config.SeverityOff {
		findings = append(findings, a.noInvalidLifetime(file)...)
	}
	if a.options.NoUnscopedAcquireRelease != config.SeverityOff {
		findings = append(findings, a.noUnscopedAcquireRelease(file)...)
	}
	if a.options.NoResultInTaskGen != config.SeverityOff {
		findings = append(findings, a.noResultInTaskGen(file)...)
	}
	if a.options.NoAwaitInResultTaskGen != config.SeverityOff {
		findings = append(findings, a.noAwaitInResultTaskGen(file)...)
	}
	if a.options.NoThrowInTaskSync != config.SeverityOff {
		findings = append(findings, a.noThrowInTaskSync(file)...)
	}
	if a.options.PreferOrElseSucceed != config.SeverityOff {
		findings = append(findings, a.preferOrElseSucceed(file)...)
	}
	if a.options.PreferTap != config.SeverityOff {
		findings = append(findings, a.preferTap(file)...)
	}
	if a.options.PreferTapError != config.SeverityOff {
		findings = append(findings, a.preferTapError(file)...)
	}
	if a.options.PreferAsVoid != config.SeverityOff {
		findings = append(findings, a.preferAsVoid(file)...)
	}
	if a.options.PreferFilterOrElse != config.SeverityOff {
		findings = append(findings, a.preferFilterOrElse(file)...)
	}
	if a.options.PreferAcquireDisposable != config.SeverityOff {
		findings = append(findings, a.preferAcquireDisposable(file)...)
	}
	if a.options.NoFnIife != config.SeverityOff {
		findings = append(findings, a.noFnIife(file)...)
	}
	if a.options.RequireReturnYieldStar != config.SeverityOff {
		findings = append(findings, a.requireReturnYieldStar(file)...)
	}
	if a.options.NoUnnecessaryErrWrapInGen != config.SeverityOff {
		findings = append(findings, a.noUnnecessaryErrWrapInGen(file)...)
	}
	if a.options.UnnecessaryPipe != config.SeverityOff {
		findings = append(findings, a.unnecessaryPipe(file)...)
	}
	if a.options.NoRunInsideGen != config.SeverityOff {
		findings = append(findings, a.noRunInsideGen(file)...)
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
