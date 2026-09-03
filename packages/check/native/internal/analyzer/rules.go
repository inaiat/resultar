package analyzer

import (
	"fmt"
	"strings"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/checker"
)

var consumerMethods = map[string]struct{}{
	"_unsafeUnwrap": {}, "_unsafeUnwrapErr": {}, "isErr": {}, "isOk": {}, "match": {},
	"catchAll": {}, "matchTags": {}, "matchTagsPartial": {}, "unwrapOr": {}, "unwrapOrThrow": {},
}

var consumerProperties = map[string]struct{}{"error": {}, "value": {}}

var tryMapperCallNames = map[string]struct{}{
	"fromThrowable": {}, "fromThrowableAsync": {}, "tryAsync": {}, "tryCatch": {},
	"tryCatchAsync": {}, "tryResult": {}, "tryResultAsync": {},
}

var recoveryMethods = map[string]struct{}{
	"catchAll": {}, "catchReason": {}, "catchReasons": {}, "catchTag": {}, "catchTags": {},
	"mapErr": {}, "orElse": {}, "unwrapReason": {},
}

var asyncAwaitBoundaryCallNames = map[string]struct{}{
	"fromThrowableAsync": {}, "tryAsync": {}, "tryCatchAsync": {}, "tryPromise": {}, "tryResultAsync": {},
}

var resultTaskStaticConsumerMethods = map[string]struct{}{
	"catchAll": {}, "flatMap": {}, "map": {}, "provideService": {}, "provideServices": {},
	"runExit": {}, "runPromise": {}, "runResult": {},
}

type trackedResult struct {
	identifier            *ast.Node
	name                  string
	symbol                *ast.Symbol
	typeName              string
	handled               bool
	hasDiscardedResultUse bool
}

func (a *Analyzer) noDiscard(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		if node.Kind != ast.KindExpressionStatement {
			return
		}
		expression := node.AsExpressionStatement().Expression
		if isExplicitDiscard(expression) || !isCallLikeDiscard(expression) {
			return
		}
		type_ := a.checker.GetTypeAtLocation(expression)
		if !isResultLikeType(type_) {
			return
		}
		typeName := a.checker.TypeToStringEx(type_, expression, checker.TypeFormatFlagsNoTruncation, nil)
		finding := newFinding(file, expression, "no-discard", a.options.NoDiscard,
			fmt.Sprintf("Ignored %s value. Handle it or explicitly discard it with `void`.", typeName),
			typeName,
		)
		finding.Fixes = []Fix{insertFix(file, expression, "Explicitly discard this Resultar value", "void ")}
		findings = append(findings, finding)
	})
	if a.options.NoDiscardMode != "must-use" {
		return findings
	}

	tracked := a.collectTrackedResults(file)
	a.markTrackedResultUses(file, tracked)
	for _, result := range tracked {
		if result.handled || result.hasDiscardedResultUse {
			continue
		}
		findings = append(findings, newFinding(
			file,
			result.identifier,
			"no-discard",
			a.options.NoDiscard,
			fmt.Sprintf("Unhandled %s value assigned to `%s`. Handle it, return it, or explicitly discard it with `void`.", result.typeName, result.name),
			result.typeName,
		))
	}
	return findings
}

func (a *Analyzer) collectTrackedResults(file *ast.SourceFile) []*trackedResult {
	tracked := make([]*trackedResult, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		if node.Kind != ast.KindVariableDeclaration {
			return
		}
		declaration := node.AsVariableDeclaration()
		name := node.Name()
		initializer := declaration.Initializer
		if name == nil || name.Kind != ast.KindIdentifier || initializer == nil || !isCallLikeDiscard(initializer) {
			return
		}
		type_ := a.checker.GetTypeAtLocation(initializer)
		if !isResultLikeType(type_) {
			return
		}
		symbol := a.checker.GetSymbolAtLocation(name)
		if symbol == nil {
			return
		}
		tracked = append(tracked, &trackedResult{
			identifier: name,
			name:       name.Text(),
			symbol:     symbol,
			typeName:   a.checker.TypeToStringEx(type_, initializer, checker.TypeFormatFlagsNoTruncation, nil),
		})
	})
	return tracked
}

func (a *Analyzer) markTrackedResultUses(file *ast.SourceFile, tracked []*trackedResult) {
	visit(file.AsNode(), func(node *ast.Node) {
		if node.Kind != ast.KindIdentifier {
			return
		}
		var symbol *ast.Symbol
		if node.Parent != nil && node.Parent.Kind == ast.KindShorthandPropertyAssignment && node.Parent.Name() == node {
			symbol = a.checker.GetShorthandAssignmentValueSymbol(node.Parent)
		} else {
			symbol = a.checker.GetSymbolAtLocation(node)
		}
		if symbol == nil {
			return
		}
		for _, result := range tracked {
			if node == result.identifier || symbol != result.symbol {
				continue
			}
			if isHandledReference(node) {
				result.handled = true
			}
			if a.isInsideDiscardedResultExpression(node) {
				result.hasDiscardedResultUse = true
			}
		}
	})
}

func (a *Analyzer) isInsideDiscardedResultExpression(identifier *ast.Node) bool {
	for current := identifier; current != nil; current = current.Parent {
		if current.Kind != ast.KindExpressionStatement {
			continue
		}
		expression := current.AsExpressionStatement().Expression
		if isExplicitDiscard(expression) || !isCallLikeDiscard(expression) {
			return false
		}
		return isResultLikeType(a.checker.GetTypeAtLocation(expression))
	}
	return false
}

func (a *Analyzer) noPromiseInResultSuccess(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		if node.Kind != ast.KindCallExpression {
			return
		}
		call := node.AsCallExpression()
		method, receiver, nameNode := methodCall(node)
		if method == "map" || method == "as" {
			receiverType := a.checker.GetTypeAtLocation(receiver)
			if !isResultLikeType(receiverType) || isResultAsyncLikeType(receiverType) || len(call.Arguments.Nodes) == 0 {
				return
			}
			argument := call.Arguments.Nodes[0]
			hasPromise := isPromiseLikeType(a.checker, a.checker.GetTypeAtLocation(argument))
			if method == "map" {
				hasPromise = callbackReturnsPromiseLike(a.checker, argument)
			}
			if hasPromise {
				message := "This synchronous Result maps or stores a Promise in its success channel. Use asyncMap or ResultAsync for asynchronous work."
				if isResultTaskLikeType(receiverType) {
					message = "This ResultTask maps or stores a Promise in its success channel. Use flatMap/andThen with ResultTask.tryPromise for asynchronous work."
				}
				findings = append(findings, newFinding(file, nameNode, "no-promise-in-result-success", a.options.NoPromiseInResultSuccess,
					message, ""))
			}
			return
		}
		if (expressionName(call.Expression) != "ok" && !isResultTaskStaticCall(call.Expression, "succeed")) || len(call.Arguments.Nodes) == 0 {
			return
		}
		resultType := a.checker.GetTypeAtLocation(node)
		if !isResultLikeType(resultType) || isResultAsyncLikeType(resultType) {
			return
		}
		value := call.Arguments.Nodes[0]
		if isPromiseLikeType(a.checker, a.checker.GetTypeAtLocation(value)) {
			findings = append(findings, newFinding(file, value, "no-promise-in-result-success", a.options.NoPromiseInResultSuccess,
				"Do not put a Promise in a synchronous Result success channel. Use ResultAsync or a Resultar Promise boundary.", ""))
		}
	})
	return findings
}

func (a *Analyzer) noUnknownResultError(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		if node.Kind != ast.KindTypeReference {
			return
		}
		type_ := a.checker.GetTypeAtLocation(node)
		if !isResultLikeType(type_) || !hasUnknownOrAnyError(a.checker, type_) {
			return
		}
		findings = append(findings, newFinding(file, node, "no-unknown-result-error", a.options.NoUnknownResultError,
			"This Resultar error channel is unknown or any. Prefer a concrete error type or a typed catch mapper.", ""))
	})
	return findings
}

func (a *Analyzer) preferMapErr(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		method, receiver, nameNode := methodCall(node)
		if method != "orElse" || !isResultLikeType(a.checker.GetTypeAtLocation(receiver)) {
			return
		}
		arguments := node.AsCallExpression().Arguments.Nodes
		if len(arguments) == 0 {
			return
		}
		returned := getReturnedExpressions(arguments[0])
		if len(returned) == 0 {
			return
		}
		for _, expression := range returned {
			if !isErrConstructorCall(expression) || !isResultLikeType(a.checker.GetTypeAtLocation(expression)) {
				return
			}
		}
		finding := newFinding(file, nameNode, "prefer-map-err", a.options.PreferMapErr,
			"`orElse` only replaces the failure with another Err. Use `mapErr` when the Ok value cannot recover.", "")
		finding.Fixes = []Fix{renameFix(file, nameNode, "Replace orElse with mapErr", "mapErr")}
		findings = append(findings, finding)
	})
	return findings
}

func (a *Analyzer) preferAndThen(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		method, receiver, nameNode := methodCall(node)
		if method != "map" {
			return
		}
		receiverType := a.checker.GetTypeAtLocation(receiver)
		if !isResultLikeType(receiverType) {
			return
		}
		arguments := node.AsCallExpression().Arguments.Nodes
		if len(arguments) == 0 {
			return
		}
		var returnedResult *ast.Node
		for _, expression := range getReturnedExpressions(arguments[0]) {
			if isResultLikeType(a.checker.GetTypeAtLocation(expression)) {
				returnedResult = expression
				break
			}
		}
		if returnedResult == nil {
			return
		}
		returnedType := a.checker.GetTypeAtLocation(returnedResult)
		if isResultTaskLikeType(receiverType) != isResultTaskLikeType(returnedType) {
			return
		}
		methodName := "andThen"
		if !isResultAsyncLikeType(receiverType) && isResultAsyncLikeType(returnedType) {
			methodName = "asyncAndThen"
		}
		typeName := a.checker.TypeToStringEx(returnedType, returnedResult, checker.TypeFormatFlagsNoTruncation, nil)
		message := fmt.Sprintf("`map` creates a nested Result when its callback returns %s. Use `%s` for fallible composition.", typeName, methodName)
		if isResultTaskLikeType(receiverType) {
			message = fmt.Sprintf("`map` creates a nested ResultTask when its callback returns %s. Use `%s` for fallible composition.", typeName, methodName)
		}
		finding := newFinding(file, nameNode, "prefer-and-then", a.options.PreferAndThen, message, "")
		finding.Fixes = []Fix{renameFix(file, nameNode, fmt.Sprintf("Replace map with %s", methodName), methodName)}
		findings = append(findings, finding)
	})
	return findings
}

func (a *Analyzer) typedCatchMapper(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		if node.Kind != ast.KindCallExpression {
			return
		}
		call := node.AsCallExpression()
		callName := expressionName(call.Expression)
		if _, ok := tryMapperCallNames[callName]; !ok || hasMapperArgument(node) {
			return
		}
		if callName != "fromThrowable" && callName != "fromThrowableAsync" {
			errorTypes := resultErrorTypes(a.checker, a.checker.GetTypeAtLocation(node))
			if len(errorTypes) > 0 {
				allConcrete := true
				for _, errorType := range errorTypes {
					if isUnknownOrAnyType(errorType) {
						allConcrete = false
						break
					}
				}
				if allConcrete {
					return
				}
			}
		}
		findings = append(findings, newFinding(file, call.Expression, "typed-catch-mapper", a.options.TypedCatchMapper,
			fmt.Sprintf("`%s` without a catch mapper leaves the error channel as `unknown`. Map the caught value to a specific Resultar error.", callName), ""))
	})
	return findings
}

func (a *Analyzer) preferMap(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		method, receiver, nameNode := methodCall(node)
		if method != "andThen" || !isResultLikeType(a.checker.GetTypeAtLocation(receiver)) {
			return
		}
		arguments := node.AsCallExpression().Arguments.Nodes
		if len(arguments) == 0 || !callbackReturnsResultLike(a.checker, arguments[0]) {
			return
		}
		returned := getReturnedExpressions(arguments[0])
		if len(returned) == 0 {
			return
		}
		for _, expression := range returned {
			if !isOkConstructorCall(expression) {
				return
			}
		}
		message := "andThen only wraps the callback value in Ok. Use map for a non-fallible transformation."
		if isResultTaskLikeType(a.checker.GetTypeAtLocation(receiver)) {
			message = "andThen only wraps the callback value in a successful ResultTask. Use map for a non-fallible transformation."
		}
		finding := newFinding(file, nameNode, "prefer-map", a.options.PreferMap, message, "")
		finding.Fixes = []Fix{renameFix(file, nameNode, "Replace andThen with map", "map")}
		findings = append(findings, finding)
	})
	return findings
}

func (a *Analyzer) preferFirstSuccessOf(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		method, receiver, nameNode := methodCall(node)
		if method != "orElse" || !isIndependentResultFallback(a.checker, node) {
			return
		}
		current := receiver
		chainLength := 1
		for {
			unwrapped := unwrapExpression(current)
			innerMethod, innerReceiver, _ := methodCall(unwrapped)
			if innerMethod != "orElse" || !isIndependentResultFallback(a.checker, unwrapped) {
				break
			}
			chainLength++
			current = innerReceiver
		}
		if chainLength < 2 || !isResultLikeType(a.checker.GetTypeAtLocation(current)) {
			return
		}
		if isResultTaskLikeType(a.checker.GetTypeAtLocation(current)) {
			return
		}
		namespace := "Result"
		if isResultAsyncLikeType(a.checker.GetTypeAtLocation(current)) {
			namespace = "ResultAsync"
		}
		findings = append(findings, newFinding(file, nameNode, "prefer-first-success-of", a.options.PreferFirstSuccessOf,
			fmt.Sprintf("This chain has %d error-independent orElse fallbacks. Use %s.firstSuccessOf to express the fallback selection.", chainLength, namespace), ""))
	})
	return findings
}

func (a *Analyzer) preferResultForEach(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		if node.Kind != ast.KindCallExpression {
			return
		}
		call := node.AsCallExpression()
		namespace := resultarStaticNamespace(call.Expression, "combine")
		if namespace == "" || len(call.Arguments.Nodes) != 1 {
			return
		}
		combined := call.Arguments.Nodes[0]
		method, _, nameNode := methodCall(combined)
		if method != "map" {
			return
		}
		arguments := combined.AsCallExpression().Arguments.Nodes
		if len(arguments) == 0 || !callbackReturnsResultLike(a.checker, arguments[0]) ||
			!isResultLikeType(a.checker.GetTypeAtLocation(node)) {
			return
		}
		findings = append(findings, newFinding(file, nameNode, "prefer-result-for-each", a.options.PreferResultForEach,
			fmt.Sprintf("Use %s.forEach instead of %s.combine over an intermediate map result list.", namespace, namespace), ""))
	})
	return findings
}

func (a *Analyzer) preferCatchReason(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		method, receiver, nameNode := methodCall(node)
		if method != "catchTag" || !isResultLikeType(a.checker.GetTypeAtLocation(receiver)) {
			return
		}
		arguments := node.AsCallExpression().Arguments.Nodes
		if len(arguments) < 2 || !callbackChecksNestedReasonTag(arguments[1]) {
			return
		}
		findings = append(findings, newFinding(file, nameNode, "prefer-catch-reason", a.options.PreferCatchReason,
			"This catchTag callback inspects a nested reason._tag. Use catchReason or catchReasons for typed nested-error handling.", ""))
	})
	return findings
}

func (a *Analyzer) noThrow(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		if node.Kind == ast.KindThrowStatement {
			findings = append(findings, newFinding(file, node, "no-throw", a.options.NoThrow,
				"Do not throw for expected Resultar failures. Return `Err`/`errAsync` or wrap uncontrolled external code with a Resultar catch boundary.", ""))
		}
	})
	return findings
}

func (a *Analyzer) noTryCatch(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		if node.Kind != ast.KindTryStatement || node.AsTryStatement().CatchClause == nil {
			return
		}
		findings = append(findings, newFinding(file, node, "no-try-catch", a.options.NoTryCatch,
			"Avoid raw try/catch for expected failures. Use tryResult or tryResultAsync to preserve the typed error channel.", ""))
	})
	return findings
}

func (a *Analyzer) yieldStarInSafeTry(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		body := safeTryBody(node)
		if body == nil {
			return
		}
		visitFunctionBody(body, func(bodyNode *ast.Node) {
			if bodyNode.Kind != ast.KindYieldExpression {
				return
			}
			yield := bodyNode.AsYieldExpression()
			if yield.AsteriskToken != nil || yield.Expression == nil || !isResultLikeType(a.checker.GetTypeAtLocation(yield.Expression)) {
				return
			}
			finding := newFinding(file, bodyNode, "yield-star-in-safe-try", a.options.YieldStarInSafeTry,
				"Use `yield*` when unwrapping Resultar values inside `safeTry`.", "")
			finding.Fixes = []Fix{replaceTokenFix(file, bodyNode, "Use yield* for this Resultar value", "yield*")}
			findings = append(findings, finding)
		})
	})
	return findings
}

func (a *Analyzer) yieldStarInResultTaskGen(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		body := resultTaskGenBody(node)
		if body == nil {
			return
		}
		visitFunctionBody(body, func(bodyNode *ast.Node) {
			if bodyNode.Kind != ast.KindYieldExpression || bodyNode.AsYieldExpression().AsteriskToken != nil {
				return
			}
			finding := newFinding(file, bodyNode, "yield-star-in-result-task-gen", a.options.YieldStarInResultTaskGen,
				"Use `yield*` inside `ResultTask.gen`; plain `yield` is not a supported task or service composition.", "")
			finding.Fixes = []Fix{replaceTokenFix(file, bodyNode, "Use yield* for this ResultTask value", "yield*")}
			findings = append(findings, finding)
		})
	})
	return findings
}

func (a *Analyzer) noAwaitInSafeTry(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		body := safeTryBody(node)
		if body == nil {
			return
		}
		visitFunctionBody(body, func(bodyNode *ast.Node) {
			if bodyNode.Kind == ast.KindAwaitExpression {
				finding := newFinding(file, bodyNode, "no-await-in-safe-try", a.options.NoAwaitInSafeTry,
					"Do not use `await` inside `safeTry`. Use `yield*` for Resultar values and wrap raw Promises before yielding them.", "")
				if isResultLikeType(a.checker.GetTypeAtLocation(bodyNode.Expression())) {
					finding.Fixes = []Fix{replaceTokenFix(file, bodyNode, "Use yield* for this Resultar value", "yield*")}
				}
				findings = append(findings, finding)
			}
		})
	})
	return findings
}

func (a *Analyzer) noTryCatchInSafeTry(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		body := safeTryBody(node)
		if body == nil {
			return
		}
		visitFunctionBody(body, func(bodyNode *ast.Node) {
			if bodyNode.Kind == ast.KindTryStatement {
				findings = append(findings, newFinding(file, bodyNode, "no-try-catch-in-safe-try", a.options.NoTryCatchInSafeTry,
					"Avoid raw try/catch inside `safeTry`. Use `safeTry({ try, catch })`, `tryResult`, or `tryResultAsync` to keep failures typed.", ""))
			}
		})
	})
	return findings
}

func (a *Analyzer) preferTaggedError(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		if node.Kind == ast.KindClassDeclaration && classExtendsNativeError(node) {
			target := node.Name()
			if target == nil {
				target = node
			}
			findings = append(findings, newFinding(file, target, "prefer-tagged-error", a.options.PreferTaggedError,
				"Prefer `createTaggedError` for Resultar domain errors so failures keep a stable tag and typed metadata.", ""))
			return
		}
		if node.Kind == ast.KindThrowStatement {
			expression := node.AsThrowStatement().Expression
			if isNativeErrorInstance(expression) {
				findings = append(findings, newFinding(file, expression, "prefer-tagged-error", a.options.PreferTaggedError,
					"Prefer a `createTaggedError` instance over throwing `new Error(...)` so failures keep a stable tag and typed metadata.", ""))
			}
			return
		}
		if node.Kind != ast.KindCallExpression || expressionName(node.AsCallExpression().Expression) != "err" {
			return
		}
		arguments := node.AsCallExpression().Arguments.Nodes
		if len(arguments) > 0 && isNativeErrorInstance(arguments[0]) {
			findings = append(findings, newFinding(file, arguments[0], "prefer-tagged-error", a.options.PreferTaggedError,
				"Prefer a `createTaggedError` instance over `new Error(...)` in Resultar error channels.", ""))
		}
	})
	return findings
}

func (a *Analyzer) taggedErrorNameMatch(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		if node.Kind != ast.KindClassDeclaration || node.Name() == nil {
			return
		}
		options := createTaggedErrorOptions(node)
		name := taggedErrorName(options)
		className := node.Name().Text()
		if name == nil || name.Text() == className {
			return
		}
		findings = append(findings, newFinding(file, name, "tagged-error-name-match", a.options.TaggedErrorNameMatch,
			fmt.Sprintf("Tagged error name `%s` should match class name `%s`.", name.Text(), className), ""))
	})
	return findings
}

func (a *Analyzer) noTaggedErrorConstructorOverride(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		if node.Kind != ast.KindClassDeclaration || createTaggedErrorOptions(node) == nil {
			return
		}
		for _, member := range node.Members() {
			if member.Kind == ast.KindConstructor {
				findings = append(findings, newFinding(file, member, "no-tagged-error-constructor-override", a.options.NoTaggedErrorConstructorOverride,
					"Do not override the constructor generated by `createTaggedError`; it owns template props, cause, and serialization behavior.", ""))
			}
		}
	})
	return findings
}

func (a *Analyzer) noUselessRecovery(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		method, receiver, nameNode := methodCall(node)
		if _, ok := recoveryMethods[method]; !ok {
			return
		}
		errorTypes := resultErrorTypes(a.checker, a.checker.GetTypeAtLocation(receiver))
		if len(errorTypes) == 0 {
			return
		}
		for _, errorType := range errorTypes {
			if errorType == nil || errorType.Flags()&checker.TypeFlagsNever == 0 {
				return
			}
		}
		findings = append(findings, newFinding(file, nameNode, "no-useless-recovery", a.options.NoUselessRecovery,
			fmt.Sprintf("`%s` cannot run because this Resultar value has `never` in the error channel.", method), ""))
	})
	return findings
}

func (a *Analyzer) unsafeResultTypeAssertion(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		if node.Kind != ast.KindAsExpression && node.Kind != ast.KindTypeAssertionExpression {
			return
		}
		expression := node.Expression()
		originalErrors := resultErrorTypes(a.checker, a.checker.GetTypeAtLocation(expression))
		assertedErrors := resultErrorTypes(a.checker, a.checker.GetTypeAtLocation(node))
		if len(originalErrors) == 0 || len(assertedErrors) == 0 {
			return
		}
		details := make([]string, 0)
		for _, original := range originalErrors {
			if original == nil || isUnknownOrAnyType(original) {
				continue
			}
			for _, asserted := range assertedErrors {
				if asserted == nil {
					continue
				}
				originalName := a.checker.TypeToStringEx(original, expression, checker.TypeFormatFlagsNoTruncation, nil)
				assertedName := a.checker.TypeToStringEx(asserted, node, checker.TypeFormatFlagsNoTruncation, nil)
				if a.checker.IsTypeAssignableTo(original, asserted) && !isRenderedUnionNarrowing(originalName, assertedName) {
					continue
				}
				details = append(details, fmt.Sprintf("`%s` to `%s`", originalName, assertedName))
			}
		}
		if len(details) == 0 {
			return
		}
		findings = append(findings, newFinding(file, node, "unsafe-result-type-assertion", a.options.UnsafeResultTypeAssertion,
			fmt.Sprintf("This assertion narrows the Resultar error channel unsafely (%s). Prefer a real recovery or mapping step.", strings.Join(details, ", ")), ""))
	})
	return findings
}

func isRenderedUnionNarrowing(original, asserted string) bool {
	if original == asserted {
		return false
	}
	for _, part := range strings.Split(original, "|") {
		if strings.TrimSpace(part) == asserted {
			return true
		}
	}
	return false
}

func (a *Analyzer) noUnsafeAwait(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	boundaryBodies := make(map[*ast.Node]struct{})
	contextBodies := make(map[*ast.Node]struct{})
	visit(file.AsNode(), func(node *ast.Node) {
		if body := resultarAwaitBoundaryBody(node); body != nil {
			boundaryBodies[body] = struct{}{}
			contextBodies[body] = struct{}{}
			return
		}
		if body := safeTryBody(node); body != nil {
			contextBodies[body] = struct{}{}
		}
	})
	ignoredCalls := make(map[string]struct{}, len(a.options.NoUnsafeAwaitIgnoreCalls))
	for _, path := range a.options.NoUnsafeAwaitIgnoreCalls {
		ignoredCalls[path] = struct{}{}
	}

	var inspect func(*ast.Node, bool, bool)
	inspect = func(node *ast.Node, insideBoundary, insideContext bool) {
		_, startsBoundary := boundaryBodies[node]
		_, startsKnownContext := contextBodies[node]
		startsContext := startsKnownContext || a.isResultarAsyncFunctionContext(node)
		currentBoundary := insideBoundary || startsBoundary
		currentContext := insideContext || startsContext
		shouldCheck := a.options.NoUnsafeAwaitMode == "all" || currentContext

		if shouldCheck && node.Kind == ast.KindAwaitExpression && !currentBoundary {
			expression := node.Expression()
			if a.isResultarChannelAwaitExpression(expression) && !currentContext {
				findings = append(findings, newFinding(file, node, "no-unsafe-await", a.options.NoUnsafeAwait,
					"Do not unwrap a Resultar async value inside a raw Promise boundary. Return ResultAsync or Promise<Result> so failures stay in the Resultar error channel.", ""))
			} else if !a.isSafeAwaitExpression(expression, ignoredCalls) {
				findings = append(findings, newFinding(file, node, "no-unsafe-await", a.options.NoUnsafeAwait,
					"Wrap this awaited Promise in tryAsync, tryResultAsync, tryCatchAsync, or fromThrowableAsync so rejections stay in the Resultar error channel.", ""))
			}
		}

		node.ForEachChild(func(child *ast.Node) bool {
			if node != file.AsNode() && isFunctionLikeNode(node) {
				inspect(child, startsBoundary, startsContext)
			} else {
				inspect(child, currentBoundary, currentContext)
			}
			return false
		})
	}
	inspect(file.AsNode(), false, false)
	return findings
}

func resultarAwaitBoundaryBody(node *ast.Node) *ast.Node {
	if node == nil || node.Kind != ast.KindCallExpression {
		return nil
	}
	call := node.AsCallExpression()
	name := expressionName(call.Expression)
	if _, ok := asyncAwaitBoundaryCallNames[name]; !ok || len(call.Arguments.Nodes) == 0 {
		return nil
	}
	if name == "tryPromise" && !isResultTaskStaticCall(call.Expression, "tryPromise") {
		return nil
	}
	return inspectableCallbackOrObjectTry(call.Arguments.Nodes[0])
}

func inspectableCallbackOrObjectTry(expression *ast.Node) *ast.Node {
	expression = unwrapExpression(expression)
	if expression == nil {
		return nil
	}
	if expression.Kind == ast.KindArrowFunction || expression.Kind == ast.KindFunctionExpression {
		return expression
	}
	if expression.Kind != ast.KindObjectLiteralExpression {
		return nil
	}
	for _, property := range expression.AsObjectLiteralExpression().Properties.Nodes {
		if property.Name() == nil || property.Name().Text() != "try" {
			continue
		}
		if property.Kind == ast.KindMethodDeclaration {
			return property
		}
		if property.Kind == ast.KindPropertyAssignment {
			initializer := unwrapExpression(property.AsPropertyAssignment().Initializer)
			if initializer != nil && (initializer.Kind == ast.KindArrowFunction || initializer.Kind == ast.KindFunctionExpression) {
				return initializer
			}
		}
	}
	return nil
}

func (a *Analyzer) isResultarAsyncFunctionContext(node *ast.Node) bool {
	if !isFunctionLikeNode(node) {
		return false
	}
	type_ := a.checker.GetTypeAtLocation(node)
	if type_ == nil {
		return false
	}
	signatures := a.checker.GetCallSignatures(type_)
	if len(signatures) == 0 {
		return false
	}
	return a.isResultarAsyncContextReturnType(a.checker.GetReturnTypeOfSignature(signatures[0]))
}

func (a *Analyzer) isResultarAsyncContextReturnType(type_ *checker.Type) bool {
	return isResultAsyncLikeType(type_) || a.isPromiseOfResultLikeType(type_)
}

func everyUnionPart(type_ *checker.Type, predicate func(*checker.Type) bool) bool {
	if type_ == nil {
		return false
	}
	if type_.Flags()&checker.TypeFlagsUnion != 0 {
		parts := type_.Types()
		if len(parts) == 0 {
			return false
		}
		for _, part := range parts {
			if !predicate(part) {
				return false
			}
		}
		return true
	}
	return predicate(type_)
}

func (a *Analyzer) isResultarChannelAwaitExpression(expression *ast.Node) bool {
	type_ := a.checker.GetTypeAtLocation(expression)
	if type_ == nil {
		return false
	}
	if everyUnionPart(type_, isResultAsyncLikeType) {
		return true
	}
	if promised := a.checker.GetPromisedTypeOfPromise(type_); promised != nil {
		return everyUnionPart(promised, isResultLikeType)
	}
	return false
}

func (a *Analyzer) isPromiseOfResultLikeType(type_ *checker.Type) bool {
	if type_ == nil {
		return false
	}
	if type_.Flags()&checker.TypeFlagsUnionOrIntersection != 0 {
		for _, part := range type_.Types() {
			if a.isPromiseOfResultLikeType(part) {
				return true
			}
		}
		return false
	}
	promised := a.checker.GetPromisedTypeOfPromise(type_)
	return promised != nil && everyUnionPart(promised, isResultLikeType)
}

func (a *Analyzer) isSafeAwaitExpression(expression *ast.Node, ignoredCalls map[string]struct{}) bool {
	unwrapped := unwrapExpression(expression)
	if unwrapped != nil && unwrapped.Kind == ast.KindCallExpression {
		path := callPath(unwrapped.AsCallExpression().Expression)
		if _, ok := ignoredCalls[path]; ok {
			return true
		}
		if expressionName(unwrapped.AsCallExpression().Expression) == "runPromise" {
			arguments := unwrapped.AsCallExpression().Arguments.Nodes
			if len(arguments) > 0 && everyUnionPart(a.checker.GetTypeAtLocation(arguments[0]), isResultAsyncLikeType) {
				return true
			}
		}
	}
	if a.isResultarChannelAwaitExpression(expression) {
		return true
	}
	type_ := a.checker.GetTypeAtLocation(expression)
	return type_ != nil && a.checker.GetPromisedTypeOfPromise(type_) == nil && !promiseTypePattern.MatchString(a.checker.TypeToString(type_))
}

func getReturnedExpressions(callback *ast.Node) []*ast.Node {
	callback = unwrapExpression(callback)
	if callback == nil || (callback.Kind != ast.KindArrowFunction && callback.Kind != ast.KindFunctionExpression) {
		return nil
	}
	body := callback.Body()
	if body == nil {
		return nil
	}
	if callback.Kind == ast.KindArrowFunction && body.Kind != ast.KindBlock {
		return []*ast.Node{body}
	}
	expressions := make([]*ast.Node, 0)
	var inspect func(*ast.Node)
	inspect = func(node *ast.Node) {
		if node != body && isFunctionLikeNode(node) {
			return
		}
		if node.Kind == ast.KindReturnStatement {
			if expression := node.AsReturnStatement().Expression; expression != nil {
				expressions = append(expressions, expression)
			}
			return
		}
		node.ForEachChild(func(child *ast.Node) bool {
			inspect(child)
			return false
		})
	}
	inspect(body)
	return expressions
}

func callbackReturnsResultLike(checker_ *checker.Checker, callback *ast.Node) bool {
	returned := getReturnedExpressions(callback)
	if len(returned) > 0 {
		for _, expression := range returned {
			if !isResultLikeType(checker_.GetTypeAtLocation(expression)) {
				return false
			}
		}
		return true
	}
	callbackType := checker_.GetTypeAtLocation(callback)
	if callbackType == nil {
		return false
	}
	signatures := checker_.GetCallSignatures(callbackType)
	return len(signatures) > 0 && isResultLikeType(checker_.GetReturnTypeOfSignature(signatures[0]))
}

func isErrConstructorCall(expression *ast.Node) bool {
	expression = unwrapExpression(expression)
	return expression != nil && expression.Kind == ast.KindCallExpression && expressionName(expression.AsCallExpression().Expression) == "err"
}

func isOkConstructorCall(expression *ast.Node) bool {
	expression = unwrapExpression(expression)
	if expression == nil || expression.Kind != ast.KindCallExpression {
		return false
	}
	name := expressionName(expression.AsCallExpression().Expression)
	return name == "ok" || name == "okAsync" || name == "unit" || name == "unitAsync" ||
		isResultTaskStaticCall(expression.AsCallExpression().Expression, "succeed")
}

func isFunctionLikeNode(node *ast.Node) bool {
	if node == nil {
		return false
	}
	switch node.Kind {
	case ast.KindArrowFunction, ast.KindFunctionDeclaration, ast.KindFunctionExpression, ast.KindMethodDeclaration:
		return true
	default:
		return false
	}
}

func isArgumentlessFunction(expression *ast.Node) bool {
	expression = unwrapExpression(expression)
	return expression != nil && (expression.Kind == ast.KindArrowFunction || expression.Kind == ast.KindFunctionExpression) && len(expression.Parameters()) == 0
}

func hasMapperArgument(callNode *ast.Node) bool {
	arguments := callNode.AsCallExpression().Arguments.Nodes
	return len(arguments) > 1 || (len(arguments) > 0 && hasObjectCatchProperty(arguments[0]))
}

func hasObjectCatchProperty(expression *ast.Node) bool {
	expression = unwrapExpression(expression)
	if expression == nil || expression.Kind != ast.KindObjectLiteralExpression {
		return false
	}
	for _, property := range expression.AsObjectLiteralExpression().Properties.Nodes {
		if property.Kind != ast.KindPropertyAssignment && property.Kind != ast.KindMethodDeclaration {
			continue
		}
		if name := property.Name(); name != nil && name.Text() == "catch" {
			return true
		}
	}
	return false
}

func isIndependentResultFallback(checker_ *checker.Checker, callNode *ast.Node) bool {
	if callNode == nil || callNode.Kind != ast.KindCallExpression {
		return false
	}
	arguments := callNode.AsCallExpression().Arguments.Nodes
	return len(arguments) > 0 && isArgumentlessFunction(arguments[0]) && callbackReturnsResultLike(checker_, arguments[0])
}

func callPath(expression *ast.Node) string {
	expression = unwrapExpression(expression)
	if expression == nil {
		return ""
	}
	if expression.Kind == ast.KindIdentifier {
		return expression.Text()
	}
	if expression.Kind != ast.KindPropertyAccessExpression || expression.Name() == nil {
		return ""
	}
	parent := callPath(expression.AsPropertyAccessExpression().Expression)
	if parent == "" {
		return ""
	}
	return parent + "." + expression.Name().Text()
}

func isResultTaskStaticCall(expression *ast.Node, method string) bool {
	path := callPath(expression)
	target := "ResultTask." + method
	return path == target || strings.HasSuffix(path, "."+target)
}

func resultarStaticNamespace(expression *ast.Node, methodName string) string {
	path := callPath(expression)
	result := "Result." + methodName
	resultAsync := "ResultAsync." + methodName
	if path == result || strings.HasSuffix(path, "."+result) {
		return "Result"
	}
	if path == resultAsync || strings.HasSuffix(path, "."+resultAsync) {
		return "ResultAsync"
	}
	return ""
}

func callbackChecksNestedReasonTag(callback *ast.Node) bool {
	callback = unwrapExpression(callback)
	if callback == nil || (callback.Kind != ast.KindArrowFunction && callback.Kind != ast.KindFunctionExpression) || callback.Body() == nil {
		return false
	}
	found := false
	visitFunctionBody(callback, func(node *ast.Node) {
		if isReasonTagAccess(node) {
			found = true
		}
	})
	return found
}

func isReasonTagAccess(node *ast.Node) bool {
	if node == nil || node.Kind != ast.KindPropertyAccessExpression || node.Name() == nil || node.Name().Text() != "_tag" {
		return false
	}
	reason := unwrapExpression(node.AsPropertyAccessExpression().Expression)
	return reason != nil && reason.Kind == ast.KindPropertyAccessExpression && reason.Name() != nil && reason.Name().Text() == "reason"
}

func safeTryBody(node *ast.Node) *ast.Node {
	if node == nil || node.Kind != ast.KindCallExpression {
		return nil
	}
	call := node.AsCallExpression()
	if expressionName(call.Expression) != "safeTry" || len(call.Arguments.Nodes) == 0 {
		return nil
	}
	first := unwrapExpression(call.Arguments.Nodes[0])
	if first == nil {
		return nil
	}
	if first.Kind == ast.KindArrowFunction || first.Kind == ast.KindFunctionExpression {
		return first
	}
	if first.Kind != ast.KindObjectLiteralExpression {
		return nil
	}
	for _, property := range first.AsObjectLiteralExpression().Properties.Nodes {
		name := property.Name()
		if name == nil || name.Text() != "try" {
			continue
		}
		if property.Kind == ast.KindMethodDeclaration {
			return property
		}
		if property.Kind == ast.KindPropertyAssignment {
			initializer := unwrapExpression(property.AsPropertyAssignment().Initializer)
			if initializer != nil && (initializer.Kind == ast.KindArrowFunction || initializer.Kind == ast.KindFunctionExpression) {
				return initializer
			}
		}
	}
	return nil
}

func resultTaskGenBody(node *ast.Node) *ast.Node {
	if node == nil || node.Kind != ast.KindCallExpression {
		return nil
	}
	call := node.AsCallExpression()
	if !isResultTaskStaticCall(call.Expression, "gen") || len(call.Arguments.Nodes) == 0 {
		return nil
	}
	body := unwrapExpression(call.Arguments.Nodes[0])
	if body == nil || (body.Kind != ast.KindFunctionExpression && body.Kind != ast.KindArrowFunction && body.Kind != ast.KindMethodDeclaration) {
		return nil
	}
	return body
}

func visitFunctionBody(function *ast.Node, visitor func(*ast.Node)) {
	if function == nil || function.Body() == nil {
		return
	}
	root := function.Body()
	var inspect func(*ast.Node)
	inspect = func(node *ast.Node) {
		if node != root && isFunctionLikeNode(node) {
			return
		}
		visitor(node)
		node.ForEachChild(func(child *ast.Node) bool {
			inspect(child)
			return false
		})
	}
	inspect(root)
}

func classHeritageClauses(class *ast.Node) []*ast.Node {
	if class == nil || class.Kind != ast.KindClassDeclaration || class.AsClassDeclaration().HeritageClauses == nil {
		return nil
	}
	return class.AsClassDeclaration().HeritageClauses.Nodes
}

func createTaggedErrorOptions(class *ast.Node) *ast.Node {
	for _, clauseNode := range classHeritageClauses(class) {
		clause := clauseNode.AsHeritageClause()
		if clause.Token != ast.KindExtendsKeyword || clause.Types == nil {
			continue
		}
		for _, heritageType := range clause.Types.Nodes {
			expression := heritageType.AsExpressionWithTypeArguments().Expression
			if expression == nil || expression.Kind != ast.KindCallExpression ||
				expressionName(expression.AsCallExpression().Expression) != "createTaggedError" {
				continue
			}
			arguments := expression.AsCallExpression().Arguments.Nodes
			if len(arguments) > 0 && arguments[0].Kind == ast.KindObjectLiteralExpression {
				return arguments[0]
			}
		}
	}
	return nil
}

func taggedErrorName(options *ast.Node) *ast.Node {
	if options == nil || options.Kind != ast.KindObjectLiteralExpression {
		return nil
	}
	for _, property := range options.AsObjectLiteralExpression().Properties.Nodes {
		if property.Kind != ast.KindPropertyAssignment || property.Name() == nil || property.Name().Text() != "name" {
			continue
		}
		initializer := property.AsPropertyAssignment().Initializer
		if initializer != nil && (initializer.Kind == ast.KindStringLiteral || initializer.Kind == ast.KindNoSubstitutionTemplateLiteral) {
			return initializer
		}
	}
	return nil
}

func classExtendsNativeError(class *ast.Node) bool {
	for _, clauseNode := range classHeritageClauses(class) {
		clause := clauseNode.AsHeritageClause()
		if clause.Token != ast.KindExtendsKeyword || clause.Types == nil {
			continue
		}
		for _, heritageType := range clause.Types.Nodes {
			if expressionName(heritageType.AsExpressionWithTypeArguments().Expression) == "Error" {
				return true
			}
		}
	}
	return false
}

func isNativeErrorInstance(expression *ast.Node) bool {
	expression = unwrapExpression(expression)
	return expression != nil && expression.Kind == ast.KindNewExpression && expressionName(expression.Expression()) == "Error"
}

func methodCall(node *ast.Node) (string, *ast.Node, *ast.Node) {
	if node == nil || node.Kind != ast.KindCallExpression {
		return "", nil, nil
	}
	expression := unwrapExpression(node.AsCallExpression().Expression)
	if expression == nil || expression.Kind != ast.KindPropertyAccessExpression || expression.Name() == nil {
		return "", nil, nil
	}
	return expression.Name().Text(), expression.AsPropertyAccessExpression().Expression, expression.Name()
}

func callbackReturnsPromiseLike(checker_ *checker.Checker, callback *ast.Node) bool {
	callbackType := checker_.GetTypeAtLocation(callback)
	if callbackType == nil {
		return false
	}
	signatures := checker_.GetCallSignatures(callbackType)
	if len(signatures) == 0 {
		return false
	}
	return isPromiseLikeType(checker_, checker_.GetReturnTypeOfSignature(signatures[0]))
}

func isExplicitDiscard(expression *ast.Node) bool {
	expression = unwrapExpression(expression)
	return expression != nil && expression.Kind == ast.KindVoidExpression
}

func isCallLikeDiscard(expression *ast.Node) bool {
	expression = unwrapExpression(expression)
	if expression == nil {
		return false
	}
	switch expression.Kind {
	case ast.KindAwaitExpression:
		return isCallLikeDiscard(expression.Expression())
	case ast.KindCallExpression:
		return true
	case ast.KindConditionalExpression:
		conditional := expression.AsConditionalExpression()
		return isCallLikeDiscard(conditional.WhenTrue) || isCallLikeDiscard(conditional.WhenFalse)
	case ast.KindBinaryExpression:
		binary := expression.AsBinaryExpression()
		switch binary.OperatorToken.Kind {
		case ast.KindAmpersandAmpersandToken, ast.KindBarBarToken, ast.KindQuestionQuestionToken:
			return isCallLikeDiscard(binary.Right)
		}
	}
	return false
}

func isWrapperParent(parent, child *ast.Node) bool {
	if parent == nil {
		return false
	}
	switch parent.Kind {
	case ast.KindParenthesizedExpression, ast.KindAsExpression, ast.KindTypeAssertionExpression,
		ast.KindNonNullExpression, ast.KindSatisfiesExpression:
		return parent.Expression() == child
	}
	return false
}

func referenceChainRoot(identifier *ast.Node) (*ast.Node, *ast.Node) {
	current := identifier
	for parent := current.Parent; parent != nil; parent = current.Parent {
		if isWrapperParent(parent, current) || (parent.Kind == ast.KindAwaitExpression && parent.Expression() == current) {
			current = parent
			continue
		}
		if parent.Kind == ast.KindPropertyAccessExpression && parent.AsPropertyAccessExpression().Expression == current {
			current = parent
			continue
		}
		if parent.Kind == ast.KindCallExpression && parent.AsCallExpression().Expression == current {
			current = parent
			continue
		}
		return current, parent
	}
	return current, nil
}

func isHandledReference(identifier *ast.Node) bool {
	root, parent := referenceChainRoot(identifier)
	if parent != nil && parent.Kind == ast.KindReturnStatement && parent.AsReturnStatement().Expression == root {
		return true
	}
	if parent != nil && parent.Kind == ast.KindArrowFunction && parent.Body() == root {
		return true
	}
	if parent != nil && parent.Kind == ast.KindVoidExpression && parent.Expression() == root {
		return true
	}
	if isConsumedByReceiverChain(identifier) {
		return true
	}
	if isConsumedByResultTaskStaticCall(identifier) {
		return true
	}

	current := identifier
	for parent := current.Parent; parent != nil; parent = current.Parent {
		if isReturnValueContainer(parent, current) {
			current = parent
			continue
		}
		return (parent.Kind == ast.KindReturnStatement && parent.AsReturnStatement().Expression == current) ||
			(parent.Kind == ast.KindArrowFunction && parent.Body() == current)
	}
	return false
}

func isConsumedByResultTaskStaticCall(identifier *ast.Node) bool {
	current := identifier
	for parent := current.Parent; parent != nil; parent = current.Parent {
		if isWrapperParent(parent, current) || (parent.Kind == ast.KindAwaitExpression && parent.Expression() == current) {
			current = parent
			continue
		}
		if parent.Kind == ast.KindPropertyAccessExpression && parent.AsPropertyAccessExpression().Expression == current {
			current = parent
			continue
		}
		if parent.Kind == ast.KindCallExpression {
			call := parent.AsCallExpression()
			if len(call.Arguments.Nodes) > 0 && call.Arguments.Nodes[0] == current && isResultTaskStaticConsumerCall(call.Expression) {
				return true
			}
			if call.Expression == current {
				current = parent
				continue
			}
		}
		return false
	}
	return false
}

func isResultTaskStaticConsumerCall(expression *ast.Node) bool {
	for method := range resultTaskStaticConsumerMethods {
		if isResultTaskStaticCall(expression, method) {
			return true
		}
	}
	return false
}

func isConsumedByReceiverChain(identifier *ast.Node) bool {
	current := identifier
	for parent := current.Parent; parent != nil; parent = current.Parent {
		if isWrapperParent(parent, current) || (parent.Kind == ast.KindAwaitExpression && parent.Expression() == current) {
			current = parent
			continue
		}
		if parent.Kind == ast.KindPropertyAccessExpression && parent.AsPropertyAccessExpression().Expression == current {
			name := parent.Name().Text()
			if _, ok := consumerProperties[name]; ok {
				return true
			}
			if _, ok := consumerMethods[name]; ok && parent.Parent != nil && parent.Parent.Kind == ast.KindCallExpression && parent.Parent.AsCallExpression().Expression == parent {
				return true
			}
			current = parent
			continue
		}
		if parent.Kind == ast.KindCallExpression && parent.AsCallExpression().Expression == current {
			current = parent
			continue
		}
		return false
	}
	return false
}

func isReturnValueContainer(parent, child *ast.Node) bool {
	if isWrapperParent(parent, child) {
		return true
	}
	switch parent.Kind {
	case ast.KindShorthandPropertyAssignment:
		return parent.Name() == child
	case ast.KindPropertyAssignment:
		return parent.Initializer() == child
	case ast.KindSpreadAssignment, ast.KindSpreadElement:
		return parent.Expression() == child
	case ast.KindObjectLiteralExpression, ast.KindArrayLiteralExpression:
		return true
	case ast.KindConditionalExpression:
		conditional := parent.AsConditionalExpression()
		return conditional.WhenTrue == child || conditional.WhenFalse == child
	}
	return false
}
