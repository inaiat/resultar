package analyzer

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/microsoft/TypeScript/tsc/internal/ast"
	"github.com/microsoft/TypeScript/tsc/internal/checker"
	"github.com/microsoft/TypeScript/tsc/internal/scanner"
	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/config"
)

func (a *Analyzer) promiseContractFindings(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	suppressions := parseSuppressions(file)
	visit(file.AsNode(), func(node *ast.Node) {
		var type_ *checker.Type
		location := node
		if node.Kind == ast.KindTypeReference {
			if node.Parent != nil && node.Parent.Kind == ast.KindTypeReference && isNativePromiseType(a.checker.GetTypeAtLocation(node.Parent)) {
				return
			}
			type_ = a.checker.GetTypeAtLocation(node)
		} else if isFunctionLikeNode(node) && node.Type() == nil {
			if a.parentDeclarationHasExplicitPromiseContract(node) {
				return
			}
			signatures := a.checker.GetCallSignatures(a.checker.GetTypeAtLocation(node))
			if len(signatures) == 0 {
				return
			}
			type_ = a.checker.GetReturnTypeOfSignature(signatures[0])
			if node.Name() != nil {
				location = node.Name()
			} else if node.Parent != nil && (node.Parent.Kind == ast.KindVariableDeclaration || node.Parent.Kind == ast.KindPropertyAssignment || node.Parent.Kind == ast.KindPropertyDeclaration) && node.Parent.Name() != nil {
				location = node.Parent.Name()
			}
		} else {
			return
		}

		start := scanner.SkipTrivia(file.Text(), location.Pos())
		line, _ := scanner.GetECMALineAndUTF16CharacterOfPosition(file, start)
		lineNumber := line + 1

		resultarMatch := a.classifyPromiseResultar(type_, location)
		preferAsyncMatched, preferAsyncMessage := a.matchPreferResultAsync(type_)

		if a.options.NoPromiseResultar != config.SeverityOff && resultarMatch.matched {
			suppressedNoPromise := isSuppressed(suppressions, lineNumber, "no-promise-resultar")
			suppressedPreferAsync := isSuppressed(suppressions, lineNumber, "prefer-result-async")
			bothOverlap := preferAsyncMatched && a.options.PreferResultAsync != config.SeverityOff && !resultarMatch.hasTask && resultarMatch.pureSyncResult
			if bothOverlap && suppressedNoPromise && suppressedPreferAsync {
				findings = append(findings, newFinding(file, location, "no-promise-resultar", a.options.NoPromiseResultar,
					resultarMatch.message,
					a.checker.TypeToStringEx(type_, location, checker.TypeFormatFlagsNoTruncation, nil)))
				findings = append(findings, newFinding(file, location, "prefer-result-async", a.options.PreferResultAsync,
					preferAsyncMessage,
					a.checker.TypeToStringEx(type_, location, checker.TypeFormatFlagsNoTruncation, nil)))
				return
			}
			usePreferAsyncInstead := false
			if bothOverlap {
				if suppressedPreferAsync && !suppressedNoPromise {
					usePreferAsyncInstead = true
				} else if !suppressedNoPromise && config.SeverityRank(a.options.PreferResultAsync) >= config.SeverityRank(a.options.NoPromiseResultar) {
					usePreferAsyncInstead = true
				}
			}
			if !usePreferAsyncInstead {
				findings = append(findings, newFinding(file, location, "no-promise-resultar", a.options.NoPromiseResultar,
					resultarMatch.message,
					a.checker.TypeToStringEx(type_, location, checker.TypeFormatFlagsNoTruncation, nil)))
				return
			}
		}

		if a.options.PreferResultAsync != config.SeverityOff && preferAsyncMatched {
			// Changing an annotation alone cannot turn an async function into ResultAsync.
			// This migration needs the implementation and its rejection boundaries to be reviewed.
			findings = append(findings, newFinding(file, location, "prefer-result-async", a.options.PreferResultAsync,
				preferAsyncMessage,
				a.checker.TypeToStringEx(type_, location, checker.TypeFormatFlagsNoTruncation, nil)))
		}
	})
	return findings
}

func (a *Analyzer) parentDeclarationHasExplicitPromiseContract(node *ast.Node) bool {
	if node.Parent == nil {
		return false
	}
	if node.Parent.Kind != ast.KindVariableDeclaration && node.Parent.Kind != ast.KindPropertyDeclaration {
		return false
	}
	annotation := node.Parent.Type()
	if annotation == nil {
		return false
	}
	found := false
	visit(annotation, func(child *ast.Node) {
		if found || child.Kind != ast.KindTypeReference {
			return
		}
		childType := a.checker.GetTypeAtLocation(child)
		if a.classifyPromiseResultar(childType, child).matched {
			found = true
			return
		}
		if matched, _ := a.matchPreferResultAsync(childType); matched {
			found = true
		}
	})
	return found
}

func (a *Analyzer) matchPreferResultAsync(type_ *checker.Type) (bool, string) {
	if a.options.PreferResultAsyncMode == "all" {
		if !containsNativePromiseType(type_) {
			return false, ""
		}
		return true, "Prefer ResultAsync<T, E> (or StrictResultAsync<T, E>) over native Promise contracts. Remove the async wrapper and map external rejections to typed errors in the adapter. Keep deliberate native framework boundaries explicit with a rule suppression."
	}
	if !isNativePromiseType(type_) {
		return false, ""
	}
	promised := a.checker.GetPromisedTypeOfPromise(type_)
	if !a.isResultarSyncType(promised) {
		return false, ""
	}
	return true, "Prefer ResultAsync<T, E> (or StrictResultAsync<T, E>) over Promise<Result<T, E>>. Remove the async wrapper and compose Resultar values directly, mapping external rejections at their source."
}

type promiseResultarClassification struct {
	matched        bool
	hasTask        bool
	pureSyncResult bool
	message        string
}

type promisedChannelCollector struct {
	hasTask      bool
	hasResult    bool
	plainResult  bool
	strictResult bool
	disposable   bool
	taskSuccess  []string
	taskError    []string
	taskReq      []string
	resSuccess   []string
	resError     []string
	nonResultar  []string
}

func appendUniqueTypeText(slice []string, value string) []string {
	if value == "" {
		return slice
	}
	for _, existing := range slice {
		if existing == value {
			return slice
		}
	}
	return append(slice, value)
}

func mergeChannelTypes(groups ...[]string) []string {
	merged := make([]string, 0)
	for _, group := range groups {
		for _, item := range group {
			merged = appendUniqueTypeText(merged, item)
		}
	}
	return merged
}

func joinChannelTypes(parts []string, fallback string) string {
	if len(parts) == 0 {
		return fallback
	}
	return strings.Join(parts, " | ")
}

func formatResultTaskType(successParts, errorParts, reqParts []string) string {
	successText := joinChannelTypes(successParts, "never")
	errorText := joinChannelTypes(errorParts, "")
	reqText := joinChannelTypes(reqParts, "")
	if reqText != "" {
		if errorText == "" {
			errorText = "never"
		}
		return fmt.Sprintf("ResultTask<%s, %s, %s>", successText, errorText, reqText)
	}
	if errorText != "" {
		return fmt.Sprintf("ResultTask<%s, %s>", successText, errorText)
	}
	return fmt.Sprintf("ResultTask<%s>", successText)
}

func (a *Analyzer) formatTypeNode(type_ *checker.Type, location *ast.Node) string {
	if type_ == nil {
		return ""
	}
	return a.checker.TypeToStringEx(type_, location, checker.TypeFormatFlagsNoTruncation, nil)
}

func (a *Analyzer) classifyPromiseResultar(type_ *checker.Type, location *ast.Node) promiseResultarClassification {
	promises, nonPromiseUnionParts := a.extractPromiseBranches(type_, make(map[*checker.Type]bool))
	if len(promises) == 0 {
		return promiseResultarClassification{}
	}

	collector := &promisedChannelCollector{}
	for _, promiseType := range promises {
		promised := a.checker.GetPromisedTypeOfPromise(promiseType)
		if !a.collectPromisedResultar(promised, location, collector, make(map[*checker.Type]bool)) && promised != nil && promised.Flags()&checker.TypeFlagsNever == 0 {
			collector.nonResultar = appendUniqueTypeText(collector.nonResultar, a.formatTypeNode(promised, location))
		}
	}
	for _, nonPromisePart := range nonPromiseUnionParts {
		collector.nonResultar = appendUniqueTypeText(collector.nonResultar, a.formatTypeNode(nonPromisePart, location))
	}

	if !collector.hasTask && !collector.hasResult {
		return promiseResultarClassification{}
	}

	pureSyncResult := isNativePromiseType(type_) && !collector.hasTask && len(collector.nonResultar) == 0 && a.isResultarSyncType(a.checker.GetPromisedTypeOfPromise(type_))

	if collector.hasTask && collector.hasResult {
		allSuccess := mergeChannelTypes(collector.resSuccess, collector.taskSuccess, collector.nonResultar)
		allErrors := mergeChannelTypes(collector.resError, collector.taskError)
		unifiedErrorParts := allErrors
		if len(unifiedErrorParts) == 0 {
			unifiedErrorParts = []string{"never"}
		}
		unifiedTask := formatResultTaskType(allSuccess, unifiedErrorParts, collector.taskReq)
		if len(collector.taskReq) > 0 {
			return promiseResultarClassification{
				matched: true,
				hasTask: true,
				message: fmt.Sprintf("Do not wrap heterogeneous Result and ResultTask unions in a native Promise; review this contract and unify all branches into %s directly without an async wrapper (lifting synchronous Result branches with ResultTask.fromResult) so every success, error, and requirement channel is preserved.", unifiedTask),
			}
		}
		unifiedAsync := fmt.Sprintf("ResultAsync<%s, %s>", joinChannelTypes(allSuccess, "never"), joinChannelTypes(unifiedErrorParts, "never"))
		return promiseResultarClassification{
			matched: true,
			hasTask: true,
			message: fmt.Sprintf("Do not wrap heterogeneous Result and ResultTask unions in a native Promise; review this contract and unify all branches into %s (or %s for eager boundaries) directly without an async wrapper so every success and error channel is preserved.", unifiedTask, unifiedAsync),
		}
	}

	if collector.hasTask {
		if len(collector.nonResultar) > 0 {
			allSuccess := mergeChannelTypes(collector.taskSuccess, collector.nonResultar)
			replacement := formatResultTaskType(allSuccess, collector.taskError, collector.taskReq)
			return promiseResultarClassification{
				matched: true,
				hasTask: true,
				message: fmt.Sprintf("Do not wrap ResultTask union contracts in a native Promise; review the non-Resultar union branch (%s) and return %s directly without an async wrapper, lifting plain values with ResultTask.ok.", joinChannelTypes(collector.nonResultar, "unknown"), replacement),
			}
		}
		replacement := formatResultTaskType(collector.taskSuccess, collector.taskError, collector.taskReq)
		return promiseResultarClassification{
			matched: true,
			hasTask: true,
			message: fmt.Sprintf("Do not wrap ResultTask in a native Promise; return %s directly without an async wrapper, or compose external Promise work inside ResultTask.tryPromise.", replacement),
		}
	}

	wrapperName := "Result"
	replacementCtor := "ResultAsync"
	if collector.disposable && !collector.plainResult && !collector.strictResult {
		wrapperName = "DisposableResult"
		replacementCtor = "DisposableResultAsync"
	} else if collector.strictResult && !collector.plainResult && !collector.disposable {
		wrapperName = "StrictResult"
		replacementCtor = "StrictResultAsync"
	}

	if len(collector.nonResultar) > 0 {
		allSuccess := mergeChannelTypes(collector.resSuccess, collector.nonResultar)
		errorText := joinChannelTypes(collector.resError, "never")
		replacement := fmt.Sprintf("%s<%s, %s>", replacementCtor, joinChannelTypes(allSuccess, "never"), errorText)
		return promiseResultarClassification{
			matched: true,
			message: fmt.Sprintf("Do not wrap %s union contracts in a native Promise; review the non-Resultar union branch (%s) and return %s directly without an async wrapper, lifting plain values into the success channel.", wrapperName, joinChannelTypes(collector.nonResultar, "unknown"), replacement),
		}
	}

	successText := joinChannelTypes(collector.resSuccess, "never")
	errorText := joinChannelTypes(collector.resError, "never")
	replacement := fmt.Sprintf("%s<%s, %s>", replacementCtor, successText, errorText)
	return promiseResultarClassification{
		matched:        true,
		pureSyncResult: pureSyncResult,
		message:        fmt.Sprintf("Do not wrap %s in a native Promise; return %s directly without an async wrapper, mapping external rejections into the typed error channel.", wrapperName, replacement),
	}
}

func (a *Analyzer) collectPromisedResultar(type_ *checker.Type, location *ast.Node, collector *promisedChannelCollector, visited map[*checker.Type]bool) bool {
	if type_ == nil || visited[type_] {
		return false
	}
	visited[type_] = true
	defer delete(visited, type_)

	if type_.Flags()&checker.TypeFlagsTypeParameter != 0 {
		constraint := a.checker.GetBaseConstraintOfType(type_)
		if constraint == nil {
			return false
		}
		return a.collectPromisedResultar(constraint, location, collector, visited)
	}

	var aliasArgs []*checker.Type
	aliasLibName := ""
	if alias := type_.Alias(); alias != nil && alias.Symbol() != nil {
		if libName, ok := a.resolveResultarAliasKind(alias.Symbol()); ok {
			aliasLibName = libName
			aliasArgs = alias.TypeArguments()
			switch libName {
			case "ResultTask":
				collector.hasTask = true
			case "StrictResult", "StrictResultAsync":
				collector.hasResult = true
				collector.strictResult = true
			case "DisposableResult", "DisposableResultAsync":
				collector.hasResult = true
				collector.disposable = true
			case "Result", "OkResult", "ErrResult", "ResultAsync":
				collector.hasResult = true
				collector.plainResult = true
			}
		}
	}

	prevTaskLen := len(collector.taskSuccess) + len(collector.taskError) + len(collector.taskReq)
	prevResLen := len(collector.resSuccess) + len(collector.resError)
	wasPlainResult := collector.plainResult
	preserveSpecializedAlias := aliasLibName == "StrictResult" || aliasLibName == "StrictResultAsync" || aliasLibName == "DisposableResult" || aliasLibName == "DisposableResultAsync"

	matched := aliasLibName != ""
	if type_.Flags()&checker.TypeFlagsUnion != 0 {
		var unmatchedParts []*checker.Type
		anyPartMatched := false
		for _, part := range type_.Types() {
			if a.collectPromisedResultar(part, location, collector, visited) {
				anyPartMatched = true
			} else if aliasLibName == "" && part != nil && part.Flags()&checker.TypeFlagsNever == 0 {
				unmatchedParts = append(unmatchedParts, part)
			}
		}
		if anyPartMatched {
			matched = true
			for _, unmatched := range unmatchedParts {
				collector.nonResultar = appendUniqueTypeText(collector.nonResultar, a.formatTypeNode(unmatched, location))
			}
		}
	} else if type_.Flags()&checker.TypeFlagsIntersection != 0 {
		for _, part := range type_.Types() {
			if a.collectPromisedResultar(part, location, collector, visited) {
				matched = true
			}
		}
	} else if libName, ok := a.resolveResultarObjectKind(type_); ok {
		matched = true
		args := typeArguments(a.checker, type_)
		switch libName {
		case "ResultTask":
			collector.hasTask = true
			a.recordTaskArgs(args, location, collector)
		case "StrictResult", "StrictResultAsync":
			collector.hasResult = true
			collector.strictResult = true
			a.recordResultArgs(args, location, collector)
		case "DisposableResult", "DisposableResultAsync":
			collector.hasResult = true
			collector.disposable = true
			a.recordResultArgs(args, location, collector)
		case "Result", "OkResult", "ErrResult", "ResultAsync":
			collector.hasResult = true
			collector.plainResult = true
			a.recordResultArgs(args, location, collector)
		}
	}

	if preserveSpecializedAlias {
		collector.plainResult = wasPlainResult
	}

	if aliasLibName != "" {
		nowTaskLen := len(collector.taskSuccess) + len(collector.taskError) + len(collector.taskReq)
		nowResLen := len(collector.resSuccess) + len(collector.resError)
		if collector.hasTask && nowTaskLen == prevTaskLen {
			a.recordTaskArgs(aliasArgs, location, collector)
		} else if collector.hasResult && nowResLen == prevResLen {
			a.recordResultArgs(aliasArgs, location, collector)
		}
	}

	return matched
}

func (a *Analyzer) recordTaskArgs(args []*checker.Type, location *ast.Node, collector *promisedChannelCollector) {
	if len(args) > 0 && args[0] != nil && args[0].Flags()&checker.TypeFlagsNever == 0 {
		collector.taskSuccess = appendUniqueTypeText(collector.taskSuccess, a.formatTypeNode(args[0], location))
	}
	if len(args) > 1 && args[1] != nil && args[1].Flags()&checker.TypeFlagsNever == 0 {
		collector.taskError = appendUniqueTypeText(collector.taskError, a.formatTypeNode(args[1], location))
	}
	if len(args) > 2 && args[2] != nil && args[2].Flags()&checker.TypeFlagsNever == 0 {
		collector.taskReq = appendUniqueTypeText(collector.taskReq, a.formatTypeNode(args[2], location))
	}
}

func (a *Analyzer) recordResultArgs(args []*checker.Type, location *ast.Node, collector *promisedChannelCollector) {
	if len(args) > 0 && args[0] != nil && args[0].Flags()&checker.TypeFlagsNever == 0 {
		collector.resSuccess = appendUniqueTypeText(collector.resSuccess, a.formatTypeNode(args[0], location))
	}
	if len(args) > 1 && args[1] != nil && args[1].Flags()&checker.TypeFlagsNever == 0 {
		collector.resError = appendUniqueTypeText(collector.resError, a.formatTypeNode(args[1], location))
	}
}

func (a *Analyzer) resolveResultarAliasKind(symbol *ast.Symbol) (string, bool) {
	current := symbol
	for depth := 0; current != nil && depth < 8; depth++ {
		if name, ok := isResultarLibrarySymbol(a.checker, current); ok {
			return name, true
		}
		var next *ast.Symbol
		for _, declaration := range current.Declarations() {
			if declaration.Kind == ast.KindTypeAliasDeclaration && declaration.Type() != nil && declaration.Type().Kind == ast.KindTypeReference {
				next = a.checker.GetSymbolAtLocation(declaration.Type().AsTypeReferenceNode().TypeName)
				break
			}
		}
		if next == nil || next == current {
			break
		}
		current = next
	}
	return "", false
}

func (a *Analyzer) resolveResultarObjectKind(type_ *checker.Type) (string, bool) {
	symbols := []*ast.Symbol{type_.Symbol()}
	if type_.Flags()&checker.TypeFlagsObject != 0 && type_.ObjectFlags()&checker.ObjectFlagsReference != 0 && type_.Target() != nil {
		symbols = append(symbols, type_.Target().Symbol())
	}
	for _, symbol := range symbols {
		if name, ok := isResultarLibrarySymbol(a.checker, symbol); ok {
			return name, true
		}
	}
	return "", false
}

func isResultarLibrarySymbol(checker_ *checker.Checker, symbol *ast.Symbol) (string, bool) {
	visited := 0
	for current := symbol; current != nil && visited < 8; visited++ {
		for _, declaration := range current.Declarations() {
			file := ast.GetSourceFileOfNode(declaration)
			if file == nil {
				continue
			}
			path := filepath.ToSlash(string(file.FileName()))
			if strings.Contains(path, "/node_modules/resultar/") || strings.Contains(path, "/packages/resultar/") {
				return current.Name(), true
			}
		}
		if checker_ != nil && current.Flags()&ast.SymbolFlagsAlias != 0 {
			aliased := checker_.GetAliasedSymbol(current)
			if aliased != nil && aliased != current {
				current = aliased
				continue
			}
		}
		break
	}
	return "", false
}

func (a *Analyzer) extractPromiseBranches(type_ *checker.Type, visited map[*checker.Type]bool) (promises []*checker.Type, nonPromiseUnionParts []*checker.Type) {
	if type_ == nil || visited[type_] {
		return nil, nil
	}
	visited[type_] = true
	defer delete(visited, type_)

	if type_.Flags()&checker.TypeFlagsUnion != 0 {
		for _, part := range type_.Types() {
			partPromises, partOther := a.extractPromiseBranches(part, visited)
			if len(partPromises) > 0 {
				promises = append(promises, partPromises...)
				nonPromiseUnionParts = append(nonPromiseUnionParts, partOther...)
			} else if part != nil && part.Flags()&checker.TypeFlagsNever == 0 {
				nonPromiseUnionParts = append(nonPromiseUnionParts, part)
			}
		}
		return promises, nonPromiseUnionParts
	}
	if type_.Flags()&checker.TypeFlagsIntersection != 0 {
		for _, part := range type_.Types() {
			partPromises, _ := a.extractPromiseBranches(part, visited)
			promises = append(promises, partPromises...)
		}
		return promises, nil
	}
	if isNativePromiseType(type_) {
		return []*checker.Type{type_}, nil
	}
	return nil, nil
}

func extractNativePromiseTypes(type_ *checker.Type) []*checker.Type {
	if type_ == nil {
		return nil
	}
	if type_.Flags()&(checker.TypeFlagsUnion|checker.TypeFlagsIntersection) != 0 {
		result := make([]*checker.Type, 0)
		for _, part := range type_.Types() {
			result = append(result, extractNativePromiseTypes(part)...)
		}
		return result
	}
	if isNativePromiseType(type_) {
		return []*checker.Type{type_}
	}
	return nil
}

func containsNativePromiseType(type_ *checker.Type) bool {
	return len(extractNativePromiseTypes(type_)) > 0
}

func isNativePromiseType(type_ *checker.Type) bool {
	if type_ == nil || type_.Flags()&checker.TypeFlagsObject == 0 || type_.ObjectFlags()&checker.ObjectFlagsReference == 0 {
		return false
	}
	target := type_.Target()
	if target == nil || target.Symbol() == nil || target.Symbol().Name() != "Promise" {
		return false
	}
	for _, declaration := range target.Symbol().Declarations() {
		file := ast.GetSourceFileOfNode(declaration)
		if file != nil && strings.HasPrefix(filepath.Base(string(file.FileName())), "lib.") && file.IsDeclarationFile {
			return true
		}
	}
	return false
}

func (a *Analyzer) isResultarSyncType(type_ *checker.Type) bool {
	return a.isResultarSyncTypeVisited(type_, make(map[*checker.Type]bool))
}

func (a *Analyzer) isResultarSyncTypeVisited(type_ *checker.Type, visited map[*checker.Type]bool) bool {
	if type_ == nil || visited[type_] {
		return false
	}
	visited[type_] = true
	defer delete(visited, type_)

	if type_.Flags()&checker.TypeFlagsTypeParameter != 0 {
		constraint := a.checker.GetBaseConstraintOfType(type_)
		if constraint == nil {
			return false
		}
		return a.isResultarSyncTypeVisited(constraint, visited)
	}
	if type_.Flags()&checker.TypeFlagsUnion != 0 {
		parts := type_.Types()
		if len(parts) == 0 {
			return false
		}
		for _, part := range parts {
			if !a.isResultarSyncTypeVisited(part, visited) {
				return false
			}
		}
		return true
	}
	if type_.Flags()&checker.TypeFlagsIntersection != 0 {
		for _, part := range type_.Types() {
			if a.isResultarSyncTypeVisited(part, visited) {
				return true
			}
		}
		return false
	}
	symbols := []*ast.Symbol{type_.Symbol()}
	if alias := type_.Alias(); alias != nil {
		symbols = append(symbols, alias.Symbol())
	}
	if type_.Flags()&checker.TypeFlagsObject != 0 && type_.ObjectFlags()&checker.ObjectFlagsReference != 0 && type_.Target() != nil {
		symbols = append(symbols, type_.Target().Symbol())
	}
	for _, symbol := range symbols {
		if symbol == nil || (symbol.Name() != "Result" && symbol.Name() != "StrictResult" && symbol.Name() != "OkResult" && symbol.Name() != "ErrResult" && symbol.Name() != "DisposableResult") {
			continue
		}
		for _, declaration := range symbol.Declarations() {
			file := ast.GetSourceFileOfNode(declaration)
			if file == nil {
				continue
			}
			path := filepath.ToSlash(string(file.FileName()))
			if strings.Contains(path, "/node_modules/resultar/") || strings.Contains(path, "/packages/resultar/") {
				return true
			}
		}
	}
	return false
}
