package analyzer

import (
	"fmt"
	"strings"

	"github.com/microsoft/TypeScript/tsc/internal/ast"
	"github.com/microsoft/TypeScript/tsc/internal/checker"
)

var consumerMethods = map[string]struct{}{
	"_unsafeUnwrap": {}, "_unsafeUnwrapErr": {}, "isErr": {}, "isOk": {}, "match": {},
	"catchAll": {}, "catchCause": {}, "orElse": {}, "orElseSucceed": {}, "matchTags": {}, "matchTagsPartial": {}, "unwrapOr": {}, "unwrapOrThrow": {},
	"retry":      {},
	"withPermit": {}, "withPermits": {}, "join": {}, "await": {}, "interrupt": {},
	"exhaustive": {}, "orElseAbsurd": {}, "option": {}, "result": {}, "tagsExhaustive": {},
}

var consumerProperties = map[string]struct{}{"error": {}, "value": {}}

var tryMapperCallNames = map[string]struct{}{
	"fromThrowable": {}, "fromThrowableAsync": {}, "try": {}, "tryAsync": {}, "tryCatch": {},
	"tryCatchAsync": {}, "tryPromise": {}, "tryResult": {}, "tryResultAsync": {},
}

var recoveryMethods = map[string]struct{}{
	"catchAll": {}, "catchCause": {}, "orElse": {}, "orElseSucceed": {}, "catchReason": {}, "catchReasons": {}, "catchTag": {}, "catchTags": {},
	"mapErr": {}, "mapError": {}, "unwrapReason": {},
}

var asyncAwaitBoundaryCallNames = map[string]struct{}{
	"fromThrowableAsync": {}, "tryAsync": {}, "tryCatchAsync": {}, "tryCatch": {}, "tryPromise": {}, "tryResultAsync": {},
}

var resultTaskStaticConsumerMethods = map[string]struct{}{
	"catchAll": {}, "catchCause": {}, "orElse": {}, "orElseSucceed": {}, "unwrapOr": {}, "catchReason": {}, "catchReasons": {}, "unwrapReason": {}, "catchTag": {}, "catchTags": {}, "sandbox": {}, "unsandbox": {}, "flatMap": {}, "andThen": {}, "map": {}, "mapError": {}, "mapErr": {}, "filterOrElse": {}, "match": {}, "matchTags": {}, "matchTagsPartial": {}, "tap": {}, "tapError": {}, "tapCause": {}, "tapBoth": {}, "as": {}, "asVoid": {},
	"scoped": {}, "forkChild": {}, "all": {}, "zip": {}, "firstSuccessOf": {}, "race": {}, "raceFirst": {}, "raceAll": {}, "raceWith": {}, "retry": {}, "retryOrElse": {}, "timeout": {}, "delay": {}, "timed": {}, "ensuring": {}, "onExit": {}, "withResource": {},
	"when": {}, "whenResult": {}, "unless": {}, "unlessResult": {}, "if": {}, "loop": {}, "iterate": {},
	"inspect": {}, "inspectError": {}, "inspectCause": {}, "inspectBoth": {}, "provideService": {}, "provideServices": {}, "provideServiceResolver": {},
	"acquireDisposable": {}, "memoize": {}, "fromTask": {}, "fromResultAsync": {}, "forEach": {}, "validateAll": {}, "combine": {}, "combineWithAllErrors": {},
	"asyncMap": {}, "asyncAndThen": {}, "liftPredicate": {}, "fromNullishOr": {},
	"runExit": {}, "runFork": {}, "runPromise": {}, "runResult": {}, "toResultAsync": {},
}

var resultTaskInstanceRunnerMethods = map[string]struct{}{
	"runExit": {}, "runFork": {}, "runPromise": {}, "runResult": {},
}

var matchStaticConsumerMethods = map[string]struct{}{
	"when": {}, "whenOr": {}, "whenAnd": {}, "not": {}, "tag": {}, "tags": {}, "tagStartsWith": {},
	"tagsExhaustive": {}, "exhaustive": {}, "orElse": {}, "orElseAbsurd": {}, "result": {}, "option": {},
}

var fiberStaticConsumerMethods = map[string]struct{}{
	"join": {}, "await": {}, "interrupt": {}, "interruptAll": {}, "all": {},
}

type trackedResult struct {
	identifier            *ast.Node
	name                  string
	symbol                *ast.Symbol
	typeName              string
	handled               bool
	hasDiscardedResultUse bool
}

func isMustUseResultarType(type_ *checker.Type) bool {
	return isResultLikeType(type_) || isMatchMatcherType(type_)
}

func (a *Analyzer) noDiscard(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		if node.Kind != ast.KindExpressionStatement {
			return
		}
		expression := node.AsExpressionStatement().Expression
		if isExplicitDiscard(expression) || !isCallLikeDiscard(expression) || nodeCannotBeResultarType(expression) {
			return
		}
		type_ := a.checker.GetTypeAtLocation(expression)
		if !isMustUseResultarType(type_) {
			return
		}
		typeName := a.checker.TypeToStringEx(type_, expression, checker.TypeFormatFlagsNoTruncation, nil)
		finding := newFinding(file, expression, "no-discard", a.options.NoDiscard,
			fmt.Sprintf("Ignored %s value. Handle it or explicitly discard it with `void`.", typeName),
			typeName,
		)
		fix := insertFix(file, expression, "Intentionally discard this Resultar value", "void ")
		fix.Kind = FixIntentionalDiscard
		fix.Description = "Discarding does not handle errors or execute a lazy ResultTask. Return, compose, or run the task when its work is required."
		finding.Fixes = []Fix{fix}
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
		if name == nil || name.Kind != ast.KindIdentifier || initializer == nil || !isCallLikeDiscard(initializer) || nodeCannotBeResultarType(initializer) {
			return
		}
		type_ := a.checker.GetTypeAtLocation(initializer)
		if !isMustUseResultarType(type_) {
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
			if a.isHandledReference(node) {
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
		return isMustUseResultarType(a.checker.GetTypeAtLocation(expression))
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
		method, receiverType, nameNode, arguments, _ := a.operatorCall(node)
		if method == "map" || method == "as" {
			if !isResultLikeType(receiverType) || isResultAsyncLikeType(receiverType) || len(arguments) == 0 {
				return
			}
			argument := arguments[0]
			hasPromise := isPromiseLikeType(a.checker, a.checker.GetTypeAtLocation(argument))
			if method == "map" {
				hasPromise = callbackReturnsPromiseLike(a.checker, argument)
			}
			if hasPromise {
				message := "This synchronous Result maps or stores a Promise in its success channel. Use asyncMap or ResultAsync for asynchronous work."
				if isResultTaskLikeType(receiverType) {
					message = "This ResultTask maps or stores a Promise in its success channel. Use andThen with ResultTask.tryPromise for asynchronous work."
				}
				findings = append(findings, newFinding(file, nameNode, "no-promise-in-result-success", a.options.NoPromiseInResultSuccess,
					message, ""))
			}
			return
		}
		if (expressionName(call.Expression) != "ok" && !a.isResultTaskStaticCall(call.Expression, "succeed") && !a.isResultTaskStaticCall(call.Expression, "ok") && a.staticNamespace(call.Expression, "ok") != "Result") || len(call.Arguments.Nodes) == 0 {
			return
		}
		resultType := a.checker.GetTypeAtLocation(node)
		if !isResultLikeType(resultType) || isResultAsyncLikeType(resultType) {
			return
		}
		value := call.Arguments.Nodes[0]
		if isPromiseLikeType(a.checker, a.checker.GetTypeAtLocation(value)) {
			message := "Do not put a Promise in a synchronous Result success channel. Use ResultAsync or a Resultar Promise boundary."
			if isResultTaskLikeType(resultType) {
				message = "Do not put a Promise in a ResultTask success channel. Use andThen with ResultTask.tryPromise for asynchronous work."
			}
			findings = append(findings, newFinding(file, value, "no-promise-in-result-success", a.options.NoPromiseInResultSuccess,
				message, ""))
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
		method, receiverType, nameNode, arguments, _ := a.operatorCall(node)
		if (method != "orElse" && method != "catchAll") || !isResultLikeType(receiverType) || len(arguments) == 0 {
			return
		}
		returned := getReturnedExpressions(arguments[0])
		if len(returned) == 0 {
			return
		}
		for _, expression := range returned {
			if !a.isErrConstructorCall(expression) || !isResultLikeType(a.checker.GetTypeAtLocation(expression)) {
				return
			}
		}
		finding := newFinding(file, nameNode, "prefer-map-err", a.options.PreferMapErr,
			fmt.Sprintf("`%s` only replaces the failure with another Err. Use `mapErr` when the Ok value cannot recover.", method), "")
		finding.Fixes = []Fix{renameFix(file, nameNode, fmt.Sprintf("Replace %s with mapErr", method), "mapErr")}
		findings = append(findings, finding)
	})
	return findings
}

func (a *Analyzer) preferAndThen(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		method, receiverType, nameNode, arguments, _ := a.operatorCall(node)
		if method != "map" || !isResultLikeType(receiverType) || len(arguments) == 0 {
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
		receiverIsTask := isResultTaskLikeType(receiverType)
		returnedIsTask := isResultTaskLikeType(returnedType)
		returnedIsAsync := isResultAsyncLikeType(returnedType) || isAwaitableResultTaskType(a.checker, returnedType)
		if !receiverIsTask && returnedIsTask && !isAwaitableResultTaskType(a.checker, returnedType) {
			return
		}
		methodName := "andThen"
		typeName := a.checker.TypeToStringEx(returnedType, returnedResult, checker.TypeFormatFlagsNoTruncation, nil)
		message := fmt.Sprintf("`map` creates a nested Result when its callback returns %s. Use `%s` for fallible composition.", typeName, methodName)
		if receiverIsTask {
			message = fmt.Sprintf("`map` creates a nested ResultTask when its callback returns %s. Use `%s` for fallible composition.", typeName, methodName)
		}
		canRename := true
		if returnedIsAsync && !isResultAsyncLikeType(receiverType) {
			if !receiverIsTask {
				methodName = "asyncAndThen"
				message = fmt.Sprintf("`map` creates a nested Result when its callback returns %s. Use `%s` for fallible composition.", typeName, methodName)
				canRename = a.hasOperatorReplacement(node, receiverType, methodName)
			} else if receiverIsTask && !returnedIsTask {
				canRename = false
				message = fmt.Sprintf("`map` creates a nested ResultAsync when its callback returns %s. Compose it with `andThen` and `ResultTask.fromResultAsync`.", typeName)
			}
		}
		finding := newFinding(file, nameNode, "prefer-and-then", a.options.PreferAndThen, message, "")
		if canRename {
			finding.Fixes = []Fix{renameFix(file, nameNode, fmt.Sprintf("Replace map with %s", methodName), methodName)}
		}
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
		callName := a.canonicalExpressionName(call.Expression)
		if _, ok := tryMapperCallNames[callName]; !ok || hasMapperArgument(node) {
			return
		}
		if callName == "try" {
			if call.Expression.Kind == ast.KindPropertyAccessExpression {
				if a.resultarStaticNamespace(call.Expression, "try") == "" {
					return
				}
			} else if !isResultLikeType(a.checker.GetTypeAtLocation(node)) {
				return
			}
		}
		if callName == "tryPromise" && !a.isResultTaskStaticCall(call.Expression, "tryPromise") {
			return
		}
		if callName != "fromThrowable" && callName != "fromThrowableAsync" {
			errorTypes := resultErrorTypes(a.checker, a.checker.GetTypeAtLocation(node))
			if len(errorTypes) == 0 && (callName == "try" || callName == "tryPromise") {
				return
			}
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
		displayName := callName
		if call.Expression.Kind == ast.KindPropertyAccessExpression && (callName == "try" || callName == "tryPromise") {
			if path := callPath(call.Expression); path != "" {
				displayName = path
			}
		}
		findings = append(findings, newFinding(file, call.Expression, "typed-catch-mapper", a.options.TypedCatchMapper,
			fmt.Sprintf("`%s` without a catch mapper leaves the error channel as `unknown`. Map the caught value to a specific Resultar error.", displayName), ""))
	})
	return findings
}

func (a *Analyzer) preferMap(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		method, receiverType, nameNode, arguments, _ := a.operatorCall(node)
		if (method != "andThen" && method != "flatMap") || !isResultLikeType(receiverType) {
			return
		}
		if len(arguments) == 0 || !callbackReturnsResultLike(a.checker, arguments[0]) {
			return
		}
		returned := getReturnedExpressions(arguments[0])
		if len(returned) == 0 {
			return
		}
		for _, expression := range returned {
			if !a.isOkConstructorCall(expression) {
				return
			}
		}
		message := fmt.Sprintf("%s only wraps the callback value in Ok. Use map for a non-fallible transformation.", method)
		if isResultTaskLikeType(receiverType) {
			message = fmt.Sprintf("%s only wraps the callback value in a successful ResultTask. Use map for a non-fallible transformation.", method)
		}
		finding := newFinding(file, nameNode, "prefer-map", a.options.PreferMap, message, "")
		finding.Fixes = []Fix{renameFix(file, nameNode, fmt.Sprintf("Replace %s with map", method), "map")}
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
		currentType := a.checker.GetTypeAtLocation(current)
		if chainLength < 2 || !isResultLikeType(currentType) {
			return
		}
		namespace := "Result"
		if isResultTaskLikeType(currentType) {
			namespace = "ResultTask"
		} else if isResultAsyncLikeType(currentType) {
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
		combinator := "combine"
		namespace := a.resultarStaticNamespace(call.Expression, "combine")
		if namespace == "" {
			combinator = "all"
			namespace = a.resultarStaticNamespace(call.Expression, "all")
		}
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
			fmt.Sprintf("Use %s.forEach instead of %s.%s over an intermediate map result list.", namespace, namespace, combinator), ""))
	})
	return findings
}

func (a *Analyzer) preferCatchReason(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		method, receiverType, nameNode, arguments, _ := a.operatorCall(node)
		if method != "catchTag" || !isResultLikeType(receiverType) {
			return
		}
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
		body := a.safeTryBody(node)
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
		body := a.resultTaskGenBody(node)
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
		body := a.safeTryBody(node)
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
		body := a.safeTryBody(node)
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
		if node.Kind != ast.KindCallExpression || !a.isErrConstructorCall(node) {
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
		method, receiverType, nameNode, _, _ := a.operatorCall(node)
		_, isRecovery := recoveryMethods[method]
		if !isRecovery && method != "unwrapOr" {
			return
		}
		if !isRecovery && !isResultTaskLikeType(receiverType) {
			return
		}
		errorTypes := resultErrorTypes(a.checker, receiverType)
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
		// Only the outer assertion reports a chain; retain the expression before unknown/any bridges.
		parent := node.Parent
		for parent != nil && parent.Kind == ast.KindParenthesizedExpression {
			parent = parent.Parent
		}
		if parent != nil && (parent.Kind == ast.KindAsExpression || parent.Kind == ast.KindTypeAssertionExpression) {
			return
		}
		expression := node.Expression()
		for expression != nil && (expression.Kind == ast.KindAsExpression || expression.Kind == ast.KindTypeAssertionExpression || expression.Kind == ast.KindParenthesizedExpression) {
			expression = expression.Expression()
		}
		source, target := a.checker.GetTypeAtLocation(expression), a.checker.GetTypeAtLocation(node)
		for _, channel := range []struct {
			name    string
			extract func(*checker.Checker, *checker.Type) []*checker.Type
		}{{"error", resultErrorTypes}, {"requirements", taskRequirementTypes}} {
			originalTypes, assertedTypes := channel.extract(a.checker, source), channel.extract(a.checker, target)
			details := []string{}
			for _, original := range originalTypes {
				if original == nil || isUnknownOrAnyType(original) {
					continue
				}
				for _, asserted := range assertedTypes {
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
			if len(details) > 0 {
				advice := "Prefer a real recovery or mapping step."
				if channel.name == "requirements" {
					advice = "Provide the services or close the owning scope instead of erasing requirements."
				}
				findings = append(findings, newFinding(file, node, "unsafe-result-type-assertion", a.options.UnsafeResultTypeAssertion, fmt.Sprintf("This assertion narrows the Resultar %s channel unsafely (%s). %s", channel.name, strings.Join(details, ", "), advice), ""))
			}
		}
	})
	return findings
}

func (a *Analyzer) noUnknownTaskRequirements(file *ast.SourceFile) []Finding {
	findings := []Finding{}
	visit(file.AsNode(), func(node *ast.Node) {
		if node.Kind != ast.KindTypeReference {
			return
		}
		for _, r := range taskRequirementTypes(a.checker, a.checker.GetTypeAtLocation(node)) {
			if isUnknownOrAnyType(r) {
				findings = append(findings, newFinding(file, node, "no-unknown-task-requirements", a.options.NoUnknownTaskRequirements, "This ResultTask requirements channel is unknown or any. Preserve concrete services and scope requirements.", ""))
				break
			}
		}
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
		if body := a.resultarAwaitBoundaryBody(node); body != nil {
			boundaryBodies[body] = struct{}{}
			contextBodies[body] = struct{}{}
			return
		}
		if body := a.safeTryBody(node); body != nil {
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
					"Do not unwrap a Resultar async value inside a raw Promise boundary. Return ResultAsync or StrictResultAsync so failures stay in the Resultar error channel.", ""))
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

func (a *Analyzer) resultarAwaitBoundaryBody(node *ast.Node) *ast.Node {
	if node == nil || node.Kind != ast.KindCallExpression {
		return nil
	}
	call := node.AsCallExpression()
	name := a.canonicalExpressionName(call.Expression)
	if _, ok := asyncAwaitBoundaryCallNames[name]; !ok || len(call.Arguments.Nodes) == 0 {
		return nil
	}
	if name == "tryCatch" && a.staticNamespace(call.Expression, "tryCatch") != "ResultAsync" {
		return nil
	}
	if name == "tryPromise" && !a.isResultTaskStaticCall(call.Expression, "tryPromise") {
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
	if everyUnionPart(type_, func(part *checker.Type) bool {
		return isResultAsyncLikeType(part) || isAwaitableResultTaskType(a.checker, part)
	}) {
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
		if a.isResultTaskStaticCall(unwrapped.AsCallExpression().Expression, "runExit") {
			arguments := unwrapped.AsCallExpression().Arguments.Nodes
			if len(arguments) > 0 && everyUnionPart(a.checker.GetTypeAtLocation(arguments[0]), isResultTaskLikeType) {
				return true
			}
		}
		method, receiver, _ := methodCall(unwrapped)
		if method == "runExit" && a.isResultTaskInstanceRunner(method, receiver) {
			return true
		}
		if expressionName(unwrapped.AsCallExpression().Expression) == "runPromise" {
			arguments := unwrapped.AsCallExpression().Arguments.Nodes
			if len(arguments) > 0 && everyUnionPart(a.checker.GetTypeAtLocation(arguments[0]), func(part *checker.Type) bool {
				return isResultAsyncLikeType(part) || isAwaitableResultTaskType(a.checker, part)
			}) {
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

func (a *Analyzer) isErrConstructorCall(expression *ast.Node) bool {
	expression = unwrapExpression(expression)
	if expression == nil || expression.Kind != ast.KindCallExpression {
		return false
	}
	callee := expression.AsCallExpression().Expression
	name := a.canonicalExpressionName(callee)
	if name == "err" || name == "errAsync" {
		return true
	}
	if a.staticNamespace(callee, "err") == "Result" ||
		a.staticNamespace(callee, "err") == "ResultAsync" ||
		a.isResultTaskStaticCall(callee, "err") ||
		a.isResultTaskStaticCall(callee, "fail") {
		return true
	}
	propName := expressionName(callee)
	if (propName == "err" || propName == "errAsync" || propName == "taskErr") && isResultLikeType(a.checker.GetTypeAtLocation(expression)) {
		return true
	}
	return false
}

func (a *Analyzer) isOkConstructorCall(expression *ast.Node) bool {
	expression = unwrapExpression(expression)
	if expression == nil || expression.Kind != ast.KindCallExpression {
		return false
	}
	callee := expression.AsCallExpression().Expression
	name := a.canonicalExpressionName(callee)
	if name == "ok" || name == "okAsync" || name == "unit" || name == "unitAsync" {
		return true
	}
	return a.staticNamespace(callee, "ok") == "Result" ||
		a.staticNamespace(callee, "ok") == "ResultAsync" ||
		a.isResultTaskStaticCall(callee, "ok") ||
		a.isResultTaskStaticCall(callee, "succeed")
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

// Resolve the imported symbol, including aliases and barrel reexports. Looking only at
// source spelling lets the same API silently bypass rules when an import is renamed.
func (a *Analyzer) canonicalExpressionName(expression *ast.Node) string {
	expression = unwrapExpression(expression)
	if expression == nil {
		return ""
	}
	symbol := a.checker.GetSymbolAtLocation(expression)
	if symbol != nil {
		if symbol.Flags()&ast.SymbolFlagsAlias != 0 {
			symbol = a.checker.GetAliasedSymbol(symbol)
		}
		if symbol != nil {
			return symbol.Name()
		}
	}
	return expressionName(expression)
}

func (a *Analyzer) staticNamespace(expression *ast.Node, method string) string {
	expression = unwrapExpression(expression)
	if expression == nil || expression.Kind != ast.KindPropertyAccessExpression || expressionName(expression) != method {
		return ""
	}
	return a.canonicalExpressionName(expression.AsPropertyAccessExpression().Expression)
}

func (a *Analyzer) isResultTaskStaticCall(expression *ast.Node, method string) bool {
	return a.staticNamespace(expression, method) == "ResultTask"
}

func (a *Analyzer) resultarStaticNamespace(expression *ast.Node, methodName string) string {
	namespace := a.staticNamespace(expression, methodName)
	if namespace == "Result" || namespace == "ResultAsync" || namespace == "ResultTask" {
		return namespace
	}
	return ""
}

// Compatibility helpers are recognized by their imported declarations, including aliases.
func (a *Analyzer) asyncCompatibilityFunctionName(expression *ast.Node) string {
	expression = unwrapExpression(expression)
	if expression == nil {
		return ""
	}
	curried := expression.Kind == ast.KindCallExpression
	if curried {
		call := expression.AsCallExpression()
		if len(call.Arguments.Nodes) != 1 {
			return ""
		}
		expression = unwrapExpression(call.Expression)
		if expression == nil {
			return ""
		}
	}
	symbol := a.checker.GetSymbolAtLocation(expression)
	if symbol != nil && symbol.Flags()&ast.SymbolFlagsAlias != 0 {
		symbol = a.checker.GetAliasedSymbol(symbol)
	}
	if symbol == nil {
		return ""
	}
	name := symbol.Name()
	if name != "gen" && name != "fn" && name != "asyncMap" && name != "asyncAndThen" {
		return ""
	}
	if curried && name != "asyncMap" && name != "asyncAndThen" {
		return ""
	}
	for _, declaration := range symbol.Declarations() {
		if declaration.Kind != ast.KindFunctionDeclaration && declaration.Kind != ast.KindVariableDeclaration {
			continue
		}
		file := ast.GetSourceFileOfNode(declaration)
		if file == nil {
			continue
		}
		path := strings.ReplaceAll(string(file.FileName()), "\\", "/")
		if strings.Contains(path, "/packages/resultar/src/resultar-async/") || strings.Contains(path, "/packages/resultar/dist/") || strings.Contains(path, "/node_modules/resultar/dist/") {
			return name
		}
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

func (a *Analyzer) safeTryBody(node *ast.Node) *ast.Node {
	if node == nil || node.Kind != ast.KindCallExpression {
		return nil
	}
	call := node.AsCallExpression()
	compatibility := a.asyncCompatibilityFunctionName(call.Expression)
	if (a.canonicalExpressionName(call.Expression) != "safeTry" && a.staticNamespace(call.Expression, "gen") != "Result" && a.staticNamespace(call.Expression, "fn") != "Result" && compatibility != "gen" && compatibility != "fn") || len(call.Arguments.Nodes) == 0 {
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

func (a *Analyzer) resultGenOrFnBody(node *ast.Node) *ast.Node {
	if node == nil || node.Kind != ast.KindCallExpression {
		return nil
	}
	call := node.AsCallExpression()
	compatibility := a.asyncCompatibilityFunctionName(call.Expression)
	if (a.staticNamespace(call.Expression, "gen") != "Result" && a.staticNamespace(call.Expression, "fn") != "Result" && compatibility != "gen" && compatibility != "fn") || len(call.Arguments.Nodes) == 0 {
		return nil
	}
	first := unwrapExpression(call.Arguments.Nodes[0])
	if first == nil {
		return nil
	}
	if first.Kind == ast.KindArrowFunction || first.Kind == ast.KindFunctionExpression || first.Kind == ast.KindMethodDeclaration {
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

func (a *Analyzer) resultTaskGenBody(node *ast.Node) *ast.Node {
	if node == nil || node.Kind != ast.KindCallExpression {
		return nil
	}
	call := node.AsCallExpression()
	if (!a.isResultTaskStaticCall(call.Expression, "gen") && !a.isResultTaskStaticCall(call.Expression, "fn")) || len(call.Arguments.Nodes) == 0 {
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
			expression := unwrapTaggedErrorProps(heritageType.AsExpressionWithTypeArguments().Expression)
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

func unwrapTaggedErrorProps(expression *ast.Node) *ast.Node {
	expression = unwrapExpression(expression)
	for expression != nil && expression.Kind == ast.KindCallExpression {
		call := expression.AsCallExpression()
		member := unwrapExpression(call.Expression)
		if member == nil || member.Kind != ast.KindPropertyAccessExpression ||
			member.Name() == nil || member.Name().Text() != "withProps" || len(call.Arguments.Nodes) != 0 {
			break
		}
		expression = unwrapExpression(member.AsPropertyAccessExpression().Expression)
	}
	return expression
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

func (a *Analyzer) operatorCall(node *ast.Node) (string, *checker.Type, *ast.Node, []*ast.Node, bool) {
	if node == nil || node.Kind != ast.KindCallExpression {
		return "", nil, nil, nil, false
	}
	call := node.AsCallExpression()
	method, receiver, nameNode := methodCall(node)
	if method == "" {
		return "", nil, nil, nil, false
	}
	callArgs := call.Arguments.Nodes
	if a.resultarStaticNamespace(call.Expression, method) != "" {
		if len(callArgs) == 0 {
			return "", nil, nil, nil, false
		}
		firstType := a.checker.GetTypeAtLocation(callArgs[0])
		if isResultLikeType(firstType) {
			return method, firstType, nameNode, callArgs[1:], true
		}
		receiverType := a.curriedOperatorReceiverType(node)
		if !isResultLikeType(receiverType) {
			return "", nil, nil, nil, false
		}
		return method, receiverType, nameNode, callArgs, true
	}
	return method, a.checker.GetTypeAtLocation(receiver), nameNode, callArgs, false
}

func (a *Analyzer) curriedOperatorReceiverType(node *ast.Node) *checker.Type {
	if parent := node.Parent; parent != nil && parent.Kind == ast.KindCallExpression {
		parentCall := parent.AsCallExpression()
		if parentCall.Expression == node && len(parentCall.Arguments.Nodes) == 1 {
			if t := a.checker.GetTypeAtLocation(parentCall.Arguments.Nodes[0]); isResultLikeType(t) {
				return t
			}
		}
		parentMethod, parentReceiver, _ := methodCall(parent)
		if parentMethod == "pipe" && len(parentCall.Arguments.Nodes) > 0 && parentCall.Arguments.Nodes[0] == node {
			if t := a.checker.GetTypeAtLocation(parentReceiver); isResultLikeType(t) {
				return t
			}
		}
		if a.canonicalExpressionName(parentCall.Expression) == "pipe" && len(parentCall.Arguments.Nodes) >= 2 && parentCall.Arguments.Nodes[1] == node {
			if t := a.checker.GetTypeAtLocation(parentCall.Arguments.Nodes[0]); isResultLikeType(t) {
				return t
			}
		}
	}
	if contextual := a.checker.GetContextualType(node, 0); contextual != nil {
		if sigs := a.checker.GetCallSignatures(contextual); len(sigs) > 0 && len(sigs[0].Parameters()) > 0 {
			if t := a.checker.GetTypeAtPosition(sigs[0], 0); isResultLikeType(t) {
				return t
			}
		}
	}
	if callType := a.checker.GetTypeAtLocation(node); callType != nil {
		if sigs := a.checker.GetCallSignatures(callType); len(sigs) > 0 && len(sigs[0].Parameters()) > 0 {
			if t := a.checker.GetTypeAtPosition(sigs[0], 0); isResultLikeType(t) {
				return t
			}
		}
	}
	return nil
}

func (a *Analyzer) hasOperatorReplacement(node *ast.Node, receiverType *checker.Type, prop string) bool {
	if receiverType != nil && a.checker.GetPropertyOfType(receiverType, prop) != nil {
		return true
	}
	if node != nil && node.Kind == ast.KindCallExpression {
		expr := unwrapExpression(node.AsCallExpression().Expression)
		if expr != nil && expr.Kind == ast.KindPropertyAccessExpression {
			nsType := a.checker.GetTypeAtLocation(expr.AsPropertyAccessExpression().Expression)
			if nsType != nil && a.checker.GetPropertyOfType(nsType, prop) != nil {
				return true
			}
		}
	}
	return false
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

func (a *Analyzer) isHandledReference(identifier *ast.Node) bool {
	root, parent := referenceChainRoot(identifier)
	if parent != nil && parent.Kind == ast.KindYieldExpression && parent.AsYieldExpression().AsteriskToken != nil && parent.Expression() == root {
		return true
	}
	if parent != nil && parent.Kind == ast.KindReturnStatement && parent.AsReturnStatement().Expression == root {
		return true
	}
	if parent != nil && parent.Kind == ast.KindArrowFunction && parent.Body() == root {
		return true
	}
	if parent != nil && parent.Kind == ast.KindVoidExpression && parent.Expression() == root {
		return true
	}
	if a.isConsumedByReceiverChain(identifier) {
		return true
	}
	if a.isConsumedByResultTaskStaticCall(identifier) {
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

func (a *Analyzer) isConsumedByResultTaskStaticCall(identifier *ast.Node) bool {
	current := identifier
	for parent := current.Parent; parent != nil; parent = current.Parent {
		if isReturnValueContainer(parent, current) || (parent.Kind == ast.KindAwaitExpression && parent.Expression() == current) {
			current = parent
			continue
		}
		if parent.Kind == ast.KindPropertyAccessExpression && parent.AsPropertyAccessExpression().Expression == current {
			current = parent
			continue
		}
		if parent.Kind == ast.KindCallExpression {
			call := parent.AsCallExpression()
			method, _, _ := methodCall(parent)
			if (method == "withPermit" && len(call.Arguments.Nodes) > 0 && (call.Arguments.Nodes[0] == current || (len(call.Arguments.Nodes) > 1 && call.Arguments.Nodes[1] == current))) ||
				(method == "withPermits" && len(call.Arguments.Nodes) > 1 && (call.Arguments.Nodes[1] == current || (len(call.Arguments.Nodes) > 2 && call.Arguments.Nodes[2] == current))) {
				return true
			}
			if call.Expression.Kind == ast.KindCallExpression && len(call.Arguments.Nodes) == 1 && call.Arguments.Nodes[0] == current {
				innerMethod, _, _ := methodCall(call.Expression)
				if innerMethod == "withPermit" || innerMethod == "withPermits" {
					return true
				}
			}
			if len(call.Arguments.Nodes) >= 2 && call.Arguments.Nodes[0] == current && a.canonicalExpressionName(call.Expression) == "pipe" {
				return true
			}
			if len(call.Arguments.Nodes) > 0 && call.Arguments.Nodes[0] == current && a.isResultTaskStaticConsumerCall(call.Expression) {
				return true
			}
			if len(call.Arguments.Nodes) > 1 && (call.Arguments.Nodes[1] == current || (len(call.Arguments.Nodes) > 2 && call.Arguments.Nodes[2] == current)) &&
				(a.isResultTaskStaticCall(call.Expression, "race") ||
					a.isResultTaskStaticCall(call.Expression, "raceFirst") ||
					a.isResultTaskStaticCall(call.Expression, "raceWith") ||
					a.isResultTaskStaticCall(call.Expression, "zip") ||
					a.isResultTaskStaticCall(call.Expression, "when") ||
					a.isResultTaskStaticCall(call.Expression, "unless") ||
					a.isResultTaskStaticCall(call.Expression, "if") ||
					a.isResultTaskStaticCall(call.Expression, "ensuring") ||
					a.isResultTaskStaticCall(call.Expression, "onExit") ||
					a.resultarStaticNamespace(call.Expression, "zip") != "" ||
					a.resultarStaticNamespace(call.Expression, "when") != "" ||
					a.resultarStaticNamespace(call.Expression, "whenResult") != "" ||
					a.resultarStaticNamespace(call.Expression, "unless") != "" ||
					a.resultarStaticNamespace(call.Expression, "unlessResult") != "" ||
					a.resultarStaticNamespace(call.Expression, "if") != "" ||
					a.resultarStaticNamespace(call.Expression, "raceWith") != "") {
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

func (a *Analyzer) isResultTaskStaticConsumerCall(expression *ast.Node) bool {
	if callee := unwrapExpression(expression); callee != nil && callee.Kind == ast.KindCallExpression {
		call := callee.AsCallExpression()
		if len(call.Arguments.Nodes) == 1 && a.isResultTaskStaticCall(call.Expression, "retry") {
			return true
		}
	}
	compatibility := a.asyncCompatibilityFunctionName(expression)
	if compatibility == "asyncMap" || compatibility == "asyncAndThen" {
		return true
	}
	for method := range resultTaskStaticConsumerMethods {
		if a.isResultTaskStaticCall(expression, method) || a.resultarStaticNamespace(expression, method) != "" {
			return true
		}
	}
	for method := range matchStaticConsumerMethods {
		if a.staticNamespace(expression, method) == "Match" {
			return true
		}
	}
	for method := range fiberStaticConsumerMethods {
		if a.staticNamespace(expression, method) == "Fiber" {
			return true
		}
	}
	return false
}

func (a *Analyzer) isResultTaskInstanceRunner(method string, receiver *ast.Node) bool {
	if _, ok := resultTaskInstanceRunnerMethods[method]; !ok || receiver == nil {
		return false
	}
	return everyUnionPart(a.checker.GetTypeAtLocation(receiver), isResultTaskLikeType)
}

func (a *Analyzer) isConsumedByReceiverChain(identifier *ast.Node) bool {
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
			if parent.Parent != nil && parent.Parent.Kind == ast.KindCallExpression && parent.Parent.AsCallExpression().Expression == parent {
				if _, ok := consumerMethods[name]; ok || a.isResultTaskInstanceRunner(name, parent.AsPropertyAccessExpression().Expression) {
					return true
				}
			}
			if name == "pipe" && parent.Parent != nil && parent.Parent.Kind == ast.KindCallExpression && parent.Parent.AsCallExpression().Expression == parent && len(parent.Parent.AsCallExpression().Arguments.Nodes) >= 1 {
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

var diLifetimeRank = map[string]int{
	"value": -1, "transient": 0, "scoped": 1, "singleton": 2,
}

type diRegistration struct {
	name     string
	lifetime string
	deps     []*ast.Node
	depNames []string
}

func diStringArgument(args []*ast.Node, index int) (string, bool) {
	if index >= len(args) {
		return "", false
	}
	node := unwrapExpression(args[index])
	if node == nil || node.Kind != ast.KindStringLiteral {
		return "", false
	}
	return node.AsStringLiteral().Text, true
}

func diDependencyLiterals(args []*ast.Node, index int) ([]*ast.Node, []string) {
	if index >= len(args) {
		return nil, nil
	}
	array := unwrapExpression(args[index])
	if array == nil || array.Kind != ast.KindArrayLiteralExpression {
		return nil, nil
	}
	nodes := make([]*ast.Node, 0)
	names := make([]string, 0)
	for _, element := range array.Elements() {
		element = unwrapExpression(element)
		if element == nil || element.Kind != ast.KindStringLiteral {
			continue
		}
		nodes = append(nodes, element)
		names = append(names, element.AsStringLiteral().Text)
	}
	return nodes, names
}

func diLifetimeOption(args []*ast.Node, index int) string {
	if index >= len(args) {
		return "scoped"
	}
	options := unwrapExpression(args[index])
	if options == nil || options.Kind != ast.KindObjectLiteralExpression {
		return "scoped"
	}
	for _, property := range options.AsObjectLiteralExpression().Properties.Nodes {
		if property.Kind != ast.KindPropertyAssignment || property.Name() == nil || property.Name().Text() != "lifetime" {
			continue
		}
		if value, ok := diStringArgument([]*ast.Node{property.AsPropertyAssignment().Initializer}, 0); ok {
			if _, known := diLifetimeRank[value]; known {
				return value
			}
		}
	}
	return "scoped"
}

func (a *Analyzer) noInvalidLifetime(file *ast.SourceFile) []Finding {
	lifetimes := make(map[string]string)
	registrations := make([]diRegistration, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		method, _, _ := methodCall(node)
		if method == "" {
			return
		}
		args := node.AsCallExpression().Arguments.Nodes
		switch method {
		case "singleton", "scoped", "transient":
			name, ok := diStringArgument(args, 0)
			if !ok {
				return
			}
			nodes, names := diDependencyLiterals(args, 1)
			lifetimes[name] = method
			registrations = append(registrations, diRegistration{name: name, lifetime: method, deps: nodes, depNames: names})
		case "task":
			name, ok := diStringArgument(args, 0)
			if !ok {
				return
			}
			lifetime := diLifetimeOption(args, 3)
			nodes, names := diDependencyLiterals(args, 1)
			lifetimes[name] = lifetime
			registrations = append(registrations, diRegistration{name: name, lifetime: lifetime, deps: nodes, depNames: names})
		case "resource":
			name, ok := diStringArgument(args, 0)
			if !ok {
				return
			}
			lifetime := diLifetimeOption(args, 2)
			nodes, names := diDependencyLiterals(args, 1)
			lifetimes[name] = lifetime
			registrations = append(registrations, diRegistration{name: name, lifetime: lifetime, deps: nodes, depNames: names})
		case "value":
			name, ok := diStringArgument(args, 0)
			if !ok {
				return
			}
			lifetimes[name] = "value"
		}
	})
	findings := make([]Finding, 0)
	for _, registration := range registrations {
		requesterRank, ok := diLifetimeRank[registration.lifetime]
		if !ok {
			continue
		}
		for index, depName := range registration.depNames {
			depLifetime, known := lifetimes[depName]
			if !known || depLifetime == "value" {
				continue
			}
			if depRank, ok := diLifetimeRank[depLifetime]; !ok || requesterRank <= depRank {
				continue
			}
			findings = append(findings, newFinding(file, registration.deps[index], "no-invalid-lifetime", a.options.NoInvalidLifetime,
				fmt.Sprintf("Lifetime violation: %s %q cannot depend on shorter-lived %s %q. Align their lifetimes or pass request data to a service method.", registration.lifetime, registration.name, depLifetime, depName), ""))
		}
	}
	return findings
}

func (a *Analyzer) acquiresScopeOwner(node *ast.Node) bool {
	for parent := node.Parent; parent != nil; parent = parent.Parent {
		if parent.Kind == ast.KindCallExpression {
			call := parent.AsCallExpression()
			if a.isResultTaskStaticCall(call.Expression, "scoped") {
				return true
			}
			method, _, _ := methodCall(parent)
			if method == "task" || method == "resource" {
				return true
			}
			if a.isResultTaskStaticCall(call.Expression, "fn") || method == "pipe" || a.canonicalExpressionName(call.Expression) == "pipe" {
				for _, arg := range call.Arguments.Nodes {
					if a.isResultTaskStaticCall(arg, "scoped") {
						return true
					}
				}
			}
		}
		if (parent.Kind == ast.KindPropertyAssignment || parent.Kind == ast.KindMethodDeclaration) && parent.Name() != nil {
			switch parent.Name().Text() {
			case "make", "acquire", "release":
				return true
			}
		}
	}
	return false
}

func (a *Analyzer) noUnscopedAcquireRelease(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		body := a.resultTaskGenBody(node)
		if body == nil {
			return
		}
		visitFunctionBody(body, func(bodyNode *ast.Node) {
			if bodyNode.Kind != ast.KindYieldExpression || bodyNode.AsYieldExpression().AsteriskToken == nil {
				return
			}
			yielded := unwrapExpression(bodyNode.AsYieldExpression().Expression)
			if yielded == nil || yielded.Kind != ast.KindCallExpression {
				return
			}
			acquire := yielded.AsCallExpression().Expression
			if !a.isResultTaskStaticCall(acquire, "acquireRelease") && !a.isResultTaskStaticCall(acquire, "acquireDisposable") {
				return
			}
			if a.acquiresScopeOwner(yielded) {
				return
			}
			findings = append(findings, newFinding(file, yielded, "no-unscoped-acquire-release", a.options.NoUnscopedAcquireRelease,
				"Resource acquisition registers cleanup in the current scope. Ensure an enclosing `ResultTask.scoped(...)` closes it, or record the owning scope with a suppression comment.", ""))
		})
	})
	return findings
}

func (a *Analyzer) noResultInTaskGen(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		body := a.resultTaskGenBody(node)
		isResultGen := false
		if body == nil {
			body = a.resultGenOrFnBody(node)
			isResultGen = body != nil
			if isResultGen && !a.generatorHasNestedResultSuccess(node) {
				return
			}
		}
		if body == nil {
			return
		}
		visitFunctionBody(body, func(bodyNode *ast.Node) {
			if bodyNode.Kind != ast.KindReturnStatement {
				return
			}
			returned := bodyNode.AsReturnStatement().Expression
			if returned == nil {
				return
			}
			if !a.isOkConstructorCall(returned) && !a.isErrConstructorCall(returned) && !isResultLikeType(a.checker.GetTypeAtLocation(returned)) {
				return
			}
			message := "Return the plain success value from `ResultTask.gen`; use `yield*` for tasks and services so failures short-circuit instead of nesting a Result in the success channel."
			if isResultGen {
				message = "Return the plain success value from `Result.gen` or `Result.fn`; use `yield*` for Resultar values so failures short-circuit instead of nesting a Result in the success channel."
			}
			findings = append(findings, newFinding(file, returned, "no-result-in-task-gen", a.options.NoResultInTaskGen, message, ""))
		})
	})
	return findings
}

func (a *Analyzer) generatorHasNestedResultSuccess(node *ast.Node) bool {
	type_ := a.checker.GetTypeAtLocation(node)
	// Legacy Result.gen signatures flatten returned Results; report only proven nesting.
	if type_ == nil {
		return false
	}
	if a.staticNamespace(node.AsCallExpression().Expression, "fn") == "Result" {
		for _, signature := range a.checker.GetCallSignatures(type_) {
			if hasNestedResultSuccess(a.checker, a.checker.GetReturnTypeOfSignature(signature)) {
				return true
			}
		}
		return false
	}
	return hasNestedResultSuccess(a.checker, type_)
}

func hasNestedResultSuccess(c *checker.Checker, type_ *checker.Type) bool {
	if type_ == nil {
		return false
	}
	if type_.Flags()&checker.TypeFlagsUnionOrIntersection != 0 {
		for _, part := range type_.Types() {
			if hasNestedResultSuccess(c, part) {
				return true
			}
		}
		return false
	}
	if !isResultLikeType(type_) {
		return false
	}
	args := typeArguments(c, type_)
	return len(args) > 0 && isResultLikeType(args[0])
}

func (a *Analyzer) noAwaitInResultTaskGen(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		body := a.resultTaskGenBody(node)
		if body == nil {
			return
		}
		visitFunctionBody(body, func(bodyNode *ast.Node) {
			if bodyNode.Kind == ast.KindAwaitExpression {
				finding := newFinding(file, bodyNode, "no-await-in-result-task-gen", a.options.NoAwaitInResultTaskGen,
					"Do not use `await` inside `ResultTask.gen`. Use `yield*` for tasks and services so composition stays lazy and typed.", "")
				if isResultLikeType(a.checker.GetTypeAtLocation(bodyNode.Expression())) {
					finding.Fixes = []Fix{replaceTokenFix(file, bodyNode, "Use yield* for this ResultTask value", "yield*")}
				}
				findings = append(findings, finding)
			}
		})
	})
	return findings
}

func (a *Analyzer) noThrowInTaskSync(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		if node.Kind != ast.KindCallExpression || !a.isResultTaskStaticCall(node.AsCallExpression().Expression, "sync") {
			return
		}
		args := node.AsCallExpression().Arguments.Nodes
		if len(args) == 0 {
			return
		}
		callback := unwrapExpression(args[0])
		if callback == nil || (callback.Kind != ast.KindArrowFunction && callback.Kind != ast.KindFunctionExpression) {
			return
		}
		visitFunctionBody(callback, func(bodyNode *ast.Node) {
			if bodyNode.Kind != ast.KindThrowStatement {
				return
			}
			findings = append(findings, newFinding(file, bodyNode, "no-throw-in-task-sync", a.options.NoThrowInTaskSync,
				"Throwing inside `ResultTask.sync` creates a defect (`Die`), not a typed failure. Use `ResultTask.try` with a catch mapper so failures stay in the typed error channel.", ""))
		})
	})
	return findings
}

func hasOnlyNeverErrors(c *checker.Checker, t *checker.Type) bool {
	errorTypes := resultErrorTypes(c, t)
	if len(errorTypes) == 0 {
		return false
	}
	for _, errorType := range errorTypes {
		if errorType == nil || errorType.Flags()&checker.TypeFlagsNever == 0 {
			return false
		}
	}
	return true
}

func (a *Analyzer) preferOrElseSucceed(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		method, receiverType, nameNode, arguments, isStatic := a.operatorCall(node)
		if method != "orElse" && method != "catchAll" {
			return
		}
		if !isResultLikeType(receiverType) || hasOnlyNeverErrors(a.checker, receiverType) || !a.hasOperatorReplacement(node, receiverType, "orElseSucceed") {
			return
		}
		if len(arguments) == 0 || !isArgumentlessFunction(arguments[0]) {
			return
		}
		returned := getReturnedExpressions(arguments[0])
		if len(returned) == 0 {
			return
		}
		for _, expr := range returned {
			unwrapped := unwrapExpression(expr)
			if !a.isOkConstructorCall(unwrapped) || len(unwrapped.AsCallExpression().Arguments.Nodes) != 1 {
				return
			}
		}
		finding := newFinding(file, nameNode, "prefer-or-else-succeed", a.options.PreferOrElseSucceed,
			fmt.Sprintf("`%s` only wraps a fallback value in Ok without inspecting the error. Use `orElseSucceed` for infallible fallback recovery.", method), "")
		if len(returned) == 1 && !isStatic {
			unwrapped := unwrapExpression(returned[0])
			argNode := unwrapped.AsCallExpression().Arguments.Nodes[0]
			argText := strings.TrimSpace(nodeSourceText(file, argNode))
			finding.Fixes = []Fix{replaceSpanFix(file, nameNode, node, "Replace with orElseSucceed", fmt.Sprintf("orElseSucceed(() => %s)", argText))}
		}
		findings = append(findings, finding)
	})
	return findings
}

func singleParameterName(callback *ast.Node) string {
	callback = unwrapExpression(callback)
	if callback == nil || (callback.Kind != ast.KindArrowFunction && callback.Kind != ast.KindFunctionExpression) {
		return ""
	}
	params := callback.Parameters()
	if len(params) != 1 || params[0].Name() == nil || params[0].Name().Kind != ast.KindIdentifier {
		return ""
	}
	return params[0].Name().Text()
}

func isIdentifierNamed(node *ast.Node, name string) bool {
	node = unwrapExpression(node)
	return node != nil && node.Kind == ast.KindIdentifier && node.Text() == name
}

func (a *Analyzer) isOkWrappingIdentifier(node *ast.Node, name string) bool {
	node = unwrapExpression(node)
	if !a.isOkConstructorCall(node) {
		return false
	}
	args := node.AsCallExpression().Arguments.Nodes
	return len(args) == 1 && isIdentifierNamed(args[0], name)
}

func (a *Analyzer) isErrWrappingIdentifier(node *ast.Node, name string) bool {
	node = unwrapExpression(node)
	if !a.isErrConstructorCall(node) {
		return false
	}
	args := node.AsCallExpression().Arguments.Nodes
	return len(args) == 1 && isIdentifierNamed(args[0], name)
}

func (a *Analyzer) preferTap(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		method, receiverType, nameNode, arguments, isStatic := a.operatorCall(node)
		if method != "map" && method != "andThen" && method != "flatMap" {
			return
		}
		if !isResultLikeType(receiverType) {
			return
		}
		replacement := "tap"
		if isResultarSyncType(receiverType) && (!isStatic && a.checker.GetPropertyOfType(receiverType, "inspect") != nil || isStatic && a.hasOperatorReplacement(node, nil, "inspect")) {
			replacement = "inspect"
		} else if !a.hasOperatorReplacement(node, receiverType, "tap") {
			return
		}
		if len(arguments) == 0 {
			return
		}
		callback := unwrapExpression(arguments[0])
		paramName := singleParameterName(callback)
		if paramName == "" || callback.Body() == nil || callback.Body().Kind != ast.KindBlock {
			return
		}
		statements := callback.Body().Statements()
		if len(statements) < 2 {
			return
		}
		returned := getReturnedExpressions(callback)
		if len(returned) == 0 {
			return
		}
		for _, expr := range returned {
			if method == "map" {
				if !isIdentifierNamed(expr, paramName) {
					return
				}
			} else {
				if !a.isOkWrappingIdentifier(expr, paramName) {
					return
				}
			}
		}
		finding := newFinding(file, nameNode, "prefer-tap", a.options.PreferTap,
			fmt.Sprintf("`%s` performs side effects and returns the original input unchanged. Use `%s` to express side-effect-only observation.", method, replacement), "")
		if method == "map" {
			finding.Fixes = []Fix{renameFix(file, nameNode, fmt.Sprintf("Replace %s with %s", method, replacement), replacement)}
		}
		findings = append(findings, finding)
	})
	return findings
}

func (a *Analyzer) preferTapError(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		method, receiverType, nameNode, arguments, isStatic := a.operatorCall(node)
		if method != "orElse" && method != "catchAll" && method != "mapErr" && method != "mapError" {
			return
		}
		if !isResultLikeType(receiverType) || hasOnlyNeverErrors(a.checker, receiverType) {
			return
		}
		replacement := "tapError"
		if isResultarSyncType(receiverType) && (!isStatic && a.checker.GetPropertyOfType(receiverType, "inspectError") != nil || isStatic && a.hasOperatorReplacement(node, nil, "inspectError")) {
			replacement = "inspectError"
		} else if !a.hasOperatorReplacement(node, receiverType, "tapError") {
			return
		}
		if len(arguments) == 0 {
			return
		}
		callback := unwrapExpression(arguments[0])
		paramName := singleParameterName(callback)
		if paramName == "" || callback.Body() == nil || callback.Body().Kind != ast.KindBlock {
			return
		}
		statements := callback.Body().Statements()
		if len(statements) < 2 {
			return
		}
		returned := getReturnedExpressions(callback)
		if len(returned) == 0 {
			return
		}
		for _, expr := range returned {
			if method == "mapErr" || method == "mapError" {
				if !isIdentifierNamed(expr, paramName) {
					return
				}
			} else {
				if !a.isErrWrappingIdentifier(expr, paramName) {
					return
				}
			}
		}
		finding := newFinding(file, nameNode, "prefer-tap-error", a.options.PreferTapError,
			fmt.Sprintf("`%s` performs side effects and forwards the original error unchanged. Use `%s` to express error observation.", method, replacement), "")
		if method == "mapErr" || method == "mapError" {
			finding.Fixes = []Fix{renameFix(file, nameNode, fmt.Sprintf("Replace %s with %s", method, replacement), replacement)}
		}
		findings = append(findings, finding)
	})
	return findings
}

func isUndefinedOrVoidExpression(node *ast.Node) bool {
	node = unwrapExpression(node)
	if node == nil {
		return false
	}
	if node.Kind == ast.KindIdentifier && node.Text() == "undefined" {
		return true
	}
	return node.Kind == ast.KindVoidExpression
}

func (a *Analyzer) preferAsVoid(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		method, receiverType, nameNode, arguments, isStatic := a.operatorCall(node)
		if method != "map" {
			return
		}
		if !isResultLikeType(receiverType) || !a.hasOperatorReplacement(node, receiverType, "asVoid") {
			return
		}
		if len(arguments) != 1 {
			return
		}
		callback := unwrapExpression(arguments[0])
		if callback == nil || (callback.Kind != ast.KindArrowFunction && callback.Kind != ast.KindFunctionExpression) || callback.Body() == nil {
			return
		}
		if callback.Body().Kind == ast.KindBlock && len(callback.Body().Statements()) != 1 {
			return
		}
		returned := getReturnedExpressions(callback)
		if len(returned) != 1 || !isUndefinedOrVoidExpression(returned[0]) {
			return
		}
		finding := newFinding(file, nameNode, "prefer-as-void", a.options.PreferAsVoid,
			"`map(() => undefined)` discards the success value manually. Use `asVoid()` to express void mapping.", "")
		if !isStatic {
			finding.Fixes = []Fix{replaceSpanFix(file, nameNode, node, "Replace map with asVoid()", "asVoid()")}
		}
		findings = append(findings, finding)
	})
	return findings
}

func (a *Analyzer) isFilterOrElseCallback(callback *ast.Node) bool {
	paramName := singleParameterName(callback)
	if paramName == "" || callback.Body() == nil {
		return false
	}
	body := unwrapExpression(callback.Body())
	if body.Kind == ast.KindConditionalExpression {
		cond := body.AsConditionalExpression()
		return (a.isOkWrappingIdentifier(cond.WhenTrue, paramName) && a.isErrConstructorCall(cond.WhenFalse)) ||
			(a.isErrConstructorCall(cond.WhenTrue) && a.isOkWrappingIdentifier(cond.WhenFalse, paramName))
	}
	if body.Kind != ast.KindBlock {
		return false
	}
	stmts := body.Statements()
	if len(stmts) != 2 || stmts[0].Kind != ast.KindIfStatement || stmts[1].Kind != ast.KindReturnStatement {
		return false
	}
	ifStmt := stmts[0].AsIfStatement()
	if ifStmt.ElseStatement != nil {
		return false
	}
	var branchReturn *ast.Node
	if ifStmt.ThenStatement.Kind == ast.KindReturnStatement {
		branchReturn = ifStmt.ThenStatement.AsReturnStatement().Expression
	} else if ifStmt.ThenStatement.Kind == ast.KindBlock && len(ifStmt.ThenStatement.Statements()) == 1 && ifStmt.ThenStatement.Statements()[0].Kind == ast.KindReturnStatement {
		branchReturn = ifStmt.ThenStatement.Statements()[0].AsReturnStatement().Expression
	}
	fallthroughReturn := stmts[1].AsReturnStatement().Expression
	if branchReturn == nil || fallthroughReturn == nil {
		return false
	}
	return (a.isErrConstructorCall(branchReturn) && a.isOkWrappingIdentifier(fallthroughReturn, paramName)) ||
		(a.isOkWrappingIdentifier(branchReturn, paramName) && a.isErrConstructorCall(fallthroughReturn))
}

func (a *Analyzer) preferFilterOrElse(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		method, receiverType, nameNode, arguments, _ := a.operatorCall(node)
		if method != "andThen" && method != "flatMap" {
			return
		}
		if !isResultLikeType(receiverType) || !a.hasOperatorReplacement(node, receiverType, "filterOrElse") {
			return
		}
		if len(arguments) != 1 || !a.isFilterOrElseCallback(arguments[0]) {
			return
		}
		findings = append(findings, newFinding(file, nameNode, "prefer-filter-or-else", a.options.PreferFilterOrElse,
			fmt.Sprintf("`%s` only validates the input and returns it unchanged or fails. Use `filterOrElse` to express predicate validation.", method), ""))
	})
	return findings
}

func (a *Analyzer) isSymbolDisposeCall(node *ast.Node, paramName string) bool {
	node = unwrapExpression(node)
	if node == nil {
		return false
	}
	if node.Kind == ast.KindAwaitExpression {
		return a.isSymbolDisposeCall(node.Expression(), paramName)
	}
	if node.Kind == ast.KindBlock {
		if len(node.Statements()) != 1 {
			return false
		}
		stmt := node.Statements()[0]
		if stmt.Kind == ast.KindExpressionStatement {
			return a.isSymbolDisposeCall(stmt.AsExpressionStatement().Expression, paramName)
		}
		if stmt.Kind == ast.KindReturnStatement {
			return a.isSymbolDisposeCall(stmt.AsReturnStatement().Expression, paramName)
		}
		return false
	}
	if node.Kind != ast.KindCallExpression {
		return false
	}
	call := node.AsCallExpression()
	if (a.isResultTaskStaticCall(call.Expression, "sync") ||
		a.isResultTaskStaticCall(call.Expression, "try") ||
		a.isResultTaskStaticCall(call.Expression, "tryPromise")) && len(call.Arguments.Nodes) >= 1 {
		innerFn := unwrapExpression(call.Arguments.Nodes[0])
		if innerFn != nil && (innerFn.Kind == ast.KindArrowFunction || innerFn.Kind == ast.KindFunctionExpression) && len(innerFn.Parameters()) == 0 {
			return a.isSymbolDisposeCall(innerFn.Body(), paramName)
		}
	}
	if a.isResultTaskStaticCall(call.Expression, "fromPromise") && len(call.Arguments.Nodes) == 1 {
		return a.isSymbolDisposeCall(call.Arguments.Nodes[0], paramName)
	}
	callee := unwrapExpression(call.Expression)
	if callee == nil || callee.Kind != ast.KindElementAccessExpression {
		return false
	}
	elem := callee.AsElementAccessExpression()
	if !isIdentifierNamed(elem.Expression, paramName) {
		return false
	}
	arg := unwrapExpression(elem.ArgumentExpression)
	if arg == nil || arg.Kind != ast.KindPropertyAccessExpression || arg.Name() == nil {
		return false
	}
	prop := arg.Name().Text()
	return expressionName(arg.AsPropertyAccessExpression().Expression) == "Symbol" && (prop == "dispose" || prop == "asyncDispose")
}

func extractAcquireReleaseCallback(args []*ast.Node) *ast.Node {
	if len(args) >= 2 {
		return unwrapExpression(args[1])
	}
	if len(args) == 1 {
		first := unwrapExpression(args[0])
		if first != nil && first.Kind == ast.KindObjectLiteralExpression {
			for _, prop := range first.AsObjectLiteralExpression().Properties.Nodes {
				if prop.Name() == nil || prop.Name().Text() != "release" {
					continue
				}
				if prop.Kind == ast.KindPropertyAssignment {
					return unwrapExpression(prop.AsPropertyAssignment().Initializer)
				}
				if prop.Kind == ast.KindMethodDeclaration {
					return prop
				}
			}
		}
	}
	return nil
}

func firstParameterName(callback *ast.Node) string {
	callback = unwrapExpression(callback)
	if callback == nil || (callback.Kind != ast.KindArrowFunction && callback.Kind != ast.KindFunctionExpression && callback.Kind != ast.KindMethodDeclaration) {
		return ""
	}
	params := callback.Parameters()
	if len(params) == 0 || len(params) > 2 || params[0].Name() == nil || params[0].Name().Kind != ast.KindIdentifier {
		return ""
	}
	return params[0].Name().Text()
}

func (a *Analyzer) preferAcquireDisposable(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		if node.Kind != ast.KindCallExpression {
			return
		}
		call := node.AsCallExpression()
		if !a.isResultTaskStaticCall(call.Expression, "acquireRelease") {
			return
		}
		release := extractAcquireReleaseCallback(call.Arguments.Nodes)
		paramName := firstParameterName(release)
		if paramName == "" || release.Body() == nil || !a.isSymbolDisposeCall(release.Body(), paramName) {
			return
		}
		findings = append(findings, newFinding(file, call.Expression, "prefer-acquire-disposable", a.options.PreferAcquireDisposable,
			"`ResultTask.acquireRelease` only invokes `[Symbol.dispose]` or `[Symbol.asyncDispose]` in its release callback. Use `ResultTask.acquireDisposable` instead.", ""))
	})
	return findings
}

func (a *Analyzer) noFnIife(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		if node.Kind != ast.KindCallExpression {
			return
		}
		callee := unwrapExpression(node.AsCallExpression().Expression)
		if callee == nil || callee.Kind != ast.KindCallExpression {
			return
		}
		innerCallee := callee.AsCallExpression().Expression
		if a.asyncCompatibilityFunctionName(innerCallee) == "fn" {
			findings = append(findings, newFinding(file, node, "no-fn-iife", a.options.NoFnIife,
				"`fn(...)` from `resultar/async` returns a reusable function. Use its `gen(...)` helper for immediate generator composition.", ""))
			return
		}
		namespace := a.staticNamespace(innerCallee, "fn")
		if namespace != "Result" && namespace != "ResultTask" {
			return
		}
		findings = append(findings, newFinding(file, node, "no-fn-iife", a.options.NoFnIife,
			fmt.Sprintf("`%s.fn(...)` returns a reusable function and should not be invoked immediately as an IIFE. Use `%s.gen(...)` for immediate generator composition.", namespace, namespace), ""))
	})
	return findings
}

func isTerminalResultYieldType(c *checker.Checker, t *checker.Type) bool {
	if t == nil {
		return false
	}
	if t.Flags()&checker.TypeFlagsUnionOrIntersection != 0 {
		parts := t.Types()
		if len(parts) == 0 {
			return false
		}
		for _, part := range parts {
			if !isTerminalResultYieldType(c, part) {
				return false
			}
		}
		return true
	}
	if !isResultLikeType(t) {
		return false
	}
	args := typeArguments(c, t)
	return len(args) >= 1 && args[0] != nil && args[0].Flags()&checker.TypeFlagsNever != 0
}

func (a *Analyzer) requireReturnYieldStar(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		body := a.resultTaskGenBody(node)
		if body == nil {
			body = a.safeTryBody(node)
		}
		if body == nil {
			return
		}
		visitFunctionBody(body, func(bodyNode *ast.Node) {
			if bodyNode.Kind != ast.KindYieldExpression {
				return
			}
			yield := bodyNode.AsYieldExpression()
			if yield.AsteriskToken == nil || yield.Expression == nil {
				return
			}
			if bodyNode.Parent == nil || bodyNode.Parent.Kind != ast.KindExpressionStatement {
				return
			}
			yielded := unwrapExpression(yield.Expression)
			isTerminal := a.isErrConstructorCall(yielded) ||
				(yielded != nil && yielded.Kind == ast.KindCallExpression && a.isResultTaskStaticCall(yielded.AsCallExpression().Expression, "die")) ||
				isTerminalResultYieldType(a.checker, a.checker.GetTypeAtLocation(yielded))
			if !isTerminal {
				return
			}
			finding := newFinding(file, bodyNode, "require-return-yield-star", a.options.RequireReturnYieldStar,
				"Use `return yield*` for terminal error or defect yields so TypeScript narrows control flow after short-circuiting.", "")
			finding.Fixes = []Fix{insertFix(file, bodyNode, "Add return before yield*", "return ")}
			findings = append(findings, finding)
		})
	})
	return findings
}

func (a *Analyzer) noUnnecessaryErrWrapInGen(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		isTaskGen := false
		body := a.resultTaskGenBody(node)
		if body != nil {
			isTaskGen = true
		} else {
			body = a.safeTryBody(node)
		}
		if body == nil {
			return
		}
		visitFunctionBody(body, func(bodyNode *ast.Node) {
			if bodyNode.Kind != ast.KindYieldExpression {
				return
			}
			yield := bodyNode.AsYieldExpression()
			if yield.AsteriskToken == nil || yield.Expression == nil {
				return
			}
			yielded := unwrapExpression(yield.Expression)
			if yielded == nil || yielded.Kind != ast.KindCallExpression {
				return
			}
			call := yielded.AsCallExpression()
			if isTaskGen && a.isResultTaskStaticCall(call.Expression, "fromResult") && len(call.Arguments.Nodes) == 1 {
				findings = append(findings, newFinding(file, yielded, "no-unnecessary-err-wrap-in-gen", a.options.NoUnnecessaryErrWrapInGen,
					"`Result` values are directly yieldable inside `ResultTask.gen`; yield the Result directly instead of wrapping with `ResultTask.fromResult(...)`.", ""))
				return
			}
			if !a.isErrConstructorCall(yielded) || len(call.Arguments.Nodes) != 1 {
				return
			}
			arg := unwrapExpression(call.Arguments.Nodes[0])
			if arg == nil || arg.Kind != ast.KindNewExpression {
				return
			}
			ctor := arg.Expression()
			ctorType := a.checker.GetTypeAtLocation(ctor)
			if ctorType == nil {
				return
			}
			helperName := "err"
			if isTaskGen && a.checker.GetPropertyOfType(ctorType, "taskErr") != nil {
				helperName = "taskErr"
			} else if a.checker.GetPropertyOfType(ctorType, "err") == nil {
				return
			}
			ctorName := expressionName(ctor)
			if ctorName == "" {
				ctorName = "TaggedError"
			}
			findings = append(findings, newFinding(file, yielded, "no-unnecessary-err-wrap-in-gen", a.options.NoUnnecessaryErrWrapInGen,
				fmt.Sprintf("Prefer `%s.%s(...)` over wrapping `new %s(...)` in an external error constructor inside a generator.", ctorName, helperName, ctorName), ""))
		})
	})
	return findings
}

func (a *Analyzer) unnecessaryPipe(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		if node.Kind != ast.KindCallExpression {
			return
		}
		call := node.AsCallExpression()
		method, receiver, nameNode := methodCall(node)
		if method == "pipe" {
			if len(call.Arguments.Nodes) == 0 && isResultLikeType(a.checker.GetTypeAtLocation(receiver)) {
				findings = append(findings, newFinding(file, nameNode, "unnecessary-pipe", a.options.UnnecessaryPipe,
					"`.pipe()` without arguments is a no-op; use the receiver directly.", ""))
			}
			return
		}
		if a.canonicalExpressionName(call.Expression) == "pipe" && len(call.Arguments.Nodes) == 1 {
			arg := call.Arguments.Nodes[0]
			finding := newFinding(file, node, "unnecessary-pipe", a.options.UnnecessaryPipe,
				"`pipe` with a single argument is a no-op; use the value directly.", "")
			argText := strings.TrimSpace(nodeSourceText(file, arg))
			finding.Fixes = []Fix{replaceSpanFix(file, node, node, "Unwrap single-argument pipe", argText)}
			findings = append(findings, finding)
		}
	})
	return findings
}

var taskRunnerMethods = map[string]struct{}{
	"runExit": {}, "runFork": {}, "runPromise": {}, "runResult": {}, "toResultAsync": {},
}

func (a *Analyzer) noRunInsideGen(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		body := a.resultTaskGenBody(node)
		if body == nil {
			body = a.safeTryBody(node)
		}
		if body == nil {
			return
		}
		visitFunctionBody(body, func(bodyNode *ast.Node) {
			if bodyNode.Kind != ast.KindCallExpression {
				return
			}
			call := bodyNode.AsCallExpression()
			for runner := range taskRunnerMethods {
				if a.isResultTaskStaticCall(call.Expression, runner) {
					findings = append(findings, newFinding(file, call.Expression, "no-run-inside-gen", a.options.NoRunInsideGen,
						fmt.Sprintf("Do not execute `ResultTask.%s` inside a Resultar generator. Compose with `yield*` instead so errors, requirements, and scopes propagate through the generator.", runner), ""))
					return
				}
			}
			if a.staticNamespace(call.Expression, "fromTask") == "ResultAsync" {
				findings = append(findings, newFinding(file, call.Expression, "no-run-inside-gen", a.options.NoRunInsideGen,
					"Do not execute `ResultAsync.fromTask` inside a Resultar generator. Compose with `yield*` instead so errors, requirements, and scopes propagate through the generator.", ""))
				return
			}
			calleeName := a.canonicalExpressionName(call.Expression)
			if call.Expression.Kind != ast.KindPropertyAccessExpression && (calleeName == "runPromise" || calleeName == "runSync") {
				findings = append(findings, newFinding(file, call.Expression, "no-run-inside-gen", a.options.NoRunInsideGen,
					"Do not execute a runner inside a Resultar generator (`Result.gen`, `ResultTask.gen`). Compose with `yield*` instead so errors and requirements propagate through the generator.", ""))
				return
			}
			method, receiver, nameNode := methodCall(bodyNode)
			if a.isResultTaskInstanceRunner(method, receiver) || (method == "toResultAsync" && isResultTaskLikeType(a.checker.GetTypeAtLocation(receiver))) {
				findings = append(findings, newFinding(file, nameNode, "no-run-inside-gen", a.options.NoRunInsideGen,
					fmt.Sprintf("Do not call `%s` inside a Resultar generator. Compose with `yield*` instead so errors, requirements, and scopes propagate through the generator.", method), ""))
				return
			}
			if (method == "_unsafeUnwrap" || method == "unwrapOrThrow") && isResultLikeType(a.checker.GetTypeAtLocation(receiver)) {
				findings = append(findings, newFinding(file, nameNode, "no-run-inside-gen", a.options.NoRunInsideGen,
					fmt.Sprintf("Do not call `%s` inside a Resultar generator. Use `yield*` to unwrap values safely without throwing.", method), ""))
			}
		})
	})
	return findings
}
