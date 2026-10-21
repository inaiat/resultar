package analyzer

import (
	"fmt"
	"strconv"
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
	"fromThrowableAsync": {}, "try": {}, "tryAsync": {}, "tryCatchAsync": {}, "tryCatch": {}, "tryPromise": {}, "tryResultAsync": {},
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

type cachedNodeTargets struct {
	targets []*ast.Node
	ok      bool
}

type fileMutationSummary struct {
	mutatedSymbols  map[*ast.Symbol]bool
	assignedSymbols map[*ast.Symbol][]*ast.Node
	mutatedProps    map[string][]*ast.Node
	calls           []*ast.Node
}

type analyzerCache struct {
	hasResultarPkg             *bool
	programClassesComputed     bool
	programClasses             []*ast.Node
	callbackReceiverReassigned map[*ast.Node]bool
	staticNamespace            map[*ast.Node]string
	staticMember               map[*ast.Node][2]string
	callbackKind               map[*ast.Node]resultCallbackKind
	identityCallback           map[*ast.Node]bool
	callbackTargets            map[*ast.Node]cachedNodeTargets
	fileMutations              map[*ast.SourceFile]*fileMutationSummary
}

func newAnalyzerCache() *analyzerCache {
	return &analyzerCache{
		callbackReceiverReassigned: make(map[*ast.Node]bool),
		staticNamespace:            make(map[*ast.Node]string),
		staticMember:               make(map[*ast.Node][2]string),
		callbackKind:               make(map[*ast.Node]resultCallbackKind),
		identityCallback:           make(map[*ast.Node]bool),
		callbackTargets:            make(map[*ast.Node]cachedNodeTargets),
		fileMutations:              make(map[*ast.SourceFile]*fileMutationSummary),
	}
}

func (a *Analyzer) getCache() *analyzerCache {
	if a.cache == nil {
		a.cache = newAnalyzerCache()
	}
	return a.cache
}

func (a *Analyzer) getProgramClasses() []*ast.Node {
	cache := a.getCache()
	if cache.programClassesComputed {
		return cache.programClasses
	}
	cache.programClassesComputed = true
	if a.program == nil {
		return nil
	}
	for _, sf := range a.program.SourceFiles() {
		if isImmutableDeclarationOrPackageFile(sf) {
			continue
		}
		visit(sf.AsNode(), func(node *ast.Node) {
			if node != nil && (node.Kind == ast.KindClassDeclaration || node.Kind == ast.KindClassExpression) {
				cache.programClasses = append(cache.programClasses, node)
			}
		})
	}
	return cache.programClasses
}

func isResultarPackageFile(file *ast.SourceFile) bool {
	if file == nil {
		return false
	}
	path := strings.ReplaceAll(string(file.FileName()), "\\", "/")
	return strings.Contains(path, "/packages/resultar/") || strings.Contains(path, "/node_modules/resultar/")
}

func isImmutableDeclarationOrPackageFile(file *ast.SourceFile) bool {
	return file == nil || file.IsDeclarationFile || isResultarPackageFile(file)
}

func (a *Analyzer) getFileMutationSummary(file *ast.SourceFile) *fileMutationSummary {
	if isImmutableDeclarationOrPackageFile(file) {
		return nil
	}
	cache := a.getCache()
	if summary, ok := cache.fileMutations[file]; ok {
		return summary
	}
	summary := &fileMutationSummary{
		mutatedSymbols:  make(map[*ast.Symbol]bool),
		assignedSymbols: make(map[*ast.Symbol][]*ast.Node),
		mutatedProps:    make(map[string][]*ast.Node),
	}
	markMutated := func(target *ast.Node) {
		if target == nil {
			return
		}
		visit(target, func(n *ast.Node) {
			if n == nil {
				return
			}
			if n.Kind == ast.KindShorthandPropertyAssignment {
				if sym := a.resolveAliasedSymbol(a.checker.GetShorthandAssignmentValueSymbol(n)); sym != nil {
					summary.mutatedSymbols[sym] = true
				}
				if sym := a.resolveSymbolAtNode(n.Name()); sym != nil {
					summary.mutatedSymbols[sym] = true
				}
				return
			}
			if n.Kind != ast.KindIdentifier && n.Kind != ast.KindPropertyAccessExpression && n.Kind != ast.KindElementAccessExpression {
				return
			}
			if sym := a.resolveSymbolAtNode(n); sym != nil {
				summary.mutatedSymbols[sym] = true
			}
		})
	}
	addMutatedProp := func(prop string, recv *ast.Node) {
		if recv == nil {
			return
		}
		summary.mutatedProps[prop] = append(summary.mutatedProps[prop], recv)
	}
	markMutatedProps := func(target *ast.Node) {
		if target == nil {
			return
		}
		visit(target, func(n *ast.Node) {
			if n == nil {
				return
			}
			switch n.Kind {
			case ast.KindPropertyAccessExpression:
				recv := unwrapExpression(n.AsPropertyAccessExpression().Expression)
				if n.Name() == nil {
					addMutatedProp("", recv)
				} else {
					addMutatedProp(n.Name().Text(), recv)
				}
			case ast.KindElementAccessExpression:
				elem := n.AsElementAccessExpression()
				recv := unwrapExpression(elem.Expression)
				if name, ok := a.staticElementIndex(elem.ArgumentExpression); ok {
					addMutatedProp(name, recv)
				} else {
					addMutatedProp("", recv)
				}
			}
		})
	}
	visit(file.AsNode(), func(node *ast.Node) {
		if node == nil {
			return
		}
		switch node.Kind {
		case ast.KindBinaryExpression:
			bin := node.AsBinaryExpression()
			if isAssignmentOperatorKind(bin.OperatorToken.Kind) {
				markMutated(bin.Left)
				markMutatedProps(bin.Left)
				if bin.OperatorToken.Kind == ast.KindEqualsToken {
					if sym := a.resolveSymbolAtNode(bin.Left); sym != nil {
						summary.assignedSymbols[sym] = append(summary.assignedSymbols[sym], bin.Right)
					}
				}
			}
		case ast.KindPrefixUnaryExpression:
			u := node.AsPrefixUnaryExpression()
			if u.Operator == ast.KindPlusPlusToken || u.Operator == ast.KindMinusMinusToken {
				markMutated(u.Operand)
				markMutatedProps(u.Operand)
			}
		case ast.KindPostfixUnaryExpression:
			u := node.AsPostfixUnaryExpression()
			if u.Operator == ast.KindPlusPlusToken || u.Operator == ast.KindMinusMinusToken {
				markMutated(u.Operand)
				markMutatedProps(u.Operand)
			}
		case ast.KindDeleteExpression:
			markMutatedProps(node.Expression())
		case ast.KindForInStatement, ast.KindForOfStatement:
			init := node.AsForInOrOfStatement().Initializer
			if init != nil && init.Kind != ast.KindVariableDeclarationList {
				markMutated(init)
				markMutatedProps(init)
			}
		case ast.KindCallExpression:
			summary.calls = append(summary.calls, node)
			call := node.AsCallExpression()
			args := call.Arguments.Nodes
			if len(args) > 0 {
				switch callPath(call.Expression) {
				case "Object.assign", "Object.defineProperties":
					addMutatedProp("", args[0])
				case "Object.defineProperty", "Reflect.set", "Reflect.deleteProperty":
					if len(args) < 2 {
						addMutatedProp("", args[0])
					} else if name, ok := a.staticElementIndex(args[1]); ok {
						addMutatedProp(name, args[0])
					} else {
						addMutatedProp("", args[0])
					}
				}
			}
		}
	})
	cache.fileMutations[file] = summary
	return summary
}

func (a *Analyzer) fileHasPropertyMutationCandidate(file *ast.SourceFile, propName string) bool {
	summary := a.getFileMutationSummary(file)
	if summary == nil {
		return false
	}
	return len(summary.mutatedProps[propName]) > 0 || len(summary.mutatedProps[""]) > 0
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
		if name == nil || initializer == nil || !isCallLikeDiscard(initializer) || nodeCannotBeResultarType(initializer) {
			return
		}
		if name.Kind == ast.KindIdentifier {
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
			return
		}
		if name.Kind == ast.KindArrayBindingPattern || name.Kind == ast.KindObjectBindingPattern {
			visit(name, func(bindingNode *ast.Node) {
				if bindingNode.Kind != ast.KindIdentifier || bindingNode.Parent == nil || bindingNode.Parent.Kind != ast.KindBindingElement || bindingNode.Parent.Name() != bindingNode {
					return
				}
				type_ := a.checker.GetTypeAtLocation(bindingNode)
				if !isMustUseResultarType(type_) {
					return
				}
				symbol := a.checker.GetSymbolAtLocation(bindingNode)
				if symbol == nil {
					return
				}
				tracked = append(tracked, &trackedResult{
					identifier: bindingNode,
					name:       bindingNode.Text(),
					symbol:     symbol,
					typeName:   a.checker.TypeToStringEx(type_, bindingNode, checker.TypeFormatFlagsNoTruncation, nil),
				})
			})
		}
	})
	return tracked
}

func (a *Analyzer) markTrackedResultUses(file *ast.SourceFile, tracked []*trackedResult) {
	if len(tracked) == 0 {
		return
	}
	bySymbol := make(map[*ast.Symbol][]*trackedResult, len(tracked))
	for _, result := range tracked {
		if result.symbol != nil {
			bySymbol[result.symbol] = append(bySymbol[result.symbol], result)
		}
	}
	visit(file.AsNode(), func(node *ast.Node) {
		if node.Kind != ast.KindIdentifier || isDeclarationIdentifier(node) {
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
		results := bySymbol[symbol]
		if len(results) == 0 {
			return
		}
		for _, result := range results {
			if node == result.identifier {
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
	return a.isInsideDiscardedResultExpressionWithVisited(identifier, nil)
}

func (a *Analyzer) isInsideDiscardedResultExpressionWithVisited(identifier *ast.Node, visited map[*ast.Symbol]bool) bool {
	if identifier == nil {
		return false
	}
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
	root, parent := a.referenceChainRoot(identifier)
	if parent != nil && parent.Kind == ast.KindVariableDeclaration {
		declaration := parent.AsVariableDeclaration()
		if declaration.Initializer == root && parent.Name() != nil && parent.Name().Kind == ast.KindIdentifier &&
			!isExplicitDiscard(root) &&
			a.checker.GetSymbolAtLocation(parent.Name()) != a.checker.GetSymbolAtLocation(identifier) {
			rootType := a.checker.GetTypeAtLocation(root)
			if !(isCallLikeDiscard(root) && isMustUseResultarType(rootType)) &&
				(isMustUseResultarType(rootType) || a.isPromiseOfResultLikeType(rootType) || a.isPassthroughThenCall(root)) {
				return a.variableHasDiscardedResultUse(parent.Name(), visited)
			}
		}
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
	if (name == "try" || name == "tryCatch") && a.staticNamespace(call.Expression, name) != "ResultAsync" {
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
	symbol := a.resolveAliasedSymbol(a.checker.GetSymbolAtLocation(expression))
	if symbol != nil {
		return symbol.Name()
	}
	return expressionName(expression)
}

func (a *Analyzer) staticNamespace(expression *ast.Node, method string) string {
	expression = unwrapExpression(expression)
	if expression == nil {
		return ""
	}
	if expression.Kind == ast.KindPropertyAccessExpression {
		if expressionName(expression) == method {
			name := a.canonicalExpressionName(expression.AsPropertyAccessExpression().Expression)
			if !isResultarStaticNamespaceName(name) && name != "" {
				return name
			}
		}
	}
	if ns, member := a.staticMemberAccess(expression); ns != "" && member == method {
		return ns
	}
	return ""
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
	if (a.canonicalExpressionName(call.Expression) != "safeTry" && a.staticNamespace(call.Expression, "gen") != "Result" && a.staticNamespace(call.Expression, "fn") != "Result") || len(call.Arguments.Nodes) == 0 {
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
	if (a.staticNamespace(call.Expression, "gen") != "Result" && a.staticNamespace(call.Expression, "fn") != "Result") || len(call.Arguments.Nodes) == 0 {
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
		return true
	case ast.KindCallExpression:
		return true
	case ast.KindElementAccessExpression:
		return isCallLikeDiscard(expression.AsElementAccessExpression().Expression)
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

func (a *Analyzer) isPromiseResolveCall(parent, child *ast.Node) bool {
	if parent == nil || parent.Kind != ast.KindCallExpression {
		return false
	}
	call := parent.AsCallExpression()
	return a.staticNamespace(call.Expression, "resolve") == "Promise" &&
		len(call.Arguments.Nodes) == 1 &&
		call.Arguments.Nodes[0] == child
}

func (a *Analyzer) isPromiseAllCall(parent, child *ast.Node) bool {
	if parent == nil || parent.Kind != ast.KindCallExpression {
		return false
	}
	call := parent.AsCallExpression()
	return a.staticNamespace(call.Expression, "all") == "Promise" &&
		len(call.Arguments.Nodes) == 1 &&
		call.Arguments.Nodes[0] == child
}

func (a *Analyzer) isNullishThenCallback(arg *ast.Node) bool {
	arg = unwrapExpression(arg)
	if arg == nil {
		return true
	}
	switch arg.Kind {
	case ast.KindNullKeyword, ast.KindVoidExpression:
		return true
	case ast.KindIdentifier:
		if arg.Text() == "undefined" {
			if symbol := a.checker.GetSymbolAtLocation(arg); symbol == nil || len(symbol.Declarations()) == 0 {
				return true
			}
		}
	}
	t := a.checker.GetTypeAtLocation(arg)
	return t != nil && everyUnionPart(t, func(part *checker.Type) bool {
		return part.Flags()&(checker.TypeFlagsUndefined|checker.TypeFlagsNull|checker.TypeFlagsVoid) != 0
	})
}

func (a *Analyzer) isPassthroughThenCall(callNode *ast.Node) bool {
	if callNode == nil || callNode.Kind != ast.KindCallExpression {
		return false
	}
	call := callNode.AsCallExpression()
	callee := unwrapExpression(call.Expression)
	if callee == nil || callee.Kind != ast.KindPropertyAccessExpression ||
		callee.Name() == nil || callee.Name().Text() != "then" {
		return false
	}
	args := call.Arguments.Nodes
	return len(args) == 0 || a.isNullishThenCallback(args[0]) || a.isIdentityCallback(args[0])
}

func (a *Analyzer) isIdentityCall(parent, child *ast.Node) bool {
	if parent == nil || parent.Kind != ast.KindCallExpression {
		return false
	}
	call := parent.AsCallExpression()
	args := call.Arguments.Nodes
	if len(args) == 1 && args[0] == child && a.isIdentityCallback(call.Expression) {
		return true
	}
	if len(args) >= 2 && args[0] == child && a.isPipeFunction(call.Expression) {
		for _, fnArg := range args[1:] {
			if !a.isIdentityCallback(fnArg) {
				return false
			}
		}
		return true
	}
	return false
}

func (a *Analyzer) isCallbackTransformerExpression(expr *ast.Node) bool {
	return a.isCallbackTransformerExpressionWithVisited(expr, nil, 0)
}

func (a *Analyzer) isCallbackTransformerExpressionWithVisited(expr *ast.Node, visited map[*ast.Symbol]bool, depth int) bool {
	if depth > 8 {
		return false
	}
	expr = unwrapExpression(expr)
	if expr == nil {
		return false
	}
	if a.classifyResultCallbackWithVisited(expr, cloneSymbolVisited(visited), depth+1) == resultCallbackTransformer {
		return true
	}
	targets, ok := a.resolveCallbackTargetsWithVisited(expr, cloneSymbolVisited(visited), depth+1)
	if !ok || len(targets) == 0 {
		return false
	}
	for _, t := range targets {
		if a.classifyResultCallbackWithVisited(t, cloneSymbolVisited(visited), depth+1) != resultCallbackTransformer {
			return false
		}
	}
	return true
}

func (a *Analyzer) isCurriedTransformerCall(parent, child *ast.Node) bool {
	if parent == nil || parent.Kind != ast.KindCallExpression {
		return false
	}
	call := parent.AsCallExpression()
	args := call.Arguments.Nodes
	if len(args) == 1 && args[0] == child && a.isCallbackTransformerExpression(call.Expression) {
		return true
	}
	if len(args) >= 2 && args[0] == child && a.isPipeFunction(call.Expression) {
		hasTransformer := false
		for _, fnArg := range args[1:] {
			if a.isIdentityCallback(fnArg) {
				continue
			}
			if a.isCallbackTransformerExpression(fnArg) {
				hasTransformer = true
				continue
			}
			return false
		}
		return hasTransformer
	}
	return false
}

func (a *Analyzer) referenceChainRoot(identifier *ast.Node) (*ast.Node, *ast.Node) {
	current := identifier
	for parent := current.Parent; parent != nil; parent = current.Parent {
		if isWrapperParent(parent, current) ||
			(parent.Kind == ast.KindAwaitExpression && parent.Expression() == current) ||
			a.isPromiseResolveCall(parent, current) ||
			a.isIdentityCall(parent, current) ||
			a.isCurriedTransformerCall(parent, current) {
			current = parent
			continue
		}
		if parent.Kind == ast.KindPropertyAccessExpression && parent.AsPropertyAccessExpression().Expression == current {
			if parent.Name() != nil && parent.Name().Text() == "then" {
				if parent.Parent != nil && parent.Parent.Kind == ast.KindCallExpression &&
					parent.Parent.AsCallExpression().Expression == parent &&
					a.isPassthroughThenCall(parent.Parent) {
					current = parent.Parent
					continue
				}
				return current, parent
			}
			if parent.Parent != nil && parent.Parent.Kind == ast.KindCallExpression &&
				parent.Parent.AsCallExpression().Expression == parent {
				callType := a.checker.GetTypeAtLocation(parent.Parent)
				if isMustUseResultarType(callType) || a.isPromiseOfResultLikeType(callType) {
					current = parent.Parent
					continue
				}
			}
			return current, parent
		}
		return current, parent
	}
	return current, nil
}

func isDeclarationIdentifier(node *ast.Node) bool {
	if node == nil || node.Parent == nil {
		return false
	}
	switch node.Parent.Kind {
	case ast.KindVariableDeclaration, ast.KindParameter, ast.KindBindingElement:
		return node.Parent.Name() == node
	}
	return false
}

func enclosingFunction(returnOrArrow *ast.Node) *ast.Node {
	if returnOrArrow == nil {
		return nil
	}
	if returnOrArrow.Kind == ast.KindArrowFunction {
		return returnOrArrow
	}
	for curr := returnOrArrow.Parent; curr != nil; curr = curr.Parent {
		if isFunctionLikeNode(curr) || curr.Kind == ast.KindGetAccessor || curr.Kind == ast.KindSetAccessor || curr.Kind == ast.KindConstructor {
			return curr
		}
	}
	return nil
}

func enclosingCallbackCall(fn *ast.Node) (*ast.Node, string) {
	if fn == nil {
		return nil, ""
	}
	fnRoot := fn
	for fnRoot.Parent != nil && isWrapperParent(fnRoot.Parent, fnRoot) {
		fnRoot = fnRoot.Parent
	}
	parent := fnRoot.Parent
	if parent == nil || parent.Kind != ast.KindCallExpression {
		return nil, ""
	}
	call := parent.AsCallExpression()
	isArg := false
	for _, arg := range call.Arguments.Nodes {
		if arg == fnRoot {
			isArg = true
			break
		}
	}
	if !isArg {
		return nil, ""
	}
	method, _, _ := methodCall(parent)
	return parent, method
}

type nodeVisitKind uint8

const (
	nodeVisitRef nodeVisitKind = iota
	nodeVisitOuterCall
	nodeVisitPromiseAll
)

type nodeVisitKey struct {
	node        *ast.Node
	elemIndex   int
	kind        nodeVisitKind
	callContext *ast.Node
}

type symbolVisitKind uint8

const (
	symVisitSingle symbolVisitKind = iota
	symVisitPromiseAll
	symVisitTuple
)

type symbolVisitKey struct {
	symbol      *ast.Symbol
	elemIndex   int
	kind        symbolVisitKind
	callContext *ast.Node
}

type callbackFrame struct {
	fn        *ast.Node
	callNode  *ast.Node
	method    string
	elemIndex int
}

type callbackVisitKey struct {
	fn        *ast.Node
	callNode  *ast.Node
	elemIndex int
}

type handleSearchState struct {
	sourceSymbol     *ast.Symbol
	visitedNodes     map[nodeVisitKey]bool
	visitedSymbols   map[symbolVisitKey]bool
	visitedCallbacks map[callbackVisitKey]bool
	callbackStack    []callbackFrame
}

func newHandleSearchState(sourceSymbol *ast.Symbol) *handleSearchState {
	visitedSymbols := make(map[symbolVisitKey]bool)
	if sourceSymbol != nil {
		visitedSymbols[symbolVisitKey{symbol: sourceSymbol, elemIndex: -1, kind: symVisitSingle}] = true
	}
	return &handleSearchState{
		sourceSymbol:     sourceSymbol,
		visitedNodes:     make(map[nodeVisitKey]bool),
		visitedSymbols:   visitedSymbols,
		visitedCallbacks: make(map[callbackVisitKey]bool),
	}
}

func (s *handleSearchState) activeCallContext() *ast.Node {
	if s == nil || len(s.callbackStack) == 0 {
		return nil
	}
	return s.callbackStack[len(s.callbackStack)-1].callNode
}

func (s *handleSearchState) withCallback(cb *ast.Node, callNode *ast.Node, method string, elemIndex int, fn func() bool) bool {
	if s == nil || cb == nil {
		return false
	}
	if callNode == nil {
		return fn()
	}
	key := callbackVisitKey{fn: cb, callNode: callNode, elemIndex: elemIndex}
	if s.visitedCallbacks[key] || len(s.callbackStack) >= 16 {
		return false
	}
	for _, frame := range s.callbackStack {
		if frame.fn == cb && frame.elemIndex == elemIndex {
			return false
		}
	}
	s.visitedCallbacks[key] = true
	defer delete(s.visitedCallbacks, key)
	s.callbackStack = append(s.callbackStack, callbackFrame{fn: cb, callNode: callNode, method: method, elemIndex: elemIndex})
	defer func() {
		s.callbackStack = s.callbackStack[:len(s.callbackStack)-1]
	}()
	return fn()
}

func (s *handleSearchState) resolveCallbackReturn(fn *ast.Node) (*ast.Node, string, func()) {
	if s != nil {
		for i := len(s.callbackStack) - 1; i >= 0; i-- {
			if s.callbackStack[i].fn == fn {
				saved := append([]callbackFrame(nil), s.callbackStack[i:]...)
				callNode := s.callbackStack[i].callNode
				method := s.callbackStack[i].method
				s.callbackStack = s.callbackStack[:i]
				return callNode, method, func() {
					s.callbackStack = append(s.callbackStack, saved...)
				}
			}
		}
	}
	if callNode, method := enclosingCallbackCall(fn); callNode != nil {
		return callNode, method, func() {}
	}
	return nil, "", func() {}
}

func isAssignmentOperatorKind(kind ast.Kind) bool {
	switch kind {
	case ast.KindEqualsToken,
		ast.KindPlusEqualsToken,
		ast.KindMinusEqualsToken,
		ast.KindAsteriskAsteriskEqualsToken,
		ast.KindAsteriskEqualsToken,
		ast.KindSlashEqualsToken,
		ast.KindPercentEqualsToken,
		ast.KindAmpersandEqualsToken,
		ast.KindBarEqualsToken,
		ast.KindCaretEqualsToken,
		ast.KindLessThanLessThanEqualsToken,
		ast.KindGreaterThanGreaterThanGreaterThanEqualsToken,
		ast.KindGreaterThanGreaterThanEqualsToken,
		ast.KindBarBarEqualsToken,
		ast.KindAmpersandAmpersandEqualsToken,
		ast.KindQuestionQuestionEqualsToken:
		return true
	}
	return false
}

func symbolHasLocalValueDeclaration(symbol *ast.Symbol) bool {
	if symbol == nil {
		return false
	}
	for _, decl := range symbol.Declarations() {
		if decl == nil {
			continue
		}
		switch decl.Kind {
		case ast.KindVariableDeclaration,
			ast.KindClassDeclaration,
			ast.KindClassExpression,
			ast.KindFunctionDeclaration,
			ast.KindParameter,
			ast.KindBindingElement,
			ast.KindEnumDeclaration,
			ast.KindMethodDeclaration,
			ast.KindPropertyDeclaration,
			ast.KindPropertyAssignment,
			ast.KindShorthandPropertyAssignment:
			return true
		}
	}
	return false
}

func (a *Analyzer) resolveAliasedSymbol(symbol *ast.Symbol) *ast.Symbol {
	for symbol != nil && symbol.Flags()&ast.SymbolFlagsAlias != 0 {
		if symbolHasLocalValueDeclaration(symbol) {
			break
		}
		aliased := a.checker.GetAliasedSymbol(symbol)
		if aliased == nil || aliased == symbol {
			break
		}
		symbol = aliased
	}
	return symbol
}

func (a *Analyzer) resolveSymbolAtNode(node *ast.Node) *ast.Symbol {
	node = unwrapExpression(node)
	if node == nil {
		return nil
	}
	var symbol *ast.Symbol
	switch node.Kind {
	case ast.KindIdentifier:
		if node.Parent != nil && node.Parent.Kind == ast.KindShorthandPropertyAssignment && node.Parent.Name() == node {
			symbol = a.checker.GetShorthandAssignmentValueSymbol(node.Parent)
		} else {
			symbol = a.checker.GetSymbolAtLocation(node)
		}
	case ast.KindPropertyAccessExpression:
		symbol = a.checker.GetSymbolAtLocation(node)
		if symbol == nil && node.Name() != nil {
			symbol = a.checker.GetSymbolAtLocation(node.Name())
		}
		if symbol == nil && node.Name() != nil {
			if objType := a.checker.GetTypeAtLocation(node.AsPropertyAccessExpression().Expression); objType != nil {
				symbol = a.checker.GetPropertyOfType(objType, node.Name().Text())
			}
		}
	case ast.KindElementAccessExpression:
		symbol = a.checker.GetSymbolAtLocation(node)
		if symbol == nil {
			if propName, ok := a.staticElementIndex(node.AsElementAccessExpression().ArgumentExpression); ok {
				if objType := a.checker.GetTypeAtLocation(node.AsElementAccessExpression().Expression); objType != nil {
					symbol = a.checker.GetPropertyOfType(objType, propName)
				}
			}
		}
	default:
		symbol = a.checker.GetSymbolAtLocation(node)
	}
	return a.resolveAliasedSymbol(symbol)
}

func (a *Analyzer) nodeReferencesSymbol(node *ast.Node, target *ast.Symbol) bool {
	if node == nil || target == nil {
		return false
	}
	found := false
	visit(node, func(n *ast.Node) {
		if found || n == nil {
			return
		}
		if n.Kind == ast.KindShorthandPropertyAssignment {
			if a.resolveAliasedSymbol(a.checker.GetShorthandAssignmentValueSymbol(n)) == target || a.resolveSymbolAtNode(n.Name()) == target {
				found = true
			}
			return
		}
		if n.Kind != ast.KindIdentifier && n.Kind != ast.KindPropertyAccessExpression && n.Kind != ast.KindElementAccessExpression {
			return
		}
		if a.resolveSymbolAtNode(n) == target {
			found = true
		}
	})
	return found
}

func (a *Analyzer) variableIsReassigned(symbol *ast.Symbol, file *ast.SourceFile) bool {
	if symbol == nil || file == nil {
		return true
	}
	initCount := 0
	for _, decl := range symbol.Declarations() {
		if decl == nil {
			continue
		}
		if decl.Kind == ast.KindVariableDeclaration && decl.AsVariableDeclaration().Initializer != nil {
			initCount++
		}
		if decl.Kind == ast.KindFunctionDeclaration && decl.Body() != nil {
			initCount++
		}
	}
	if initCount > 1 {
		return true
	}
	summary := a.getFileMutationSummary(file)
	return summary != nil && summary.mutatedSymbols[symbol]
}

func (a *Analyzer) isSymbolReassigned(symbol *ast.Symbol, declFile, callFile *ast.SourceFile) bool {
	if symbol == nil {
		return true
	}
	if !isImmutableDeclarationOrPackageFile(declFile) && a.variableIsReassigned(symbol, declFile) {
		return true
	}
	if callFile != declFile && !isImmutableDeclarationOrPackageFile(callFile) && a.variableIsReassigned(symbol, callFile) {
		return true
	}
	for _, decl := range symbol.Declarations() {
		if decl == nil {
			continue
		}
		dFile := ast.GetSourceFileOfNode(decl)
		switch decl.Kind {
		case ast.KindPropertyAssignment, ast.KindShorthandPropertyAssignment, ast.KindMethodDeclaration:
			propName := getMemberDeclarationName(a, decl)
			if propName == "" || (!a.fileHasPropertyMutationCandidate(dFile, propName) && !a.fileHasPropertyMutationCandidate(callFile, propName)) {
				continue
			}
			if decl.Parent != nil && decl.Parent.Kind == ast.KindObjectLiteralExpression {
				if a.isPropertyOnIdentitiesReassigned([]objectIdentity{{node: decl.Parent}}, propName, dFile, callFile) {
					return true
				}
			}
			if decl.Parent != nil && (decl.Parent.Kind == ast.KindClassDeclaration || decl.Parent.Kind == ast.KindClassExpression) {
				classTargets := []objectIdentity{{node: decl.Parent}}
				if classSym := a.resolveSymbolAtNode(decl.Parent); classSym != nil {
					classTargets = append(classTargets, objectIdentity{symbol: classSym}, objectIdentity{symbol: classSym, path: "prototype"})
				} else if decl.Parent.Name() != nil {
					if classSym := a.resolveSymbolAtNode(decl.Parent.Name()); classSym != nil {
						classTargets = append(classTargets, objectIdentity{symbol: classSym}, objectIdentity{symbol: classSym, path: "prototype"})
					}
				}
				if a.isPropertyOnIdentitiesReassigned(classTargets, propName, dFile, callFile) {
					return true
				}
			}
		case ast.KindPropertyDeclaration:
			propName := getMemberDeclarationName(a, decl)
			if propName == "" || (!a.fileHasPropertyMutationCandidate(dFile, propName) && !a.fileHasPropertyMutationCandidate(callFile, propName)) {
				continue
			}
			if decl.Parent != nil && (decl.Parent.Kind == ast.KindClassDeclaration || decl.Parent.Kind == ast.KindClassExpression) {
				classTargets := []objectIdentity{{node: decl.Parent}}
				if classSym := a.resolveSymbolAtNode(decl.Parent); classSym != nil {
					classTargets = append(classTargets, objectIdentity{symbol: classSym}, objectIdentity{symbol: classSym, path: "prototype"})
				} else if decl.Parent.Name() != nil {
					if classSym := a.resolveSymbolAtNode(decl.Parent.Name()); classSym != nil {
						classTargets = append(classTargets, objectIdentity{symbol: classSym}, objectIdentity{symbol: classSym, path: "prototype"})
					}
				}
				if a.isPropertyOnIdentitiesReassigned(classTargets, propName, dFile, callFile) {
					return true
				}
			}
		}
	}
	return false
}

type objectIdentity struct {
	symbol *ast.Symbol
	node   *ast.Node
	path   string
}

func joinPropertyPath(base, prop string) string {
	if base == "" {
		return prop
	}
	if prop == "" {
		return base
	}
	return base + "." + prop
}

func appendObjectIdentity(list []objectIdentity, id objectIdentity) []objectIdentity {
	if id.symbol == nil && id.node == nil {
		return list
	}
	for _, existing := range list {
		if existing == id {
			return list
		}
	}
	return append(list, id)
}

func (a *Analyzer) functionReferencesForNode(fn *ast.Node) []*ast.Symbol {
	if fn == nil {
		return nil
	}
	var syms []*ast.Symbol
	addSym := func(s *ast.Symbol) {
		if s == nil {
			return
		}
		for _, existing := range syms {
			if existing == s {
				return
			}
		}
		syms = append(syms, s)
	}
	addSym(a.resolveSymbolAtNode(fn))
	if fn.Name() != nil {
		addSym(a.resolveSymbolAtNode(fn.Name()))
	}
	parent := fn.Parent
	for curr := fn; parent != nil && isWrapperParent(parent, curr); {
		curr = parent
		parent = curr.Parent
	}
	if parent != nil {
		switch parent.Kind {
		case ast.KindVariableDeclaration, ast.KindPropertyAssignment, ast.KindPropertyDeclaration, ast.KindMethodDeclaration:
			addSym(a.resolveSymbolAtNode(parent))
			if parent.Name() != nil {
				addSym(a.resolveSymbolAtNode(parent.Name()))
			}
		}
	}
	return syms
}

func (a *Analyzer) callMatchesFunction(callExpr *ast.Node, fn *ast.Node, fnSyms []*ast.Symbol) bool {
	callExpr = unwrapExpression(callExpr)
	if callExpr == nil || fn == nil {
		return false
	}
	if callExpr == fn {
		return true
	}
	if len(fnSyms) > 0 {
		if calleeSym := a.resolveSymbolAtNode(callExpr); calleeSym != nil {
			for _, s := range fnSyms {
				if calleeSym == s {
					return true
				}
			}
		}
	}
	return false
}

func (a *Analyzer) isVisitedRecursiveCall(expr *ast.Node, calleeTarget *ast.Node, fnSyms []*ast.Symbol, calleeVisited map[*ast.Symbol]bool, depth int) bool {
	unwrapped := unwrapExpression(expr)
	for i := 0; i < 8 && unwrapped != nil && unwrapped.Kind == ast.KindCallExpression; i++ {
		call := unwrapped.AsCallExpression()
		if method, recv, _ := methodCall(unwrapped); method == "bind" && len(call.Arguments.Nodes) <= 1 {
			unwrapped = unwrapExpression(recv)
			continue
		}
		if len(call.Arguments.Nodes) == 1 && a.isIdentityCallbackWithVisited(call.Expression, cloneSymbolVisited(calleeVisited), depth+1) {
			unwrapped = unwrapExpression(call.Arguments.Nodes[0])
			continue
		}
		break
	}
	if unwrapped == nil || unwrapped.Kind != ast.KindCallExpression {
		return false
	}
	callExpr := unwrapExpression(unwrapped.AsCallExpression().Expression)
	if a.callMatchesFunction(callExpr, calleeTarget, fnSyms) {
		return true
	}
	if len(calleeVisited) > 0 {
		if calleeSym := a.resolveSymbolAtNode(callExpr); calleeSym != nil && calleeVisited[calleeSym] {
			return true
		}
	}
	return false
}

func (a *Analyzer) collectObjectIdentities(expr *ast.Node, file *ast.SourceFile, visited map[*ast.Symbol]bool, depth int) []objectIdentity {
	if depth > 8 {
		return nil
	}
	expr = unwrapExpression(expr)
	if expr == nil {
		return nil
	}
	var ids []objectIdentity
	switch expr.Kind {
	case ast.KindObjectLiteralExpression, ast.KindNewExpression, ast.KindArrayLiteralExpression:
		ids = appendObjectIdentity(ids, objectIdentity{node: expr})
		if expr.Kind == ast.KindNewExpression {
			if classNode := a.resolveClassLikeNodeFromExpression(expr.AsNewExpression().Expression, cloneSymbolVisited(visited)); classNode != nil {
				ids = appendObjectIdentity(ids, objectIdentity{node: classNode})
				if classSym := a.resolveSymbolAtNode(classNode); classSym != nil {
					ids = appendObjectIdentity(ids, objectIdentity{symbol: classSym})
				} else if classNode.Name() != nil {
					if classSym := a.resolveSymbolAtNode(classNode.Name()); classSym != nil {
						ids = appendObjectIdentity(ids, objectIdentity{symbol: classSym})
					}
				}
			}
		}
	case ast.KindThisKeyword:
		for curr := expr.Parent; curr != nil; curr = curr.Parent {
			if curr.Kind == ast.KindClassDeclaration || curr.Kind == ast.KindClassExpression {
				ids = appendObjectIdentity(ids, objectIdentity{node: curr})
				if classSym := a.resolveSymbolAtNode(curr); classSym != nil {
					ids = appendObjectIdentity(ids, objectIdentity{symbol: classSym})
				} else if curr.Name() != nil {
					if classSym := a.resolveSymbolAtNode(curr.Name()); classSym != nil {
						ids = appendObjectIdentity(ids, objectIdentity{symbol: classSym})
					}
				}
				break
			}
		}
	case ast.KindConditionalExpression:
		cond := expr.AsConditionalExpression()
		for _, sub := range a.collectObjectIdentities(cond.WhenTrue, file, cloneSymbolVisited(visited), depth+1) {
			ids = appendObjectIdentity(ids, sub)
		}
		for _, sub := range a.collectObjectIdentities(cond.WhenFalse, file, cloneSymbolVisited(visited), depth+1) {
			ids = appendObjectIdentity(ids, sub)
		}
	case ast.KindCallExpression:
		call := expr.AsCallExpression()
		if callPath(call.Expression) == "Object.assign" && len(call.Arguments.Nodes) > 0 {
			for _, sub := range a.collectObjectIdentities(call.Arguments.Nodes[0], file, cloneSymbolVisited(visited), depth+1) {
				ids = appendObjectIdentity(ids, sub)
			}
		} else if len(call.Arguments.Nodes) == 1 && a.isIdentityCallbackWithVisited(call.Expression, cloneSymbolVisited(visited), depth+1) {
			for _, sub := range a.collectObjectIdentities(call.Arguments.Nodes[0], file, cloneSymbolVisited(visited), depth+1) {
				ids = appendObjectIdentity(ids, sub)
			}
		}
	case ast.KindPropertyAccessExpression, ast.KindElementAccessExpression:
		var recv *ast.Node
		var propName string
		if expr.Kind == ast.KindPropertyAccessExpression {
			if expr.Name() != nil {
				recv = unwrapExpression(expr.AsPropertyAccessExpression().Expression)
				propName = expr.Name().Text()
			}
		} else {
			elem := expr.AsElementAccessExpression()
			if name, ok := a.staticElementIndex(elem.ArgumentExpression); ok {
				recv = unwrapExpression(elem.Expression)
				propName = name
			}
		}
		if recv != nil && propName != "" {
			for _, baseID := range a.collectObjectIdentities(recv, file, cloneSymbolVisited(visited), depth+1) {
				ids = appendObjectIdentity(ids, objectIdentity{
					symbol: baseID.symbol,
					node:   baseID.node,
					path:   joinPropertyPath(baseID.path, propName),
				})
			}
			if propInit := a.resolveObjectLiteralPropertyInitializerFromRecv(recv, propName, cloneSymbolVisited(visited)); propInit != nil {
				for _, sub := range a.collectObjectIdentities(propInit, file, cloneSymbolVisited(visited), depth+1) {
					ids = appendObjectIdentity(ids, sub)
				}
			}
		}
	}

	sym := a.resolveSymbolAtNode(expr)
	if sym == nil {
		return ids
	}
	ids = appendObjectIdentity(ids, objectIdentity{symbol: sym})
	if visited == nil {
		visited = make(map[*ast.Symbol]bool)
	}
	if visited[sym] {
		return ids
	}
	visited[sym] = true

	for _, decl := range sym.Declarations() {
		if decl == nil {
			continue
		}
		declFile := ast.GetSourceFileOfNode(decl)
		if isImmutableDeclarationOrPackageFile(declFile) {
			continue
		}
		switch decl.Kind {
		case ast.KindVariableDeclaration:
			varDecl := decl.AsVariableDeclaration()
			if varDecl.Initializer != nil {
				for _, sub := range a.collectObjectIdentities(varDecl.Initializer, declFile, cloneSymbolVisited(visited), depth+1) {
					ids = appendObjectIdentity(ids, sub)
				}
			}
			isConst := decl.Parent != nil && decl.Parent.Kind == ast.KindVariableDeclarationList && decl.Parent.Flags&ast.NodeFlagsConst != 0
			if !isConst {
				for _, searchFile := range []*ast.SourceFile{declFile, file} {
					summary := a.getFileMutationSummary(searchFile)
					if summary == nil {
						continue
					}
					for _, rhs := range summary.assignedSymbols[sym] {
						for _, sub := range a.collectObjectIdentities(rhs, searchFile, cloneSymbolVisited(visited), depth+1) {
							ids = appendObjectIdentity(ids, sub)
						}
					}
				}
			}
		case ast.KindBindingElement:
			if recv, propName, _, ok := a.bindingElementTarget(decl); ok {
				for _, baseID := range a.collectObjectIdentities(recv, declFile, cloneSymbolVisited(visited), depth+1) {
					ids = appendObjectIdentity(ids, objectIdentity{
						symbol: baseID.symbol,
						node:   baseID.node,
						path:   joinPropertyPath(baseID.path, propName),
					})
				}
				if propInit := a.resolveObjectLiteralPropertyInitializerFromRecv(recv, propName, cloneSymbolVisited(visited)); propInit != nil {
					for _, sub := range a.collectObjectIdentities(propInit, declFile, cloneSymbolVisited(visited), depth+1) {
						ids = appendObjectIdentity(ids, sub)
					}
				}
			}
		case ast.KindPropertyAssignment:
			if init := decl.AsPropertyAssignment().Initializer; init != nil {
				for _, sub := range a.collectObjectIdentities(init, declFile, cloneSymbolVisited(visited), depth+1) {
					ids = appendObjectIdentity(ids, sub)
				}
			}
		case ast.KindShorthandPropertyAssignment:
			if valSym := a.resolveAliasedSymbol(a.checker.GetShorthandAssignmentValueSymbol(decl)); valSym != nil && valSym != sym {
				for _, valDecl := range valSym.Declarations() {
					if valDecl != nil && valDecl.Name() != nil {
						for _, sub := range a.collectObjectIdentities(valDecl.Name(), declFile, cloneSymbolVisited(visited), depth+1) {
							ids = appendObjectIdentity(ids, sub)
						}
					}
				}
			}
		case ast.KindPropertyDeclaration:
			if init := decl.AsPropertyDeclaration().Initializer; init != nil {
				for _, sub := range a.collectObjectIdentities(init, declFile, cloneSymbolVisited(visited), depth+1) {
					ids = appendObjectIdentity(ids, sub)
				}
			}
		case ast.KindParameter:
			fn := decl.Parent
			if fn == nil || !isFunctionLikeNode(fn) {
				continue
			}
			paramIndex := -1
			for idx, p := range fn.Parameters() {
				if p == decl {
					paramIndex = idx
					break
				}
			}
			if paramIndex < 0 {
				continue
			}
			fnSyms := a.functionReferencesForNode(fn)
			if len(fnSyms) == 0 {
				continue
			}
			for _, searchFile := range []*ast.SourceFile{declFile, file} {
				summary := a.getFileMutationSummary(searchFile)
				if summary == nil {
					continue
				}
				for _, n := range summary.calls {
					call := n.AsCallExpression()
					if paramIndex >= len(call.Arguments.Nodes) {
						continue
					}
					if a.callMatchesFunction(call.Expression, fn, fnSyms) {
						for _, sub := range a.collectObjectIdentities(call.Arguments.Nodes[paramIndex], searchFile, cloneSymbolVisited(visited), depth+1) {
							ids = appendObjectIdentity(ids, sub)
						}
					}
				}
			}
		}
	}
	return ids
}

func (a *Analyzer) nodeSharesObjectIdentity(expr *ast.Node, targets []objectIdentity, propSuffix string, file *ast.SourceFile) bool {
	if len(targets) == 0 || expr == nil {
		return false
	}
	exprIDs := a.collectObjectIdentities(expr, file, nil, 0)
	for _, eid := range exprIDs {
		candidate := objectIdentity{
			symbol: eid.symbol,
			node:   eid.node,
			path:   joinPropertyPath(eid.path, propSuffix),
		}
		for _, target := range targets {
			if candidate == target {
				return true
			}
		}
	}
	return false
}

func (a *Analyzer) propertyOnIdentitiesIsReassignedInFile(targets []objectIdentity, propName string, file *ast.SourceFile) bool {
	if len(targets) == 0 || propName == "" || file == nil {
		return true
	}
	summary := a.getFileMutationSummary(file)
	if summary == nil {
		return false
	}
	for _, recv := range summary.mutatedProps[propName] {
		if a.nodeSharesObjectIdentity(recv, targets, "", file) {
			return true
		}
	}
	for _, recv := range summary.mutatedProps[""] {
		if a.nodeSharesObjectIdentity(recv, targets, "", file) {
			return true
		}
	}
	return false
}

func (a *Analyzer) isPropertyOnIdentitiesReassigned(targets []objectIdentity, propName string, declFile, callFile *ast.SourceFile) bool {
	if len(targets) == 0 || propName == "" {
		return true
	}
	if !isImmutableDeclarationOrPackageFile(declFile) && a.propertyOnIdentitiesIsReassignedInFile(targets, propName, declFile) {
		return true
	}
	if callFile != declFile && !isImmutableDeclarationOrPackageFile(callFile) && a.propertyOnIdentitiesIsReassignedInFile(targets, propName, callFile) {
		return true
	}
	return false
}

func (a *Analyzer) collectSymbolObjectIdentities(symbol *ast.Symbol, file *ast.SourceFile) []objectIdentity {
	if symbol == nil {
		return nil
	}
	ids := []objectIdentity{{symbol: symbol}}
	for _, decl := range symbol.Declarations() {
		if decl == nil {
			continue
		}
		declFile := ast.GetSourceFileOfNode(decl)
		if isImmutableDeclarationOrPackageFile(declFile) {
			continue
		}
		if decl.Name() != nil {
			for _, sub := range a.collectObjectIdentities(decl.Name(), declFile, nil, 0) {
				ids = appendObjectIdentity(ids, sub)
			}
		} else {
			for _, sub := range a.collectObjectIdentities(decl, declFile, nil, 0) {
				ids = appendObjectIdentity(ids, sub)
			}
		}
	}
	if !isImmutableDeclarationOrPackageFile(file) {
		for _, decl := range symbol.Declarations() {
			if decl != nil && decl.Name() != nil && !isImmutableDeclarationOrPackageFile(ast.GetSourceFileOfNode(decl)) {
				for _, sub := range a.collectObjectIdentities(decl.Name(), file, nil, 0) {
					ids = appendObjectIdentity(ids, sub)
				}
			}
		}
	}
	return ids
}

func (a *Analyzer) propertyOnSymbolIsReassigned(symbol *ast.Symbol, propName string, file *ast.SourceFile) bool {
	if symbol == nil || propName == "" || file == nil {
		return true
	}
	if !a.fileHasPropertyMutationCandidate(file, propName) {
		return false
	}
	targets := a.collectSymbolObjectIdentities(symbol, file)
	return a.propertyOnIdentitiesIsReassignedInFile(targets, propName, file)
}

func (a *Analyzer) isPropertyOnSymbolReassigned(symbol *ast.Symbol, propName string, declFile, callFile *ast.SourceFile) bool {
	if symbol == nil || propName == "" {
		return true
	}
	if !isImmutableDeclarationOrPackageFile(declFile) && a.propertyOnSymbolIsReassigned(symbol, propName, declFile) {
		return true
	}
	if callFile != declFile && !isImmutableDeclarationOrPackageFile(callFile) && a.propertyOnSymbolIsReassigned(symbol, propName, callFile) {
		return true
	}
	return false
}

func (a *Analyzer) bindingElementTarget(decl *ast.Node) (*ast.Node, string, bool, bool) {
	if decl == nil || decl.Kind != ast.KindBindingElement {
		return nil, "", false, false
	}
	bindingElem := decl.AsBindingElement()
	if bindingElem.DotDotDotToken != nil || bindingElem.Initializer != nil {
		return nil, "", false, false
	}
	if decl.Parent == nil || decl.Parent.Kind != ast.KindObjectBindingPattern {
		return nil, "", false, false
	}
	parent := decl.Parent.Parent
	if parent == nil || parent.Kind != ast.KindVariableDeclaration {
		return nil, "", false, false
	}
	varDecl := parent.AsVariableDeclaration()
	if varDecl.Initializer == nil {
		return nil, "", false, false
	}
	var propName string
	if bindingElem.PropertyName != nil {
		switch bindingElem.PropertyName.Kind {
		case ast.KindIdentifier, ast.KindStringLiteral, ast.KindNumericLiteral, ast.KindNoSubstitutionTemplateLiteral:
			propName = bindingElem.PropertyName.Text()
		case ast.KindComputedPropertyName:
			name, ok := a.staticElementIndex(bindingElem.PropertyName.Expression())
			if !ok {
				return nil, "", false, false
			}
			propName = name
		default:
			return nil, "", false, false
		}
	} else if bindingElem.Name() != nil && bindingElem.Name().Kind == ast.KindIdentifier {
		propName = bindingElem.Name().Text()
	}
	if propName == "" {
		return nil, "", false, false
	}
	isConst := parent.Parent != nil &&
		parent.Parent.Kind == ast.KindVariableDeclarationList &&
		parent.Parent.Flags&ast.NodeFlagsConst != 0
	return unwrapExpression(varDecl.Initializer), propName, isConst, true
}

func (a *Analyzer) isCallbackReceiverReassigned(node *ast.Node) bool {
	unwrapped := unwrapExpression(node)
	if unwrapped == nil {
		return false
	}
	cache := a.getCache()
	if res, ok := cache.callbackReceiverReassigned[unwrapped]; ok {
		return res
	}
	callFile := ast.GetSourceFileOfNode(unwrapped)
	curr := unwrapped
	var chain []*ast.Node
	for curr != nil && (curr.Kind == ast.KindPropertyAccessExpression || curr.Kind == ast.KindElementAccessExpression) {
		if res, ok := cache.callbackReceiverReassigned[curr]; ok {
			if res {
				for _, n := range chain {
					cache.callbackReceiverReassigned[n] = true
				}
				cache.callbackReceiverReassigned[unwrapped] = true
				return true
			}
			break
		}
		chain = append(chain, curr)
		var recv *ast.Node
		var propName string
		if curr.Kind == ast.KindPropertyAccessExpression {
			if curr.Name() == nil {
				cache.callbackReceiverReassigned[unwrapped] = true
				return true
			}
			recv = unwrapExpression(curr.AsPropertyAccessExpression().Expression)
			propName = curr.Name().Text()
		} else {
			elem := curr.AsElementAccessExpression()
			name, ok := a.staticElementIndex(elem.ArgumentExpression)
			if !ok {
				cache.callbackReceiverReassigned[unwrapped] = true
				return true
			}
			recv = unwrapExpression(elem.Expression)
			propName = name
		}
		if recv == nil || propName == "" {
			cache.callbackReceiverReassigned[unwrapped] = true
			return true
		}
		var recvIdentities []objectIdentity
		recvIdentitiesComputed := false
		getRecvIdentities := func() []objectIdentity {
			if !recvIdentitiesComputed {
				recvIdentitiesComputed = true
				recvIdentities = a.collectObjectIdentities(recv, callFile, nil, 0)
			}
			return recvIdentities
		}
		if a.fileHasPropertyMutationCandidate(callFile, propName) {
			if ids := getRecvIdentities(); len(ids) > 0 && a.propertyOnIdentitiesIsReassignedInFile(ids, propName, callFile) {
				cache.callbackReceiverReassigned[unwrapped] = true
				return true
			}
		}
		sym := a.resolveSymbolAtNode(recv)
		if sym != nil {
			checkedDeclFiles := map[*ast.SourceFile]bool{callFile: true}
			for _, decl := range sym.Declarations() {
				if decl == nil {
					continue
				}
				declFile := ast.GetSourceFileOfNode(decl)
				if !isImmutableDeclarationOrPackageFile(declFile) && !checkedDeclFiles[declFile] {
					checkedDeclFiles[declFile] = true
					if a.fileHasPropertyMutationCandidate(declFile, propName) {
						if ids := getRecvIdentities(); len(ids) > 0 && a.propertyOnIdentitiesIsReassignedInFile(ids, propName, declFile) {
							cache.callbackReceiverReassigned[unwrapped] = true
							return true
						}
					}
				}
				switch decl.Kind {
				case ast.KindVariableDeclaration:
					isConst := decl.Parent != nil &&
						decl.Parent.Kind == ast.KindVariableDeclarationList &&
						decl.Parent.Flags&ast.NodeFlagsConst != 0
					if !isConst && a.isSymbolReassigned(sym, declFile, callFile) {
						cache.callbackReceiverReassigned[unwrapped] = true
						return true
					}
				case ast.KindBindingElement:
					recvInit, boundProp, isConst, ok := a.bindingElementTarget(decl)
					if !ok ||
						(!isConst && a.isSymbolReassigned(sym, declFile, callFile)) ||
						a.isCallbackReceiverReassigned(recvInit) {
						cache.callbackReceiverReassigned[unwrapped] = true
						return true
					}
					if a.fileHasPropertyMutationCandidate(declFile, boundProp) || a.fileHasPropertyMutationCandidate(callFile, boundProp) {
						initIDs := a.collectObjectIdentities(recvInit, callFile, nil, 0)
						if len(initIDs) > 0 && a.isPropertyOnIdentitiesReassigned(initIDs, boundProp, declFile, callFile) {
							cache.callbackReceiverReassigned[unwrapped] = true
							return true
						}
						if recvSym := a.resolveSymbolAtNode(recvInit); recvSym != nil && a.isPropertyOnSymbolReassigned(recvSym, boundProp, declFile, callFile) {
							cache.callbackReceiverReassigned[unwrapped] = true
							return true
						}
					}
				case ast.KindParameter, ast.KindPropertyAssignment, ast.KindShorthandPropertyAssignment, ast.KindPropertyDeclaration:
					if a.isSymbolReassigned(sym, declFile, callFile) {
						cache.callbackReceiverReassigned[unwrapped] = true
						return true
					}
				}
			}
		}
		curr = recv
	}
	for _, n := range chain {
		cache.callbackReceiverReassigned[n] = false
	}
	cache.callbackReceiverReassigned[unwrapped] = false
	return false
}

type resultCallbackKind uint8

const (
	resultCallbackNone resultCallbackKind = iota
	resultCallbackConsumer
	resultCallbackTransformer
	resultCallbackTupleCombiner
	resultCallbackTupleConsumer
)

var curriedResultTransformerMethods = map[string]struct{}{
	"map":                    {},
	"mapErr":                 {},
	"mapError":               {},
	"andThen":                {},
	"flatMap":                {},
	"filterOrElse":           {},
	"catchTag":               {},
	"catchTags":              {},
	"catchReason":            {},
	"catchReasons":           {},
	"unwrapReason":           {},
	"tap":                    {},
	"tapError":               {},
	"tapCause":               {},
	"tapBoth":                {},
	"inspect":                {},
	"inspectError":           {},
	"inspectCause":           {},
	"inspectBoth":            {},
	"as":                     {},
	"asVoid":                 {},
	"asyncMap":               {},
	"asyncAndThen":           {},
	"sandbox":                {},
	"unsandbox":              {},
	"retryOrElse":            {},
	"timeout":                {},
	"delay":                  {},
	"timed":                  {},
	"ensuring":               {},
	"onExit":                 {},
	"when":                   {},
	"unless":                 {},
	"provideService":         {},
	"provideServices":        {},
	"provideServiceResolver": {},
}

func isResultarStaticNamespaceName(name string) bool {
	switch name {
	case "Result", "ResultAsync", "ResultTask", "Match", "Fiber":
		return true
	}
	return false
}

func (a *Analyzer) programHasResultarPackage() bool {
	if a.program == nil {
		return false
	}
	cache := a.getCache()
	if cache.hasResultarPkg != nil {
		return *cache.hasResultarPkg
	}
	has := false
	for _, sf := range a.program.SourceFiles() {
		if isResultarPackageFile(sf) {
			has = true
			break
		}
	}
	cache.hasResultarPkg = &has
	return has
}

func isAmbientDeclaration(decl *ast.Node, declFile *ast.SourceFile) bool {
	if declFile != nil && declFile.IsDeclarationFile {
		return true
	}
	for curr := decl; curr != nil; curr = curr.Parent {
		if curr.Flags&ast.NodeFlagsAmbient != 0 || curr.ModifierFlags()&ast.ModifierFlagsAmbient != 0 {
			return true
		}
	}
	return false
}

func isTopLevelDeclaration(decl *ast.Node) bool {
	if decl == nil || decl.Parent == nil {
		return false
	}
	curr := decl
	if curr.Kind == ast.KindVariableDeclaration && curr.Parent != nil && curr.Parent.Kind == ast.KindVariableDeclarationList {
		curr = curr.Parent
	}
	if curr.Kind == ast.KindVariableDeclarationList && curr.Parent != nil && curr.Parent.Kind == ast.KindVariableStatement {
		curr = curr.Parent
	}
	for curr.Parent != nil && (curr.Parent.Kind == ast.KindModuleBlock || curr.Parent.Kind == ast.KindModuleDeclaration) {
		curr = curr.Parent
	}
	return curr.Parent != nil && curr.Parent.Kind == ast.KindSourceFile
}

func (a *Analyzer) symbolHasLocalNonAmbientValueDeclaration(sym *ast.Symbol) bool {
	if sym == nil {
		return false
	}
	for _, decl := range sym.Declarations() {
		if decl == nil {
			continue
		}
		declFile := ast.GetSourceFileOfNode(decl)
		if isResultarPackageFile(declFile) {
			continue
		}
		switch decl.Kind {
		case ast.KindTypeAliasDeclaration, ast.KindInterfaceDeclaration:
			continue
		case ast.KindClassDeclaration, ast.KindClassExpression, ast.KindFunctionDeclaration, ast.KindParameter, ast.KindEnumDeclaration:
			if !isAmbientDeclaration(decl, declFile) {
				return true
			}
		case ast.KindVariableDeclaration:
			if !isAmbientDeclaration(decl, declFile) && decl.AsVariableDeclaration().Initializer == nil {
				return true
			}
		}
	}
	return false
}

func (a *Analyzer) isResultarOriginDeclaration(decl *ast.Node, sym *ast.Symbol) bool {
	if decl == nil || sym == nil || !isResultarStaticNamespaceName(sym.Name()) {
		return false
	}
	if a.symbolHasLocalNonAmbientValueDeclaration(sym) || !isTopLevelDeclaration(decl) {
		return false
	}
	switch decl.Kind {
	case ast.KindVariableDeclaration, ast.KindClassDeclaration, ast.KindModuleDeclaration:
	default:
		return false
	}
	declFile := ast.GetSourceFileOfNode(decl)
	if isResultarPackageFile(declFile) {
		return true
	}
	if a.programHasResultarPackage() {
		return false
	}
	if !isAmbientDeclaration(decl, declFile) {
		return false
	}
	switch decl.Kind {
	case ast.KindVariableDeclaration:
		if decl.AsVariableDeclaration().Initializer != nil {
			return false
		}
		return decl.Parent != nil &&
			decl.Parent.Kind == ast.KindVariableDeclarationList &&
			decl.Parent.Flags&ast.NodeFlagsConst != 0
	case ast.KindModuleDeclaration:
		return true
	case ast.KindClassDeclaration:
		return sym.Name() == "ResultTask" || sym.Name() == "ResultAsync"
	}
	return false
}

func (a *Analyzer) resolveStaticNamespaceWithVisited(node *ast.Node, visited map[*ast.Symbol]bool) string {
	node = unwrapExpression(node)
	if node == nil {
		return ""
	}
	cache := a.getCache()
	topLevel := len(visited) == 0
	if topLevel {
		if ns, ok := cache.staticNamespace[node]; ok {
			return ns
		}
	}
	if a.isCallbackReceiverReassigned(node) {
		if topLevel {
			cache.staticNamespace[node] = ""
		}
		return ""
	}
	if node.Kind == ast.KindPropertyAccessExpression || node.Kind == ast.KindElementAccessExpression {
		if propInit := a.resolveObjectLiteralPropertyInitializer(node, cloneSymbolVisited(visited)); propInit != nil {
			ns := a.resolveStaticNamespaceWithVisited(propInit, visited)
			if topLevel {
				cache.staticNamespace[node] = ns
			}
			return ns
		}
	}
	sym := a.resolveSymbolAtNode(node)
	if sym == nil {
		if topLevel {
			cache.staticNamespace[node] = ""
		}
		return ""
	}
	callFile := ast.GetSourceFileOfNode(node)
	ns := a.resolveStaticNamespaceFromSymbol(sym, callFile, visited)
	if topLevel {
		cache.staticNamespace[node] = ns
	}
	return ns
}

func (a *Analyzer) resolveStaticNamespaceFromSymbol(sym *ast.Symbol, callFile *ast.SourceFile, visited map[*ast.Symbol]bool) string {
	if sym == nil || a.symbolHasLocalNonAmbientValueDeclaration(sym) {
		return ""
	}
	if visited == nil {
		visited = make(map[*ast.Symbol]bool)
	}
	if visited[sym] {
		return ""
	}
	visited[sym] = true
	for _, decl := range sym.Declarations() {
		if decl == nil {
			continue
		}
		if a.isResultarOriginDeclaration(decl, sym) {
			return sym.Name()
		}
		declFile := ast.GetSourceFileOfNode(decl)
		switch decl.Kind {
		case ast.KindVariableDeclaration:
			varDecl := decl.AsVariableDeclaration()
			if varDecl.Initializer == nil {
				continue
			}
			isConst := decl.Parent != nil &&
				decl.Parent.Kind == ast.KindVariableDeclarationList &&
				decl.Parent.Flags&ast.NodeFlagsConst != 0
			if !isConst && a.isSymbolReassigned(sym, declFile, callFile) {
				return ""
			}
			if ns := a.resolveStaticNamespaceWithVisited(varDecl.Initializer, visited); ns != "" {
				return ns
			}
		case ast.KindBindingElement:
			recv, propName, isConst, ok := a.bindingElementTarget(decl)
			if !ok || (!isConst && a.isSymbolReassigned(sym, declFile, callFile)) || a.isCallbackReceiverReassigned(recv) {
				return ""
			}
			if recvSym := a.resolveSymbolAtNode(recv); recvSym != nil && a.isPropertyOnSymbolReassigned(recvSym, propName, declFile, callFile) {
				return ""
			}
			if propInit := a.resolveObjectLiteralPropertyInitializerFromRecv(recv, propName, cloneSymbolVisited(visited)); propInit != nil {
				if ns := a.resolveStaticNamespaceWithVisited(propInit, visited); ns != "" {
					return ns
				}
			}
			if recvType := a.checker.GetTypeAtLocation(recv); recvType != nil {
				if propSym := a.resolveAliasedSymbol(a.checker.GetPropertyOfType(recvType, propName)); propSym != nil {
					if ns := a.resolveStaticNamespaceFromSymbol(propSym, callFile, visited); ns != "" {
						return ns
					}
				}
			}
		case ast.KindPropertyAssignment:
			if a.isSymbolReassigned(sym, declFile, callFile) {
				return ""
			}
			if ns := a.resolveStaticNamespaceWithVisited(decl.AsPropertyAssignment().Initializer, visited); ns != "" {
				return ns
			}
		case ast.KindShorthandPropertyAssignment:
			if a.isSymbolReassigned(sym, declFile, callFile) {
				return ""
			}
			valSym := a.resolveAliasedSymbol(a.checker.GetShorthandAssignmentValueSymbol(decl))
			if valSym != nil && valSym != sym {
				if ns := a.resolveStaticNamespaceFromSymbol(valSym, callFile, visited); ns != "" {
					return ns
				}
			}
		case ast.KindPropertyDeclaration:
			propDecl := decl.AsPropertyDeclaration()
			if propDecl.Initializer == nil || a.isSymbolReassigned(sym, declFile, callFile) {
				return ""
			}
			if ns := a.resolveStaticNamespaceWithVisited(propDecl.Initializer, visited); ns != "" {
				return ns
			}
		case ast.KindExportAssignment:
			exportAssign := decl.AsExportAssignment()
			if exportAssign.Expression != nil {
				if ns := a.resolveStaticNamespaceWithVisited(exportAssign.Expression, visited); ns != "" {
					return ns
				}
			}
		case ast.KindTypeAliasDeclaration, ast.KindInterfaceDeclaration:
			continue
		default:
			return ""
		}
	}
	return ""
}

func (a *Analyzer) staticMemberAccess(expression *ast.Node) (string, string) {
	return a.staticMemberAccessWithVisited(expression, nil)
}

func (a *Analyzer) staticMemberAccessWithVisited(expression *ast.Node, visited map[*ast.Symbol]bool) (string, string) {
	expression = unwrapExpression(expression)
	if expression == nil {
		return "", ""
	}
	cache := a.getCache()
	topLevel := len(visited) == 0
	if topLevel {
		if pair, ok := cache.staticMember[expression]; ok {
			return pair[0], pair[1]
		}
	}
	save := func(ns, member string) (string, string) {
		if topLevel {
			cache.staticMember[expression] = [2]string{ns, member}
		}
		return ns, member
	}
	switch expression.Kind {
	case ast.KindPropertyAccessExpression:
		if expression.Name() == nil {
			return save("", "")
		}
		recv := expression.AsPropertyAccessExpression().Expression
		propName := expression.Name().Text()
		if ns := a.resolveStaticNamespaceWithVisited(recv, cloneSymbolVisited(visited)); ns != "" {
			if a.isCallbackReceiverReassigned(expression) {
				return save("", "")
			}
			return save(ns, propName)
		}
	case ast.KindElementAccessExpression:
		elem := expression.AsElementAccessExpression()
		propName, ok := a.staticElementIndex(elem.ArgumentExpression)
		if !ok {
			return save("", "")
		}
		if ns := a.resolveStaticNamespaceWithVisited(elem.Expression, cloneSymbolVisited(visited)); ns != "" {
			if a.isCallbackReceiverReassigned(expression) {
				return save("", "")
			}
			return save(ns, propName)
		}
	case ast.KindIdentifier:
	default:
		return save("", "")
	}
	if expression.Kind == ast.KindPropertyAccessExpression || expression.Kind == ast.KindElementAccessExpression {
		if propInit := a.resolveObjectLiteralPropertyInitializer(expression, cloneSymbolVisited(visited)); propInit != nil {
			ns, member := a.staticMemberAccessWithVisited(propInit, visited)
			if ns != "" && member != "" && !a.isCallbackReceiverReassigned(expression) {
				return save(ns, member)
			}
			return save("", "")
		}
	}
	sym := a.resolveSymbolAtNode(expression)
	if sym != nil {
		if visited == nil {
			visited = make(map[*ast.Symbol]bool)
		}
		if visited[sym] {
			return "", ""
		}
		visited[sym] = true
		callFile := ast.GetSourceFileOfNode(expression)
		if ns, member := a.staticMemberAccessFromSymbolDeclarations(sym, callFile, visited); ns != "" && member != "" {
			if a.isCallbackReceiverReassigned(expression) {
				return save("", "")
			}
			return save(ns, member)
		}
	}
	return save("", "")
}

func (a *Analyzer) staticMemberAccessFromSymbolDeclarations(sym *ast.Symbol, callFile *ast.SourceFile, visited map[*ast.Symbol]bool) (string, string) {
	for _, decl := range sym.Declarations() {
		if decl == nil {
			continue
		}
		declFile := ast.GetSourceFileOfNode(decl)
		switch decl.Kind {
		case ast.KindVariableDeclaration:
			varDecl := decl.AsVariableDeclaration()
			if varDecl.Initializer == nil {
				continue
			}
			isConst := decl.Parent != nil &&
				decl.Parent.Kind == ast.KindVariableDeclarationList &&
				decl.Parent.Flags&ast.NodeFlagsConst != 0
			if !isConst && a.isSymbolReassigned(sym, declFile, callFile) {
				continue
			}
			if ns, member := a.staticMemberAccessWithVisited(varDecl.Initializer, visited); ns != "" && member != "" {
				return ns, member
			}
		case ast.KindBindingElement:
			recv, propName, isConst, ok := a.bindingElementTarget(decl)
			if !ok || (!isConst && a.isSymbolReassigned(sym, declFile, callFile)) || a.isCallbackReceiverReassigned(recv) {
				continue
			}
			if recvSym := a.resolveSymbolAtNode(recv); recvSym != nil && a.isPropertyOnSymbolReassigned(recvSym, propName, declFile, callFile) {
				continue
			}
			if ns := a.resolveStaticNamespaceWithVisited(recv, cloneSymbolVisited(visited)); ns != "" {
				return ns, propName
			}
			if propInit := a.resolveObjectLiteralPropertyInitializerFromRecv(recv, propName, cloneSymbolVisited(visited)); propInit != nil {
				if ns, member := a.staticMemberAccessWithVisited(propInit, visited); ns != "" && member != "" {
					return ns, member
				}
			}
			if recvType := a.checker.GetTypeAtLocation(recv); recvType != nil {
				if propSym := a.resolveAliasedSymbol(a.checker.GetPropertyOfType(recvType, propName)); propSym != nil && !visited[propSym] {
					visited[propSym] = true
					if ns, member := a.staticMemberAccessFromSymbolDeclarations(propSym, callFile, visited); ns != "" && member != "" {
						return ns, member
					}
				}
			}
		case ast.KindPropertyAssignment:
			if a.isSymbolReassigned(sym, declFile, callFile) {
				continue
			}
			if ns, member := a.staticMemberAccessWithVisited(decl.AsPropertyAssignment().Initializer, visited); ns != "" && member != "" {
				return ns, member
			}
		case ast.KindShorthandPropertyAssignment:
			if a.isSymbolReassigned(sym, declFile, callFile) {
				continue
			}
			valSym := a.resolveAliasedSymbol(a.checker.GetShorthandAssignmentValueSymbol(decl))
			if valSym != nil && !visited[valSym] {
				visited[valSym] = true
				if ns, member := a.staticMemberAccessFromSymbolDeclarations(valSym, callFile, visited); ns != "" && member != "" {
					return ns, member
				}
			}
		case ast.KindPropertyDeclaration:
			propDecl := decl.AsPropertyDeclaration()
			if propDecl.Initializer == nil || a.isSymbolReassigned(sym, declFile, callFile) {
				continue
			}
			if ns, member := a.staticMemberAccessWithVisited(propDecl.Initializer, visited); ns != "" && member != "" {
				return ns, member
			}
		case ast.KindExportAssignment:
			exportAssign := decl.AsExportAssignment()
			if exportAssign.Expression != nil {
				if ns, member := a.staticMemberAccessWithVisited(exportAssign.Expression, visited); ns != "" && member != "" {
					return ns, member
				}
			}
		}
	}
	return "", ""
}

func isZeroArgCurriedMethod(member string) bool {
	switch member {
	case "asVoid", "sandbox", "unsandbox", "unwrapOrThrow", "_unsafeUnwrap", "_unsafeUnwrapErr",
		"runResult", "runPromise", "runExit", "runFork", "toResultAsync",
		"join", "await", "interrupt", "exhaustive", "orElseAbsurd", "option", "result", "tagsExhaustive":
		return true
	}
	return false
}

func (a *Analyzer) isResultarUtilityFunction(node *ast.Node, expectedName string) bool {
	return a.isResultarUtilityFunctionWithVisited(node, expectedName, nil)
}

func (a *Analyzer) isResultarUtilityFunctionWithVisited(node *ast.Node, expectedName string, visited map[*ast.Symbol]bool) bool {
	node = unwrapExpression(node)
	if node == nil || a.isCallbackReceiverReassigned(node) {
		return false
	}
	if node.Kind == ast.KindPropertyAccessExpression || node.Kind == ast.KindElementAccessExpression {
		if propInit := a.resolveObjectLiteralPropertyInitializer(node, cloneSymbolVisited(visited)); propInit != nil {
			return a.isResultarUtilityFunctionWithVisited(propInit, expectedName, visited)
		}
	}
	sym := a.resolveSymbolAtNode(node)
	if sym == nil || a.symbolHasLocalNonAmbientValueDeclaration(sym) {
		return false
	}
	if visited == nil {
		visited = make(map[*ast.Symbol]bool)
	}
	if visited[sym] {
		return false
	}
	visited[sym] = true
	callFile := ast.GetSourceFileOfNode(node)
	for _, decl := range sym.Declarations() {
		if decl == nil {
			continue
		}
		declFile := ast.GetSourceFileOfNode(decl)
		if sym.Name() == expectedName && isTopLevelDeclaration(decl) {
			switch decl.Kind {
			case ast.KindFunctionDeclaration, ast.KindVariableDeclaration:
				if isResultarPackageFile(declFile) {
					return true
				}
				if !a.programHasResultarPackage() && isAmbientDeclaration(decl, declFile) {
					if decl.Kind == ast.KindFunctionDeclaration {
						return true
					}
					if decl.AsVariableDeclaration().Initializer == nil &&
						decl.Parent != nil &&
						decl.Parent.Kind == ast.KindVariableDeclarationList &&
						decl.Parent.Flags&ast.NodeFlagsConst != 0 {
						return true
					}
				}
			}
		}
		switch decl.Kind {
		case ast.KindVariableDeclaration:
			varDecl := decl.AsVariableDeclaration()
			if varDecl.Initializer == nil {
				continue
			}
			isConst := decl.Parent != nil &&
				decl.Parent.Kind == ast.KindVariableDeclarationList &&
				decl.Parent.Flags&ast.NodeFlagsConst != 0
			if !isConst && a.isSymbolReassigned(sym, declFile, callFile) {
				return false
			}
			if a.isResultarUtilityFunctionWithVisited(varDecl.Initializer, expectedName, visited) {
				return true
			}
		case ast.KindBindingElement:
			recv, propName, isConst, ok := a.bindingElementTarget(decl)
			if !ok || (!isConst && a.isSymbolReassigned(sym, declFile, callFile)) || a.isCallbackReceiverReassigned(recv) {
				return false
			}
			if propInit := a.resolveObjectLiteralPropertyInitializerFromRecv(recv, propName, cloneSymbolVisited(visited)); propInit != nil {
				if a.isResultarUtilityFunctionWithVisited(propInit, expectedName, visited) {
					return true
				}
			}
		case ast.KindPropertyAssignment:
			if !a.isSymbolReassigned(sym, declFile, callFile) &&
				a.isResultarUtilityFunctionWithVisited(decl.AsPropertyAssignment().Initializer, expectedName, visited) {
				return true
			}
		case ast.KindShorthandPropertyAssignment:
			if !a.isSymbolReassigned(sym, declFile, callFile) {
				if valSym := a.resolveAliasedSymbol(a.checker.GetShorthandAssignmentValueSymbol(decl)); valSym != nil && valSym != sym {
					for _, valDecl := range valSym.Declarations() {
						if valDecl != nil && valDecl.Name() != nil &&
							a.isResultarUtilityFunctionWithVisited(valDecl.Name(), expectedName, visited) {
							return true
						}
					}
				}
			}
		case ast.KindPropertyDeclaration:
			if decl.AsPropertyDeclaration().Initializer != nil &&
				!a.isSymbolReassigned(sym, declFile, callFile) &&
				a.isResultarUtilityFunctionWithVisited(decl.AsPropertyDeclaration().Initializer, expectedName, visited) {
				return true
			}
		}
	}
	return false
}

func (a *Analyzer) isFlowFunction(node *ast.Node) bool {
	return a.isFlowFunctionWithVisited(node, nil)
}

func (a *Analyzer) isFlowFunctionWithVisited(node *ast.Node, visited map[*ast.Symbol]bool) bool {
	return a.isResultarUtilityFunctionWithVisited(node, "flow", visited)
}

func (a *Analyzer) isPipeFunction(node *ast.Node) bool {
	return a.isResultarUtilityFunction(node, "pipe") || a.canonicalExpressionName(node) == "pipe"
}

func (a *Analyzer) variableIsReassignedInNode(symbol *ast.Symbol, root *ast.Node) bool {
	if symbol == nil || root == nil {
		return true
	}
	reassigned := false
	visit(root, func(node *ast.Node) {
		if reassigned || node == nil {
			return
		}
		switch node.Kind {
		case ast.KindBinaryExpression:
			bin := node.AsBinaryExpression()
			if isAssignmentOperatorKind(bin.OperatorToken.Kind) && a.nodeReferencesSymbol(bin.Left, symbol) {
				reassigned = true
			}
		case ast.KindPrefixUnaryExpression:
			u := node.AsPrefixUnaryExpression()
			if (u.Operator == ast.KindPlusPlusToken || u.Operator == ast.KindMinusMinusToken) && a.nodeReferencesSymbol(u.Operand, symbol) {
				reassigned = true
			}
		case ast.KindPostfixUnaryExpression:
			u := node.AsPostfixUnaryExpression()
			if (u.Operator == ast.KindPlusPlusToken || u.Operator == ast.KindMinusMinusToken) && a.nodeReferencesSymbol(u.Operand, symbol) {
				reassigned = true
			}
		case ast.KindForInStatement, ast.KindForOfStatement:
			init := node.AsForInOrOfStatement().Initializer
			if init != nil && init.Kind != ast.KindVariableDeclarationList && a.nodeReferencesSymbol(init, symbol) {
				reassigned = true
			}
		}
	})
	return reassigned
}

func (a *Analyzer) isInlineIdentityFunction(fn *ast.Node) bool {
	return a.isInlineIdentityFunctionWithVisited(fn, nil, 0)
}

func (a *Analyzer) isInlineIdentityFunctionWithVisited(fn *ast.Node, visited map[*ast.Symbol]bool, depth int) bool {
	if depth > 8 || fn == nil || !isFunctionLikeNode(fn) || fn.Body() == nil {
		return false
	}
	params := fn.Parameters()
	if len(params) == 0 {
		return false
	}
	paramDecl := params[0]
	if paramDecl == nil || paramDecl.AsParameterDeclaration().DotDotDotToken != nil || paramDecl.Name() == nil || paramDecl.Name().Kind != ast.KindIdentifier {
		return false
	}
	retExprs, ok := functionReturnedCallbackExpressions(fn)
	if !ok || len(retExprs) == 0 {
		return false
	}
	paramSym := a.resolveSymbolAtNode(paramDecl.Name())
	if paramSym == nil {
		return false
	}
	fnSyms := a.functionReferencesForNode(fn)
	nextVisited := cloneSymbolVisited(visited)
	if nextVisited == nil {
		nextVisited = make(map[*ast.Symbol]bool, len(fnSyms))
	}
	for _, sym := range fnSyms {
		if sym == nil {
			continue
		}
		if nextVisited[sym] {
			return false
		}
		nextVisited[sym] = true
	}
	var callees []*ast.Node
	for _, retExpr := range retExprs {
		unwrapped := unwrapExpression(retExpr)
		for unwrapped != nil && unwrapped.Kind == ast.KindCallExpression {
			call := unwrapped.AsCallExpression()
			if len(call.Arguments.Nodes) == 1 {
				if a.callMatchesFunction(call.Expression, fn, fnSyms) {
					return false
				}
				callees = append(callees, call.Expression)
				unwrapped = unwrapExpression(call.Arguments.Nodes[0])
				continue
			}
			break
		}
		if unwrapped == nil || unwrapped.Kind != ast.KindIdentifier || a.resolveSymbolAtNode(unwrapped) != paramSym {
			return false
		}
	}
	if a.variableIsReassignedInNode(paramSym, fn) {
		return false
	}
	for _, callee := range callees {
		if !a.isIdentityCallbackWithVisited(callee, cloneSymbolVisited(nextVisited), depth+1) {
			return false
		}
	}
	return true
}

func (a *Analyzer) isIdentityCallback(node *ast.Node) bool {
	return a.isIdentityCallbackWithVisited(node, nil, 0)
}

func (a *Analyzer) isIdentityCallbackWithVisited(node *ast.Node, visited map[*ast.Symbol]bool, depth int) bool {
	if depth > 8 {
		return false
	}
	node = unwrapExpression(node)
	if node == nil {
		return false
	}
	cache := a.getCache()
	if len(visited) == 0 {
		if res, ok := cache.identityCallback[node]; ok {
			return res
		}
	}
	save := func(res bool) bool {
		if len(visited) == 0 && depth <= 4 {
			cache.identityCallback[node] = res
		}
		return res
	}
	if a.isResultarUtilityFunctionWithVisited(node, "identity", cloneSymbolVisited(visited)) {
		return save(true)
	}
	if isFunctionLikeNode(node) {
		return save(a.isInlineIdentityFunctionWithVisited(node, cloneSymbolVisited(visited), depth+1))
	}
	if a.classifyResultCallbackWithVisited(node, cloneSymbolVisited(visited), depth+1) != resultCallbackNone {
		return save(false)
	}
	if node.Kind == ast.KindCallExpression {
		call := node.AsCallExpression()
		if method, recv, _ := methodCall(node); method == "bind" && len(call.Arguments.Nodes) <= 1 {
			return save(a.isIdentityCallbackWithVisited(recv, visited, depth+1))
		}
		if len(call.Arguments.Nodes) == 1 && a.isIdentityCallbackWithVisited(call.Expression, cloneSymbolVisited(visited), depth+1) {
			return save(a.isIdentityCallbackWithVisited(call.Arguments.Nodes[0], visited, depth+1))
		}
		if len(call.Arguments.Nodes) >= 1 && a.isFlowFunctionWithVisited(call.Expression, cloneSymbolVisited(visited)) {
			for _, arg := range call.Arguments.Nodes {
				if !a.isIdentityCallbackWithVisited(arg, cloneSymbolVisited(visited), depth+1) {
					return save(false)
				}
			}
			return save(true)
		}
	}
	sym := a.resolveSymbolAtNode(node)
	if sym != nil && visited[sym] {
		return false
	}
	targets, ok := a.resolveCallbackTargetsWithVisited(node, cloneSymbolVisited(visited), depth+1)
	if !ok || len(targets) == 0 {
		return save(false)
	}
	for _, target := range targets {
		targetVisited := cloneSymbolVisited(visited)
		if sym != nil {
			inFnSyms := false
			for _, fnSym := range a.functionReferencesForNode(target) {
				if fnSym == sym {
					inFnSyms = true
					break
				}
			}
			if !inFnSyms {
				if targetVisited == nil {
					targetVisited = make(map[*ast.Symbol]bool, 1)
				}
				targetVisited[sym] = true
			}
		}
		if a.isResultarUtilityFunctionWithVisited(target, "identity", cloneSymbolVisited(targetVisited)) {
			continue
		}
		if !a.isInlineIdentityFunctionWithVisited(target, cloneSymbolVisited(targetVisited), depth+1) {
			return save(false)
		}
	}
	return save(true)
}

func (a *Analyzer) classifyCallbackOrResolved(expr *ast.Node) resultCallbackKind {
	return a.classifyCallbackOrResolvedWithVisited(expr, nil, 0)
}

func (a *Analyzer) classifyCallbackOrResolvedWithVisited(expr *ast.Node, visited map[*ast.Symbol]bool, depth int) resultCallbackKind {
	if depth > 8 {
		return resultCallbackNone
	}
	if kind := a.classifyResultCallbackWithVisited(expr, cloneSymbolVisited(visited), depth+1); kind != resultCallbackNone {
		return kind
	}
	targets, ok := a.resolveCallbackTargetsWithVisited(expr, cloneSymbolVisited(visited), depth+1)
	if !ok || len(targets) == 0 {
		return resultCallbackNone
	}
	var common resultCallbackKind
	for i, t := range targets {
		k := a.classifyResultCallbackWithVisited(t, cloneSymbolVisited(visited), depth+1)
		if k == resultCallbackNone {
			return resultCallbackNone
		}
		if i == 0 {
			common = k
		} else if common != k {
			return resultCallbackNone
		}
	}
	return common
}

func (a *Analyzer) classifyFlowCallback(args []*ast.Node) resultCallbackKind {
	return a.classifyFlowCallbackWithVisited(args, nil, 0)
}

func (a *Analyzer) classifyFlowCallbackWithVisited(args []*ast.Node, visited map[*ast.Symbol]bool, depth int) resultCallbackKind {
	if depth > 8 || len(args) == 0 {
		return resultCallbackNone
	}
	state := resultCallbackNone
	for i, arg := range args {
		if a.isIdentityCallbackWithVisited(arg, cloneSymbolVisited(visited), depth+1) {
			continue
		}
		kind := a.classifyCallbackOrResolvedWithVisited(arg, cloneSymbolVisited(visited), depth+1)
		if i == 0 && kind == resultCallbackTupleCombiner {
			state = resultCallbackTupleCombiner
			continue
		}
		switch state {
		case resultCallbackNone, resultCallbackTransformer:
			switch kind {
			case resultCallbackTransformer:
				state = resultCallbackTransformer
			case resultCallbackConsumer:
				return resultCallbackConsumer
			default:
				return resultCallbackNone
			}
		case resultCallbackTupleCombiner:
			switch kind {
			case resultCallbackTransformer:
				state = resultCallbackTupleCombiner
			case resultCallbackConsumer:
				return resultCallbackTupleConsumer
			default:
				return resultCallbackNone
			}
		default:
			return resultCallbackNone
		}
	}
	return state
}

func (a *Analyzer) classifyResultCallback(node *ast.Node) resultCallbackKind {
	return a.classifyResultCallbackWithVisited(node, nil, 0)
}

func (a *Analyzer) classifyResultCallbackWithVisited(node *ast.Node, visited map[*ast.Symbol]bool, depth int) resultCallbackKind {
	if depth > 8 {
		return resultCallbackNone
	}
	node = unwrapExpression(node)
	if node == nil {
		return resultCallbackNone
	}
	cache := a.getCache()
	if len(visited) == 0 {
		if kind, ok := cache.callbackKind[node]; ok {
			return kind
		}
	}
	save := func(kind resultCallbackKind) resultCallbackKind {
		if len(visited) == 0 && depth <= 4 {
			cache.callbackKind[node] = kind
		}
		return kind
	}
	if node.Kind == ast.KindCallExpression {
		call := node.AsCallExpression()
		if method, recv, _ := methodCall(node); method == "bind" && len(call.Arguments.Nodes) <= 1 {
			return save(a.classifyResultCallbackWithVisited(recv, visited, depth+1))
		}
		callType := a.checker.GetTypeAtLocation(node)
		if callType == nil || len(a.checker.GetCallSignatures(callType)) == 0 {
			return save(resultCallbackNone)
		}
		args := call.Arguments.Nodes
		firstArgIsResult := len(args) > 0 && isResultLikeType(a.checker.GetTypeAtLocation(args[0]))
		if !firstArgIsResult {
			ns, member := a.staticMemberAccessWithVisited(call.Expression, cloneSymbolVisited(visited))
			switch ns {
			case "Result", "ResultAsync", "ResultTask":
				if len(args) == 0 && !isZeroArgCurriedMethod(member) {
					return save(resultCallbackNone)
				}
				if member == "validateAll" && len(args) == 1 {
					return save(resultCallbackTupleCombiner)
				}
				if _, ok := consumerMethods[member]; ok {
					return save(resultCallbackConsumer)
				}
				if _, ok := resultTaskInstanceRunnerMethods[member]; ok {
					return save(resultCallbackConsumer)
				}
				if _, ok := curriedResultTransformerMethods[member]; ok {
					return save(resultCallbackTransformer)
				}
			case "Match":
				if len(args) == 0 && !isZeroArgCurriedMethod(member) {
					return save(resultCallbackNone)
				}
				if _, ok := consumerMethods[member]; ok {
					return save(resultCallbackConsumer)
				}
				if _, ok := matchStaticConsumerMethods[member]; ok {
					return save(resultCallbackTransformer)
				}
			case "Fiber":
				if _, ok := fiberStaticConsumerMethods[member]; ok {
					return save(resultCallbackConsumer)
				}
			}
		}
		if len(args) == 1 && a.isIdentityCallbackWithVisited(call.Expression, cloneSymbolVisited(visited), depth+1) {
			return save(a.classifyCallbackOrResolvedWithVisited(args[0], cloneSymbolVisited(visited), depth+1))
		}
		if len(args) >= 1 && a.isFlowFunctionWithVisited(call.Expression, cloneSymbolVisited(visited)) {
			if flowKind := a.classifyFlowCallbackWithVisited(args, cloneSymbolVisited(visited), depth+1); flowKind != resultCallbackNone {
				return save(flowKind)
			}
		}
		return save(resultCallbackNone)
	}
	ns, member := a.staticMemberAccessWithVisited(node, cloneSymbolVisited(visited))
	switch ns {
	case "Result", "ResultAsync", "ResultTask":
		switch member {
		case "combine", "all", "combineWithAllErrors", "validateAll", "firstSuccessOf":
			return save(resultCallbackTupleCombiner)
		case "unwrapOrThrow", "_unsafeUnwrap", "_unsafeUnwrapErr", "isOk", "isErr",
			"runResult", "runPromise", "runExit", "runFork", "toResultAsync":
			return save(resultCallbackConsumer)
		case "fromResult", "fromTask", "fromResultAsync", "asVoid", "sandbox", "unsandbox":
			return save(resultCallbackTransformer)
		}
	case "Match":
		switch member {
		case "exhaustive", "orElseAbsurd", "option", "result", "tagsExhaustive":
			return save(resultCallbackConsumer)
		case "value":
			return save(resultCallbackTransformer)
		}
	case "Fiber":
		if _, ok := fiberStaticConsumerMethods[member]; ok {
			return save(resultCallbackConsumer)
		}
	}
	if a.isResultarUtilityFunctionWithVisited(node, "runSync", cloneSymbolVisited(visited)) ||
		a.isResultarUtilityFunctionWithVisited(node, "runPromise", cloneSymbolVisited(visited)) {
		return save(resultCallbackConsumer)
	}
	return save(resultCallbackNone)
}

func statementAlwaysReturns(stmt *ast.Node) bool {
	if stmt == nil {
		return false
	}
	switch stmt.Kind {
	case ast.KindReturnStatement:
		return stmt.AsReturnStatement().Expression != nil
	case ast.KindBlock:
		for _, child := range stmt.Statements() {
			if statementAlwaysReturns(child) {
				return true
			}
		}
		return false
	case ast.KindIfStatement:
		ifStmt := stmt.AsIfStatement()
		return ifStmt.ElseStatement != nil &&
			statementAlwaysReturns(ifStmt.ThenStatement) &&
			statementAlwaysReturns(ifStmt.ElseStatement)
	}
	return false
}

func appendConditionalBranches(dst []*ast.Node, expr *ast.Node) []*ast.Node {
	unwrapped := unwrapExpression(expr)
	if unwrapped != nil && unwrapped.Kind == ast.KindConditionalExpression {
		cond := unwrapped.AsConditionalExpression()
		dst = appendConditionalBranches(dst, cond.WhenTrue)
		dst = appendConditionalBranches(dst, cond.WhenFalse)
		return dst
	}
	return append(dst, expr)
}

func functionReturnedCallbackExpressions(fn *ast.Node) ([]*ast.Node, bool) {
	if fn == nil || !isFunctionLikeNode(fn) || fn.Body() == nil {
		return nil, false
	}
	body := fn.Body()
	if fn.Kind == ast.KindArrowFunction && body.Kind != ast.KindBlock {
		return appendConditionalBranches(nil, body), true
	}
	if body.Kind != ast.KindBlock || !statementAlwaysReturns(body) {
		return nil, false
	}
	exprs := make([]*ast.Node, 0, 2)
	hasEmptyReturn := false
	var inspect func(*ast.Node)
	inspect = func(n *ast.Node) {
		if n == nil || hasEmptyReturn {
			return
		}
		if n != body && isFunctionLikeNode(n) {
			return
		}
		if n.Kind == ast.KindReturnStatement {
			retExpr := n.AsReturnStatement().Expression
			if retExpr == nil {
				hasEmptyReturn = true
				return
			}
			exprs = appendConditionalBranches(exprs, retExpr)
			return
		}
		n.ForEachChild(func(child *ast.Node) bool {
			inspect(child)
			return false
		})
	}
	inspect(body)
	if hasEmptyReturn || len(exprs) == 0 {
		return nil, false
	}
	return exprs, true
}

func (a *Analyzer) resolveObjectLiteralPropertyInitializer(access *ast.Node, visited map[*ast.Symbol]bool) *ast.Node {
	access = unwrapExpression(access)
	if access == nil {
		return nil
	}
	var recv *ast.Node
	var propName string
	switch access.Kind {
	case ast.KindPropertyAccessExpression:
		if access.Name() == nil {
			return nil
		}
		recv = unwrapExpression(access.AsPropertyAccessExpression().Expression)
		propName = access.Name().Text()
	case ast.KindElementAccessExpression:
		elem := access.AsElementAccessExpression()
		name, ok := a.staticElementIndex(elem.ArgumentExpression)
		if !ok {
			return nil
		}
		recv = unwrapExpression(elem.Expression)
		propName = name
	default:
		return nil
	}
	return a.resolveObjectLiteralPropertyInitializerFromRecv(recv, propName, visited)
}

func (a *Analyzer) resolvePropertyFromObjectLiteralNode(objLit *ast.Node, propName string, visited map[*ast.Symbol]bool) *ast.Node {
	if objLit == nil || objLit.Kind != ast.KindObjectLiteralExpression || propName == "" {
		return nil
	}
	var found *ast.Node
	for _, prop := range objLit.AsObjectLiteralExpression().Properties.Nodes {
		if prop == nil {
			continue
		}
		if prop.Kind == ast.KindSpreadAssignment {
			spreadTarget := a.resolveObjectLiteralPropertyInitializerFromRecv(prop.Expression(), propName, cloneSymbolVisited(visited))
			if spreadTarget == nil {
				return nil
			}
			found = spreadTarget
			continue
		}
		name := getMemberDeclarationName(a, prop)
		if name == "" {
			return nil
		}
		if name != propName {
			continue
		}
		switch prop.Kind {
		case ast.KindPropertyAssignment:
			found = prop.AsPropertyAssignment().Initializer
		case ast.KindShorthandPropertyAssignment:
			found = prop.Name()
		case ast.KindMethodDeclaration:
			found = prop
		default:
			return nil
		}
	}
	return found
}

func (a *Analyzer) resolveObjectLiteralPropertyInitializerFromRecv(recv *ast.Node, propName string, visited map[*ast.Symbol]bool) *ast.Node {
	if recv == nil || propName == "" || len(visited) > 16 {
		return nil
	}
	if visited == nil {
		visited = make(map[*ast.Symbol]bool)
	}
	objLit := a.resolveObjectLiteralNode(recv, visited)
	if objLit == nil || objLit.Kind != ast.KindObjectLiteralExpression {
		return nil
	}
	return a.resolvePropertyFromObjectLiteralNode(objLit, propName, visited)
}

func (a *Analyzer) resolveObjectLiteralNode(node *ast.Node, visited map[*ast.Symbol]bool) *ast.Node {
	node = unwrapExpression(node)
	if node == nil || len(visited) > 16 {
		return nil
	}
	if node.Kind == ast.KindObjectLiteralExpression {
		return node
	}
	sym := a.resolveSymbolAtNode(node)
	if sym == nil {
		return nil
	}
	if visited == nil {
		visited = make(map[*ast.Symbol]bool)
	}
	if visited[sym] {
		return nil
	}
	visited[sym] = true
	callFile := ast.GetSourceFileOfNode(node)
	for _, decl := range sym.Declarations() {
		if decl == nil {
			continue
		}
		declFile := ast.GetSourceFileOfNode(decl)
		switch decl.Kind {
		case ast.KindVariableDeclaration:
			varDecl := decl.AsVariableDeclaration()
			if varDecl.Initializer == nil {
				continue
			}
			isConst := decl.Parent != nil &&
				decl.Parent.Kind == ast.KindVariableDeclarationList &&
				decl.Parent.Flags&ast.NodeFlagsConst != 0
			if !isConst && a.isSymbolReassigned(sym, declFile, callFile) {
				continue
			}
			if resolved := a.resolveObjectLiteralNode(varDecl.Initializer, visited); resolved != nil {
				return resolved
			}
		case ast.KindBindingElement:
			recv, propName, isConst, ok := a.bindingElementTarget(decl)
			if !ok || (!isConst && a.isSymbolReassigned(sym, declFile, callFile)) || a.isCallbackReceiverReassigned(recv) {
				continue
			}
			if recvSym := a.resolveSymbolAtNode(recv); recvSym != nil && a.isPropertyOnSymbolReassigned(recvSym, propName, declFile, callFile) {
				continue
			}
			if propInit := a.resolveObjectLiteralPropertyInitializerFromRecv(recv, propName, cloneSymbolVisited(visited)); propInit != nil {
				if resolved := a.resolveObjectLiteralNode(propInit, visited); resolved != nil {
					return resolved
				}
			}
		}
	}
	return nil
}

func getMemberDeclarationName(a *Analyzer, member *ast.Node) string {
	if member == nil || member.Name() == nil {
		return ""
	}
	nameNode := member.Name()
	switch nameNode.Kind {
	case ast.KindIdentifier, ast.KindStringLiteral, ast.KindNumericLiteral, ast.KindNoSubstitutionTemplateLiteral, ast.KindPrivateIdentifier:
		return nameNode.Text()
	case ast.KindComputedPropertyName:
		if a != nil {
			if name, ok := a.staticElementIndex(nameNode.Expression()); ok {
				return name
			}
		}
	}
	return ""
}

func isStaticMemberDeclaration(member *ast.Node) bool {
	return member != nil && member.ModifierFlags()&ast.ModifierFlagsStatic != 0
}

func getClassExtendsExpressions(classNode *ast.Node) []*ast.Node {
	if classNode == nil || (classNode.Kind != ast.KindClassDeclaration && classNode.Kind != ast.KindClassExpression) {
		return nil
	}
	heritageElements := classNode.ClassLikeData().HeritageClauses
	if heritageElements == nil {
		return nil
	}
	var exprs []*ast.Node
	for _, clause := range heritageElements.Nodes {
		if clause == nil || clause.Kind != ast.KindHeritageClause {
			continue
		}
		hc := clause.AsHeritageClause()
		if hc.Token != ast.KindExtendsKeyword || hc.Types == nil {
			continue
		}
		for _, typeNode := range hc.Types.Nodes {
			if typeNode != nil && typeNode.Expression() != nil {
				exprs = append(exprs, typeNode.Expression())
			}
		}
	}
	return exprs
}

func (a *Analyzer) resolveClassLikeNodeFromExpression(expr *ast.Node, visited map[*ast.Symbol]bool) *ast.Node {
	expr = unwrapExpression(expr)
	if expr == nil || len(visited) > 16 {
		return nil
	}
	if expr.Kind == ast.KindClassDeclaration || expr.Kind == ast.KindClassExpression {
		return expr
	}
	if expr.Kind == ast.KindPropertyAccessExpression || expr.Kind == ast.KindElementAccessExpression {
		if visited == nil {
			visited = make(map[*ast.Symbol]bool)
		}
		if sym := a.resolveSymbolAtNode(expr); sym != nil {
			if visited[sym] {
				return nil
			}
			visited[sym] = true
		}
		if propInit := a.resolveObjectLiteralPropertyInitializer(expr, cloneSymbolVisited(visited)); propInit != nil {
			if resolved := a.resolveClassLikeNodeFromExpression(propInit, visited); resolved != nil {
				return resolved
			}
		}
	}
	sym := a.resolveSymbolAtNode(expr)
	if sym == nil {
		return nil
	}
	if visited == nil {
		visited = make(map[*ast.Symbol]bool)
	}
	if visited[sym] {
		return nil
	}
	visited[sym] = true
	callFile := ast.GetSourceFileOfNode(expr)
	for _, decl := range sym.Declarations() {
		if decl == nil {
			continue
		}
		declFile := ast.GetSourceFileOfNode(decl)
		switch decl.Kind {
		case ast.KindClassDeclaration, ast.KindClassExpression:
			return decl
		case ast.KindVariableDeclaration:
			varDecl := decl.AsVariableDeclaration()
			if varDecl.Initializer == nil {
				continue
			}
			isConst := decl.Parent != nil &&
				decl.Parent.Kind == ast.KindVariableDeclarationList &&
				decl.Parent.Flags&ast.NodeFlagsConst != 0
			if !isConst && a.isSymbolReassigned(sym, declFile, callFile) {
				continue
			}
			if resolved := a.resolveClassLikeNodeFromExpression(varDecl.Initializer, visited); resolved != nil {
				return resolved
			}
		}
	}
	return nil
}

func (a *Analyzer) findClassMemberInHierarchy(classNode *ast.Node, propName string, wantStatic bool, visited map[*ast.Node]bool) *ast.Node {
	if classNode == nil || (classNode.Kind != ast.KindClassDeclaration && classNode.Kind != ast.KindClassExpression) || propName == "" {
		return nil
	}
	if visited == nil {
		visited = make(map[*ast.Node]bool)
	}
	if visited[classNode] {
		return nil
	}
	visited[classNode] = true
	for _, member := range classNode.Members() {
		if member == nil || isStaticMemberDeclaration(member) != wantStatic {
			continue
		}
		if getMemberDeclarationName(a, member) != propName {
			continue
		}
		switch member.Kind {
		case ast.KindMethodDeclaration, ast.KindPropertyDeclaration, ast.KindGetAccessor:
			return member
		}
	}
	for _, extExpr := range getClassExtendsExpressions(classNode) {
		baseClass := a.resolveClassLikeNodeFromExpression(extExpr, nil)
		if baseClass != nil {
			if found := a.findClassMemberInHierarchy(baseClass, propName, wantStatic, visited); found != nil {
				return found
			}
		}
	}
	return nil
}

func (a *Analyzer) classExtendsTarget(classNode, targetClass *ast.Node) bool {
	return a.classExtendsTargetWithVisited(classNode, targetClass, nil)
}

func (a *Analyzer) classExtendsTargetWithVisited(classNode, targetClass *ast.Node, visited map[*ast.Node]bool) bool {
	if classNode == nil || targetClass == nil || classNode == targetClass {
		return false
	}
	if visited == nil {
		visited = make(map[*ast.Node]bool)
	}
	if visited[classNode] {
		return false
	}
	visited[classNode] = true
	for _, extExpr := range getClassExtendsExpressions(classNode) {
		baseClass := a.resolveClassLikeNodeFromExpression(extExpr, nil)
		if baseClass == nil {
			continue
		}
		if baseClass == targetClass || a.classExtendsTargetWithVisited(baseClass, targetClass, visited) {
			return true
		}
	}
	return false
}

func (a *Analyzer) resolveClassMemberNodeTargets(member *ast.Node, callFile *ast.SourceFile, visited map[*ast.Symbol]bool, depth int) ([]*ast.Node, bool) {
	if member == nil {
		return nil, false
	}
	memberFile := ast.GetSourceFileOfNode(member)
	if memberSym := a.resolveSymbolAtNode(member); memberSym != nil && a.isSymbolReassigned(memberSym, memberFile, callFile) {
		return nil, false
	}
	if member.Name() != nil {
		if nameSym := a.resolveSymbolAtNode(member.Name()); nameSym != nil && a.isSymbolReassigned(nameSym, memberFile, callFile) {
			return nil, false
		}
	}
	switch member.Kind {
	case ast.KindMethodDeclaration:
		if member.Body() == nil {
			return nil, false
		}
		return []*ast.Node{member}, true
	case ast.KindPropertyDeclaration:
		init := member.AsPropertyDeclaration().Initializer
		if init == nil {
			return nil, false
		}
		return a.resolveCallbackTargetsWithVisited(init, cloneSymbolVisited(visited), depth+1)
	case ast.KindGetAccessor:
		retExprs, ok := functionReturnedCallbackExpressions(member)
		if !ok || len(retExprs) == 0 {
			return nil, false
		}
		var out []*ast.Node
		for _, retExpr := range retExprs {
			sub, ok := a.resolveCallbackTargetsWithVisited(retExpr, cloneSymbolVisited(visited), depth+1)
			if !ok || len(sub) == 0 {
				return nil, false
			}
			out = append(out, sub...)
		}
		return out, len(out) > 0
	}
	return nil, false
}

func (a *Analyzer) findSubclassesMemberTargets(baseClass *ast.Node, propName string, wantStatic bool, declFile, callFile *ast.SourceFile, visited map[*ast.Symbol]bool, depth int) ([]*ast.Node, bool) {
	if baseClass == nil || propName == "" {
		return nil, true
	}
	var overrideTargets []*ast.Node
	for _, node := range a.getProgramClasses() {
		if node == nil || !a.classExtendsTarget(node, baseClass) {
			continue
		}
		for _, member := range node.Members() {
			if member == nil || isStaticMemberDeclaration(member) != wantStatic {
				continue
			}
			if getMemberDeclarationName(a, member) != propName {
				continue
			}
			if member.ModifierFlags()&ast.ModifierFlagsAbstract != 0 {
				continue
			}
			targets, ok := a.resolveClassMemberNodeTargets(member, callFile, cloneSymbolVisited(visited), depth+1)
			if !ok || len(targets) == 0 {
				return nil, false
			}
			overrideTargets = append(overrideTargets, targets...)
		}
	}
	return overrideTargets, true
}

func (a *Analyzer) resolveConcreteReceiverExpressions(recv *ast.Node, callFile *ast.SourceFile, visited map[*ast.Symbol]bool, depth int) ([]*ast.Node, bool) {
	if depth > 8 {
		return nil, false
	}
	recv = unwrapExpression(recv)
	if recv == nil || a.isCallbackReceiverReassigned(recv) {
		return nil, false
	}
	switch recv.Kind {
	case ast.KindObjectLiteralExpression, ast.KindNewExpression, ast.KindClassDeclaration, ast.KindClassExpression:
		return []*ast.Node{recv}, true
	case ast.KindConditionalExpression:
		cond := recv.AsConditionalExpression()
		left, okLeft := a.resolveConcreteReceiverExpressions(cond.WhenTrue, callFile, cloneSymbolVisited(visited), depth+1)
		if !okLeft || len(left) == 0 {
			return nil, false
		}
		right, okRight := a.resolveConcreteReceiverExpressions(cond.WhenFalse, callFile, cloneSymbolVisited(visited), depth+1)
		if !okRight || len(right) == 0 {
			return nil, false
		}
		return append(left, right...), true
	case ast.KindCallExpression:
		call := recv.AsCallExpression()
		if len(call.Arguments.Nodes) == 1 && a.isIdentityCallbackWithVisited(call.Expression, cloneSymbolVisited(visited), depth+1) {
			return a.resolveConcreteReceiverExpressions(call.Arguments.Nodes[0], callFile, visited, depth+1)
		}
		calleeTargets, ok := a.resolveCallbackTargetsWithVisited(call.Expression, cloneSymbolVisited(visited), depth+1)
		if !ok || len(calleeTargets) == 0 {
			return nil, false
		}
		var out []*ast.Node
		for _, fn := range calleeTargets {
			fnSyms := a.functionReferencesForNode(fn)
			for _, sym := range fnSyms {
				if visited[sym] {
					return nil, false
				}
			}
			calleeVisited := cloneSymbolVisited(visited)
			if calleeVisited == nil {
				calleeVisited = make(map[*ast.Symbol]bool)
			}
			for _, sym := range fnSyms {
				calleeVisited[sym] = true
			}
			retExprs, ok := functionReturnedCallbackExpressions(fn)
			if !ok || len(retExprs) == 0 {
				return nil, false
			}
			var fnOut []*ast.Node
			for _, retExpr := range retExprs {
				if a.isVisitedRecursiveCall(retExpr, fn, fnSyms, calleeVisited, depth+1) {
					continue
				}
				sub, ok := a.resolveConcreteReceiverExpressions(retExpr, callFile, cloneSymbolVisited(calleeVisited), depth+1)
				if !ok || len(sub) == 0 {
					return nil, false
				}
				fnOut = append(fnOut, sub...)
			}
			if len(fnOut) == 0 {
				return nil, false
			}
			out = append(out, fnOut...)
		}
		return out, len(out) > 0
	case ast.KindPropertyAccessExpression, ast.KindElementAccessExpression:
		if propInit := a.resolveObjectLiteralPropertyInitializer(recv, cloneSymbolVisited(visited)); propInit != nil {
			if out, ok := a.resolveConcreteReceiverExpressions(propInit, callFile, cloneSymbolVisited(visited), depth+1); ok && len(out) > 0 {
				return out, true
			}
		}
	}
	sym := a.resolveSymbolAtNode(recv)
	if sym == nil {
		return nil, false
	}
	if visited == nil {
		visited = make(map[*ast.Symbol]bool)
	}
	if visited[sym] {
		return nil, false
	}
	visited[sym] = true
	var out []*ast.Node
	for _, decl := range sym.Declarations() {
		if decl == nil {
			continue
		}
		declFile := ast.GetSourceFileOfNode(decl)
		if isImmutableDeclarationOrPackageFile(declFile) {
			continue
		}
		switch decl.Kind {
		case ast.KindClassDeclaration, ast.KindClassExpression:
			out = append(out, decl)
		case ast.KindVariableDeclaration:
			varDecl := decl.AsVariableDeclaration()
			if varDecl.Initializer == nil {
				continue
			}
			isConst := decl.Parent != nil &&
				decl.Parent.Kind == ast.KindVariableDeclarationList &&
				decl.Parent.Flags&ast.NodeFlagsConst != 0
			if !isConst && a.isSymbolReassigned(sym, declFile, callFile) {
				return nil, false
			}
			sub, ok := a.resolveConcreteReceiverExpressions(varDecl.Initializer, callFile, cloneSymbolVisited(visited), depth+1)
			if !ok || len(sub) == 0 {
				return nil, false
			}
			out = append(out, sub...)
		case ast.KindBindingElement:
			bindRecv, propName, isConst, ok := a.bindingElementTarget(decl)
			if !ok || (!isConst && a.isSymbolReassigned(sym, declFile, callFile)) || a.isCallbackReceiverReassigned(bindRecv) {
				return nil, false
			}
			if propInit := a.resolveObjectLiteralPropertyInitializerFromRecv(bindRecv, propName, cloneSymbolVisited(visited)); propInit != nil {
				sub, ok := a.resolveConcreteReceiverExpressions(propInit, callFile, cloneSymbolVisited(visited), depth+1)
				if !ok || len(sub) == 0 {
					return nil, false
				}
				out = append(out, sub...)
			}
		case ast.KindPropertyAssignment:
			if a.isSymbolReassigned(sym, declFile, callFile) {
				return nil, false
			}
			sub, ok := a.resolveConcreteReceiverExpressions(decl.AsPropertyAssignment().Initializer, callFile, cloneSymbolVisited(visited), depth+1)
			if !ok || len(sub) == 0 {
				return nil, false
			}
			out = append(out, sub...)
		case ast.KindPropertyDeclaration:
			init := decl.AsPropertyDeclaration().Initializer
			if init == nil || a.isSymbolReassigned(sym, declFile, callFile) {
				return nil, false
			}
			sub, ok := a.resolveConcreteReceiverExpressions(init, callFile, cloneSymbolVisited(visited), depth+1)
			if !ok || len(sub) == 0 {
				return nil, false
			}
			out = append(out, sub...)
		}
	}
	return out, len(out) > 0
}

func (a *Analyzer) resolveMemberOnConcreteReceiver(concreteRecv *ast.Node, propName string, callFile *ast.SourceFile, visited map[*ast.Symbol]bool, depth int) ([]*ast.Node, bool) {
	concreteRecv = unwrapExpression(concreteRecv)
	if concreteRecv == nil || propName == "" {
		return nil, false
	}
	if a.isPropertyOnIdentitiesReassigned([]objectIdentity{{node: concreteRecv}}, propName, ast.GetSourceFileOfNode(concreteRecv), callFile) {
		return nil, false
	}
	switch concreteRecv.Kind {
	case ast.KindObjectLiteralExpression:
		propInit := a.resolvePropertyFromObjectLiteralNode(concreteRecv, propName, cloneSymbolVisited(visited))
		if propInit == nil {
			return nil, false
		}
		if propInit.Parent != nil {
			if propSym := a.resolveSymbolAtNode(propInit.Parent); propSym != nil && a.isSymbolReassigned(propSym, ast.GetSourceFileOfNode(propInit), callFile) {
				return nil, false
			}
		}
		return a.resolveCallbackTargetsWithVisited(propInit, cloneSymbolVisited(visited), depth+1)
	case ast.KindNewExpression:
		classNode := a.resolveClassLikeNodeFromExpression(concreteRecv.AsNewExpression().Expression, cloneSymbolVisited(visited))
		if classNode == nil {
			return nil, false
		}
		member := a.findClassMemberInHierarchy(classNode, propName, false, nil)
		if member == nil {
			return nil, false
		}
		return a.resolveClassMemberNodeTargets(member, callFile, cloneSymbolVisited(visited), depth+1)
	case ast.KindClassDeclaration, ast.KindClassExpression:
		member := a.findClassMemberInHierarchy(concreteRecv, propName, true, nil)
		if member == nil {
			return nil, false
		}
		return a.resolveClassMemberNodeTargets(member, callFile, cloneSymbolVisited(visited), depth+1)
	}
	return nil, false
}

func (a *Analyzer) resolveParameterCallSiteMemberTargets(paramSym *ast.Symbol, propName string, callFile *ast.SourceFile, visited map[*ast.Symbol]bool, depth int) ([]*ast.Node, bool, bool) {
	if paramSym == nil || propName == "" {
		return nil, false, false
	}
	var targets []*ast.Node
	sawCall := false
	for _, decl := range paramSym.Declarations() {
		if decl == nil || decl.Kind != ast.KindParameter {
			continue
		}
		declFile := ast.GetSourceFileOfNode(decl)
		if a.isSymbolReassigned(paramSym, declFile, callFile) {
			return nil, true, false
		}
		fn := decl.Parent
		if fn == nil || !isFunctionLikeNode(fn) {
			continue
		}
		paramIndex := -1
		for idx, p := range fn.Parameters() {
			if p == decl {
				paramIndex = idx
				break
			}
		}
		if paramIndex < 0 {
			continue
		}
		fnSyms := a.functionReferencesForNode(fn)
		if len(fnSyms) == 0 {
			continue
		}
		for _, searchFile := range []*ast.SourceFile{declFile, callFile} {
			if isImmutableDeclarationOrPackageFile(searchFile) {
				continue
			}
			summary := a.getFileMutationSummary(searchFile)
			if summary == nil {
				continue
			}
			for _, n := range summary.calls {
				if n == nil || n.Kind != ast.KindCallExpression {
					continue
				}
				call := n.AsCallExpression()
				if !a.callMatchesFunction(call.Expression, fn, fnSyms) {
					continue
				}
				sawCall = true
				if paramIndex >= len(call.Arguments.Nodes) {
					return nil, true, false
				}
				arg := call.Arguments.Nodes[paramIndex]
				if a.isCallbackReceiverReassigned(arg) {
					return nil, true, false
				}
				sub, ok := a.resolveMemberCallbackTargets(arg, propName, searchFile, cloneSymbolVisited(visited), depth+1)
				if !ok || len(sub) == 0 {
					if recvType := a.checker.GetTypeAtLocation(arg); recvType != nil {
						if propSym := a.resolveAliasedSymbol(a.checker.GetPropertyOfType(recvType, propName)); propSym != nil {
							sub, ok = a.resolveSymbolDeclarationsTargetsWithExact(propSym, searchFile, cloneSymbolVisited(visited), depth+1, false)
						}
					}
				}
				if !ok || len(sub) == 0 {
					return nil, true, false
				}
				targets = append(targets, sub...)
			}
		}
	}
	return targets, sawCall, len(targets) > 0
}

func (a *Analyzer) resolveMemberCallbackTargets(recv *ast.Node, propName string, callFile *ast.SourceFile, visited map[*ast.Symbol]bool, depth int) ([]*ast.Node, bool) {
	if depth > 8 || recv == nil || propName == "" {
		return nil, false
	}
	recv = unwrapExpression(recv)
	if recv == nil || a.isCallbackReceiverReassigned(recv) {
		return nil, false
	}
	if concreteRecvs, ok := a.resolveConcreteReceiverExpressions(recv, callFile, cloneSymbolVisited(visited), depth+1); ok && len(concreteRecvs) > 0 {
		var out []*ast.Node
		for _, concreteRecv := range concreteRecvs {
			sub, ok := a.resolveMemberOnConcreteReceiver(concreteRecv, propName, callFile, cloneSymbolVisited(visited), depth+1)
			if !ok || len(sub) == 0 {
				return nil, false
			}
			out = append(out, sub...)
		}
		return out, len(out) > 0
	}
	if recvSym := a.resolveSymbolAtNode(recv); recvSym != nil {
		for _, decl := range recvSym.Declarations() {
			if decl != nil && decl.Kind == ast.KindParameter {
				var combined []*ast.Node
				callSiteTargets, sawCall, ok := a.resolveParameterCallSiteMemberTargets(recvSym, propName, callFile, cloneSymbolVisited(visited), depth+1)
				if sawCall && !ok {
					return nil, false
				}
				if ok {
					combined = append(combined, callSiteTargets...)
				}
				if recvType := a.checker.GetTypeAtLocation(recv); recvType != nil {
					if propSym := a.resolveAliasedSymbol(a.checker.GetPropertyOfType(recvType, propName)); propSym != nil {
						if declTargets, ok := a.resolveSymbolDeclarationsTargetsWithExact(propSym, callFile, cloneSymbolVisited(visited), depth+1, false); ok {
							combined = append(combined, declTargets...)
						} else if len(combined) == 0 {
							return nil, false
						}
					}
				}
				if len(combined) > 0 {
					return combined, true
				}
			}
		}
	}
	return nil, false
}

func (a *Analyzer) resolveCallbackTargets(callback *ast.Node) ([]*ast.Node, bool) {
	return a.resolveCallbackTargetsWithVisited(callback, nil, 0)
}

func (a *Analyzer) resolveCallbackTargetsWithVisited(callback *ast.Node, visited map[*ast.Symbol]bool, depth int) ([]*ast.Node, bool) {
	if depth > 8 {
		return nil, false
	}
	cb := unwrapExpression(callback)
	if cb == nil {
		return nil, false
	}
	if len(visited) == 0 {
		if cached, ok := a.getCache().callbackTargets[cb]; ok {
			return cached.targets, cached.ok
		}
	}
	saveResult := func(nodes []*ast.Node, ok bool) ([]*ast.Node, bool) {
		if len(visited) == 0 && depth <= 4 {
			a.getCache().callbackTargets[cb] = cachedNodeTargets{targets: nodes, ok: ok}
		}
		return nodes, ok
	}
	switch cb.Kind {
	case ast.KindArrowFunction, ast.KindFunctionExpression, ast.KindFunctionDeclaration, ast.KindMethodDeclaration:
		if cb.Body() != nil {
			return saveResult([]*ast.Node{cb}, true)
		}
		return saveResult(nil, false)
	case ast.KindConditionalExpression:
		cond := cb.AsConditionalExpression()
		left, okLeft := a.resolveCallbackTargetsWithVisited(cond.WhenTrue, cloneSymbolVisited(visited), depth+1)
		if !okLeft || len(left) == 0 {
			return saveResult(nil, false)
		}
		right, okRight := a.resolveCallbackTargetsWithVisited(cond.WhenFalse, cloneSymbolVisited(visited), depth+1)
		if !okRight || len(right) == 0 {
			return saveResult(nil, false)
		}
		return saveResult(append(left, right...), true)
	case ast.KindCallExpression:
		call := cb.AsCallExpression()
		if method, recv, _ := methodCall(cb); method == "bind" && len(call.Arguments.Nodes) <= 1 {
			nodes, ok := a.resolveCallbackTargetsWithVisited(recv, visited, depth+1)
			return saveResult(nodes, ok)
		}
		if a.classifyResultCallbackWithVisited(cb, cloneSymbolVisited(visited), depth+1) != resultCallbackNone {
			return saveResult([]*ast.Node{cb}, true)
		}
		if len(call.Arguments.Nodes) == 1 && a.isIdentityCallbackWithVisited(call.Expression, cloneSymbolVisited(visited), depth+1) {
			nodes, ok := a.resolveCallbackTargetsWithVisited(call.Arguments.Nodes[0], visited, depth+1)
			return saveResult(nodes, ok)
		}
		if len(call.Arguments.Nodes) >= 1 && a.isFlowFunctionWithVisited(call.Expression, cloneSymbolVisited(visited)) {
			args := call.Arguments.Nodes
			prefixValid := true
			for _, prefixArg := range args[:len(args)-1] {
				if !a.isIdentityCallbackWithVisited(prefixArg, cloneSymbolVisited(visited), depth+1) &&
					!a.isCallbackTransformerExpressionWithVisited(prefixArg, cloneSymbolVisited(visited), depth+1) {
					prefixValid = false
					break
				}
			}
			if prefixValid {
				nodes, ok := a.resolveCallbackTargetsWithVisited(args[len(args)-1], visited, depth+1)
				return saveResult(nodes, ok)
			}
			return saveResult(nil, false)
		}
		calleeTargets, ok := a.resolveCallbackTargetsWithVisited(call.Expression, cloneSymbolVisited(visited), depth+1)
		if !ok || len(calleeTargets) == 0 {
			return saveResult(nil, false)
		}
		resolved := make([]*ast.Node, 0, len(calleeTargets))
		for _, calleeTarget := range calleeTargets {
			fnSyms := a.functionReferencesForNode(calleeTarget)
			for _, sym := range fnSyms {
				if visited[sym] {
					return saveResult(nil, false)
				}
			}
			calleeVisited := cloneSymbolVisited(visited)
			if calleeVisited == nil {
				calleeVisited = make(map[*ast.Symbol]bool)
			}
			for _, sym := range fnSyms {
				calleeVisited[sym] = true
			}
			retExprs, ok := functionReturnedCallbackExpressions(calleeTarget)
			if !ok || len(retExprs) == 0 {
				return saveResult(nil, false)
			}
			var calleeResolved []*ast.Node
			for _, retExpr := range retExprs {
				if a.isVisitedRecursiveCall(retExpr, calleeTarget, fnSyms, calleeVisited, depth+1) {
					continue
				}
				subTargets, ok := a.resolveCallbackTargetsWithVisited(retExpr, cloneSymbolVisited(calleeVisited), depth+1)
				if !ok || len(subTargets) == 0 {
					return saveResult(nil, false)
				}
				calleeResolved = append(calleeResolved, subTargets...)
			}
			if len(calleeResolved) == 0 {
				return saveResult(nil, false)
			}
			resolved = append(resolved, calleeResolved...)
		}
		return saveResult(resolved, len(resolved) > 0)
	case ast.KindIdentifier, ast.KindPropertyAccessExpression, ast.KindElementAccessExpression:
		if a.isCallbackReceiverReassigned(cb) {
			return saveResult(nil, false)
		}
		if a.classifyResultCallbackWithVisited(cb, cloneSymbolVisited(visited), depth+1) != resultCallbackNone {
			return saveResult([]*ast.Node{cb}, true)
		}
		callFile := ast.GetSourceFileOfNode(cb)
		if visited == nil {
			visited = make(map[*ast.Symbol]bool)
		}
		exactReceiver := false
		if cb.Kind == ast.KindPropertyAccessExpression || cb.Kind == ast.KindElementAccessExpression {
			var recv *ast.Node
			var propName string
			if cb.Kind == ast.KindPropertyAccessExpression {
				if cb.Name() != nil {
					recv = unwrapExpression(cb.AsPropertyAccessExpression().Expression)
					propName = cb.Name().Text()
				}
			} else {
				elem := cb.AsElementAccessExpression()
				if name, ok := a.staticElementIndex(elem.ArgumentExpression); ok {
					recv = unwrapExpression(elem.Expression)
					propName = name
				}
			}
			if recv != nil && propName != "" {
				if recv.Kind == ast.KindSuperKeyword {
					exactReceiver = true
				} else if memberTargets, ok := a.resolveMemberCallbackTargets(recv, propName, callFile, cloneSymbolVisited(visited), depth+1); ok && len(memberTargets) > 0 {
					return saveResult(memberTargets, true)
				}
			}
		}
		symbol := a.resolveSymbolAtNode(cb)
		if symbol != nil {
			if targets, ok := a.resolveSymbolDeclarationsTargetsWithExact(symbol, callFile, visited, depth, exactReceiver); ok {
				return saveResult(targets, true)
			}
		}
		if (cb.Kind == ast.KindPropertyAccessExpression || cb.Kind == ast.KindElementAccessExpression) &&
			(symbol == nil || !a.isSymbolReassigned(symbol, nil, callFile)) {
			if propInit := a.resolveObjectLiteralPropertyInitializer(cb, cloneSymbolVisited(visited)); propInit != nil {
				if propSym := a.resolveSymbolAtNode(propInit.Parent); propSym != nil && a.isSymbolReassigned(propSym, ast.GetSourceFileOfNode(propInit), callFile) {
					return saveResult(nil, false)
				}
				nodes, ok := a.resolveCallbackTargetsWithVisited(propInit, visited, depth+1)
				return saveResult(nodes, ok)
			}
		}
	}
	return saveResult(nil, false)
}

func (a *Analyzer) resolveSymbolDeclarationsTargets(symbol *ast.Symbol, callFile *ast.SourceFile, visited map[*ast.Symbol]bool, depth int) ([]*ast.Node, bool) {
	return a.resolveSymbolDeclarationsTargetsWithExact(symbol, callFile, visited, depth, false)
}

func (a *Analyzer) resolveSymbolDeclarationsTargetsWithExact(symbol *ast.Symbol, callFile *ast.SourceFile, visited map[*ast.Symbol]bool, depth int, exactReceiver bool) ([]*ast.Node, bool) {
	if symbol == nil || visited[symbol] {
		return nil, false
	}
	if visited == nil {
		visited = make(map[*ast.Symbol]bool)
	}
	visited[symbol] = true
	var allTargets []*ast.Node
	for _, decl := range symbol.Declarations() {
		if decl == nil {
			continue
		}
		declFile := ast.GetSourceFileOfNode(decl)
		if isImmutableDeclarationOrPackageFile(declFile) {
			continue
		}
		switch decl.Kind {
		case ast.KindFunctionDeclaration:
			if decl.Body() != nil {
				if a.isSymbolReassigned(symbol, declFile, callFile) {
					return nil, false
				}
				allTargets = append(allTargets, decl)
			}
		case ast.KindMethodDeclaration:
			if a.isSymbolReassigned(symbol, declFile, callFile) {
				return nil, false
			}
			if decl.Body() != nil {
				allTargets = append(allTargets, decl)
			}
			if !exactReceiver && decl.Parent != nil && (decl.Parent.Kind == ast.KindClassDeclaration || decl.Parent.Kind == ast.KindClassExpression) {
				propName := getMemberDeclarationName(a, decl)
				overrideTargets, ok := a.findSubclassesMemberTargets(decl.Parent, propName, isStaticMemberDeclaration(decl), declFile, callFile, cloneSymbolVisited(visited), depth+1)
				if !ok {
					return nil, false
				}
				allTargets = append(allTargets, overrideTargets...)
			}
		case ast.KindVariableDeclaration:
			varDecl := decl.AsVariableDeclaration()
			if varDecl.Initializer == nil {
				continue
			}
			isConst := decl.Parent != nil &&
				decl.Parent.Kind == ast.KindVariableDeclarationList &&
				decl.Parent.Flags&ast.NodeFlagsConst != 0
			if !isConst && a.isSymbolReassigned(symbol, declFile, callFile) {
				return nil, false
			}
			targets, ok := a.resolveCallbackTargetsWithVisited(varDecl.Initializer, cloneSymbolVisited(visited), depth+1)
			if !ok || len(targets) == 0 {
				return nil, false
			}
			allTargets = append(allTargets, targets...)
		case ast.KindBindingElement:
			recv, propName, isConst, ok := a.bindingElementTarget(decl)
			if !ok || (!isConst && a.isSymbolReassigned(symbol, declFile, callFile)) || a.isCallbackReceiverReassigned(recv) {
				return nil, false
			}
			if recvSym := a.resolveSymbolAtNode(recv); recvSym != nil && a.isPropertyOnSymbolReassigned(recvSym, propName, declFile, callFile) {
				return nil, false
			}
			if initIDs := a.collectObjectIdentities(recv, callFile, nil, 0); len(initIDs) > 0 && a.isPropertyOnIdentitiesReassigned(initIDs, propName, declFile, callFile) {
				return nil, false
			}
			if memberTargets, ok := a.resolveMemberCallbackTargets(recv, propName, callFile, cloneSymbolVisited(visited), depth+1); ok && len(memberTargets) > 0 {
				allTargets = append(allTargets, memberTargets...)
				continue
			}
			if propInit := a.resolveObjectLiteralPropertyInitializerFromRecv(recv, propName, cloneSymbolVisited(visited)); propInit != nil {
				targets, ok := a.resolveCallbackTargetsWithVisited(propInit, cloneSymbolVisited(visited), depth+1)
				if !ok || len(targets) == 0 {
					return nil, false
				}
				allTargets = append(allTargets, targets...)
				continue
			}
			if recvType := a.checker.GetTypeAtLocation(recv); recvType != nil {
				if propSym := a.resolveAliasedSymbol(a.checker.GetPropertyOfType(recvType, propName)); propSym != nil && !visited[propSym] {
					targets, ok := a.resolveSymbolDeclarationsTargetsWithExact(propSym, callFile, cloneSymbolVisited(visited), depth+1, false)
					if !ok || len(targets) == 0 {
						return nil, false
					}
					allTargets = append(allTargets, targets...)
				}
			}
		case ast.KindPropertyAssignment:
			if a.isSymbolReassigned(symbol, declFile, callFile) {
				return nil, false
			}
			targets, ok := a.resolveCallbackTargetsWithVisited(decl.AsPropertyAssignment().Initializer, cloneSymbolVisited(visited), depth+1)
			if !ok || len(targets) == 0 {
				return nil, false
			}
			allTargets = append(allTargets, targets...)
		case ast.KindShorthandPropertyAssignment:
			if a.isSymbolReassigned(symbol, declFile, callFile) {
				return nil, false
			}
			valSym := a.resolveAliasedSymbol(a.checker.GetShorthandAssignmentValueSymbol(decl))
			if valSym != nil && !visited[valSym] {
				targets, ok := a.resolveSymbolDeclarationsTargetsWithExact(valSym, callFile, cloneSymbolVisited(visited), depth+1, exactReceiver)
				if !ok || len(targets) == 0 {
					return nil, false
				}
				allTargets = append(allTargets, targets...)
			}
		case ast.KindPropertyDeclaration:
			propDecl := decl.AsPropertyDeclaration()
			if a.isSymbolReassigned(symbol, declFile, callFile) {
				return nil, false
			}
			if propDecl.Initializer != nil {
				targets, ok := a.resolveCallbackTargetsWithVisited(propDecl.Initializer, cloneSymbolVisited(visited), depth+1)
				if !ok || len(targets) == 0 {
					return nil, false
				}
				allTargets = append(allTargets, targets...)
			}
			if !exactReceiver && decl.Parent != nil && (decl.Parent.Kind == ast.KindClassDeclaration || decl.Parent.Kind == ast.KindClassExpression) {
				propName := getMemberDeclarationName(a, decl)
				overrideTargets, ok := a.findSubclassesMemberTargets(decl.Parent, propName, isStaticMemberDeclaration(decl), declFile, callFile, cloneSymbolVisited(visited), depth+1)
				if !ok {
					return nil, false
				}
				allTargets = append(allTargets, overrideTargets...)
			}
		case ast.KindGetAccessor:
			if a.isSymbolReassigned(symbol, declFile, callFile) {
				return nil, false
			}
			targets, ok := a.resolveClassMemberNodeTargets(decl, callFile, cloneSymbolVisited(visited), depth+1)
			if !ok || len(targets) == 0 {
				return nil, false
			}
			allTargets = append(allTargets, targets...)
			if !exactReceiver && decl.Parent != nil && (decl.Parent.Kind == ast.KindClassDeclaration || decl.Parent.Kind == ast.KindClassExpression) {
				propName := getMemberDeclarationName(a, decl)
				overrideTargets, ok := a.findSubclassesMemberTargets(decl.Parent, propName, isStaticMemberDeclaration(decl), declFile, callFile, cloneSymbolVisited(visited), depth+1)
				if !ok {
					return nil, false
				}
				allTargets = append(allTargets, overrideTargets...)
			}
		case ast.KindExportAssignment:
			exportAssign := decl.AsExportAssignment()
			if exportAssign.Expression != nil {
				targets, ok := a.resolveCallbackTargetsWithVisited(exportAssign.Expression, cloneSymbolVisited(visited), depth+1)
				if !ok || len(targets) == 0 {
					return nil, false
				}
				allTargets = append(allTargets, targets...)
			}
		}
	}
	return allTargets, len(allTargets) > 0
}

func cloneSymbolVisited(visited map[*ast.Symbol]bool) map[*ast.Symbol]bool {
	if len(visited) == 0 {
		return nil
	}
	cloned := make(map[*ast.Symbol]bool, len(visited))
	for k, v := range visited {
		cloned[k] = v
	}
	return cloned
}

func (a *Analyzer) isOuterCallExpressionReturnedOrVoided(callNode *ast.Node, state *handleSearchState) bool {
	if callNode == nil || state == nil {
		return false
	}
	key := nodeVisitKey{node: callNode, elemIndex: -1, kind: nodeVisitOuterCall, callContext: state.activeCallContext()}
	if state.visitedNodes[key] {
		return false
	}
	state.visitedNodes[key] = true
	current := callNode
	for current.Parent != nil {
		parent := current.Parent
		if isReturnValueContainer(parent, current) ||
			(parent.Kind == ast.KindAwaitExpression && parent.Expression() == current) ||
			a.isPromiseResolveCall(parent, current) ||
			a.isIdentityCall(parent, current) {
			current = parent
			continue
		}
		if parent.Kind == ast.KindPropertyAccessExpression &&
			parent.AsPropertyAccessExpression().Expression == current &&
			parent.Name() != nil && parent.Name().Text() == "then" &&
			parent.Parent != nil && parent.Parent.Kind == ast.KindCallExpression &&
			parent.Parent.AsCallExpression().Expression == parent &&
			a.isPassthroughThenCall(parent.Parent) {
			current = parent.Parent
			continue
		}
		break
	}
	parent := current.Parent
	if parent == nil {
		return false
	}
	if parent.Kind == ast.KindVoidExpression && parent.Expression() == current {
		return true
	}
	if parent.Kind == ast.KindYieldExpression && parent.AsYieldExpression().AsteriskToken != nil && parent.Expression() == current {
		return true
	}
	if (parent.Kind == ast.KindReturnStatement && parent.AsReturnStatement().Expression == current) ||
		(parent.Kind == ast.KindArrowFunction && parent.Body() == current) {
		return a.isReturnedSingleResultHandled(parent, current, nil, state)
	}
	return false
}

func (a *Analyzer) isReturnedSingleResultHandled(returnOrArrow *ast.Node, expr *ast.Node, root *ast.Node, state *handleSearchState) bool {
	if state == nil {
		return false
	}
	fn := enclosingFunction(returnOrArrow)
	if fn == nil {
		return false
	}
	callNode, method, restore := state.resolveCallbackReturn(fn)
	defer restore()
	if callNode != nil {
		if method == "then" {
			exprType := a.checker.GetTypeAtLocation(expr)
			if root != nil {
				if unwrapExpression(expr) == unwrapExpression(root) {
					return a.isHandledReferenceWithState(callNode, state)
				}
				unwrappedExpr := unwrapExpression(expr)
				if unwrappedExpr != nil && unwrappedExpr.Kind == ast.KindArrayLiteralExpression {
					for i, elem := range unwrappedExpr.Elements() {
						if unwrapExpression(elem) == unwrapExpression(root) {
							return a.isPromiseAllCallElementHandled(callNode, i, state)
						}
					}
				}
				if everyUnionPart(exprType, isResultLikeType) || a.isPromiseOfResultLikeType(exprType) || a.isPassthroughThenCall(unwrappedExpr) {
					return a.isHandledReferenceWithState(callNode, state)
				}
				return false
			}
			if everyUnionPart(exprType, isResultLikeType) || a.isPromiseOfResultLikeType(exprType) || a.isPassthroughThenCall(unwrapExpression(expr)) {
				return a.isHandledReferenceWithState(callNode, state)
			}
			return a.isOuterCallExpressionReturnedOrVoided(callNode, state)
		}
		if isTupleElementCallbackMethod(method) {
			if method == "map" || method == "flatMap" {
				return a.isOuterCallExpressionReturnedOrVoided(callNode, state) || a.isConsumedByResultTaskStaticCall(callNode)
			}
			return false
		}
	}
	return true
}

func (a *Analyzer) isReturnedTupleHandled(returnOrArrow *ast.Node, elemIndex int, state *handleSearchState) bool {
	if state == nil {
		return false
	}
	fn := enclosingFunction(returnOrArrow)
	if fn == nil {
		return false
	}
	callNode, method, restore := state.resolveCallbackReturn(fn)
	defer restore()
	if callNode != nil {
		if method == "then" {
			return a.isPromiseAllCallElementHandled(callNode, elemIndex, state)
		}
		if isTupleElementCallbackMethod(method) {
			if method == "map" || method == "flatMap" {
				return a.isOuterCallExpressionReturnedOrVoided(callNode, state) || a.isConsumedByResultTaskStaticCall(callNode)
			}
			return false
		}
	}
	return true
}

func (a *Analyzer) isHandledReference(identifier *ast.Node) bool {
	if identifier == nil {
		return false
	}
	return a.isHandledReferenceWithState(identifier, newHandleSearchState(a.checker.GetSymbolAtLocation(identifier)))
}

func (a *Analyzer) isHandledReferenceWithState(identifier *ast.Node, state *handleSearchState) bool {
	if identifier == nil || state == nil {
		return false
	}
	key := nodeVisitKey{node: identifier, elemIndex: -1, kind: nodeVisitRef, callContext: state.activeCallContext()}
	if state.visitedNodes[key] {
		return false
	}
	state.visitedNodes[key] = true
	root, parent := a.referenceChainRoot(identifier)
	if parent != nil && parent.Kind == ast.KindYieldExpression && parent.AsYieldExpression().AsteriskToken != nil && parent.Expression() == root {
		return true
	}
	if parent != nil && parent.Kind == ast.KindVoidExpression && parent.Expression() == root {
		return true
	}
	if parent != nil && parent.Kind == ast.KindVariableDeclaration {
		declaration := parent.AsVariableDeclaration()
		if declaration.Initializer == root &&
			parent.Name() != nil &&
			parent.Name().Kind == ast.KindIdentifier &&
			!isExplicitDiscard(root) {
			rootType := a.checker.GetTypeAtLocation(root)
			targetSymbol := a.checker.GetSymbolAtLocation(parent.Name())
			if targetSymbol != a.checker.GetSymbolAtLocation(identifier) &&
				(state.sourceSymbol == nil || targetSymbol != state.sourceSymbol) {
				if isCallLikeDiscard(root) && isMustUseResultarType(rootType) {
					return true
				}
				if (isMustUseResultarType(rootType) || a.isPromiseOfResultLikeType(rootType) || a.isPassthroughThenCall(root)) &&
					a.isIdentifierVariableHandled(parent.Name(), state) {
					return true
				}
			}
		}
	}
	if a.isConsumedByReceiverChainWithState(identifier, state) {
		return true
	}
	if a.isConsumedByResultTaskStaticCall(identifier) {
		return true
	}
	if a.isConsumedByPromiseAll(identifier, state) {
		return true
	}
	if parent != nil && parent.Kind == ast.KindCallExpression && !a.isInsideDiscardedResultExpression(parent) {
		call := parent.AsCallExpression()
		if len(call.Arguments.Nodes) >= 2 && call.Arguments.Nodes[0] == root && a.isPipeFunction(call.Expression) {
			steps := call.Arguments.Nodes[1:]
			allPrefixValid := true
			for _, step := range steps[:len(steps)-1] {
				if !a.isIdentityCallback(step) && !a.isCallbackTransformerExpression(step) {
					allPrefixValid = false
					break
				}
			}
			if allPrefixValid && a.isSingleResultThenCallbackHandled(steps[len(steps)-1], parent, state) {
				return true
			}
		} else {
			argIndex := -1
			for i, arg := range call.Arguments.Nodes {
				if arg == root {
					argIndex = i
					break
				}
			}
			if argIndex >= 0 && a.isSingleResultCallArgumentHandled(call.Expression, parent, argIndex, state) {
				return true
			}
		}
	}

	current := root
	for parent := current.Parent; parent != nil; parent = current.Parent {
		if isReturnValueContainer(parent, current) {
			current = parent
			continue
		}
		if (parent.Kind == ast.KindReturnStatement && parent.AsReturnStatement().Expression == current) ||
			(parent.Kind == ast.KindArrowFunction && parent.Body() == current) {
			return a.isReturnedSingleResultHandled(parent, current, root, state)
		}
		return false
	}
	return false
}

func (a *Analyzer) isIdentifierVariableHandled(nameNode *ast.Node, state *handleSearchState) bool {
	if nameNode == nil || nameNode.Kind != ast.KindIdentifier || state == nil {
		return false
	}
	symbol := a.checker.GetSymbolAtLocation(nameNode)
	file := ast.GetSourceFileOfNode(nameNode)
	if symbol == nil || file == nil {
		return false
	}
	key := symbolVisitKey{symbol: symbol, elemIndex: -1, kind: symVisitSingle, callContext: state.activeCallContext()}
	if state.visitedSymbols[key] {
		return false
	}
	state.visitedSymbols[key] = true
	handled := false
	visit(file.AsNode(), func(node *ast.Node) {
		if handled || node == nameNode || node.Kind != ast.KindIdentifier || isDeclarationIdentifier(node) {
			return
		}
		var refSymbol *ast.Symbol
		if node.Parent != nil && node.Parent.Kind == ast.KindShorthandPropertyAssignment && node.Parent.Name() == node {
			refSymbol = a.checker.GetShorthandAssignmentValueSymbol(node.Parent)
		} else {
			refSymbol = a.checker.GetSymbolAtLocation(node)
		}
		if refSymbol == symbol && a.isHandledReferenceWithState(node, state) {
			handled = true
		}
	})
	return handled
}

func (a *Analyzer) variableHasDiscardedResultUse(nameNode *ast.Node, visited map[*ast.Symbol]bool) bool {
	if nameNode == nil || nameNode.Kind != ast.KindIdentifier {
		return false
	}
	symbol := a.checker.GetSymbolAtLocation(nameNode)
	file := ast.GetSourceFileOfNode(nameNode)
	if symbol == nil || file == nil {
		return false
	}
	if visited == nil {
		visited = make(map[*ast.Symbol]bool)
	}
	if visited[symbol] {
		return false
	}
	visited[symbol] = true
	discarded := false
	visit(file.AsNode(), func(node *ast.Node) {
		if discarded || node == nameNode || node.Kind != ast.KindIdentifier || isDeclarationIdentifier(node) {
			return
		}
		if a.checker.GetSymbolAtLocation(node) == symbol && a.isInsideDiscardedResultExpressionWithVisited(node, visited) {
			discarded = true
		}
	})
	return discarded
}

func (a *Analyzer) unwrappedExpressionSymbol(node *ast.Node) *ast.Symbol {
	current := node
	for current != nil {
		unwrapped := unwrapExpression(current)
		if unwrapped == nil {
			return nil
		}
		if unwrapped.Kind == ast.KindAwaitExpression {
			current = unwrapped.Expression()
			continue
		}
		if unwrapped.Kind == ast.KindCallExpression {
			call := unwrapped.AsCallExpression()
			if len(call.Arguments.Nodes) == 1 && (a.staticNamespace(call.Expression, "resolve") == "Promise" || a.staticNamespace(call.Expression, "all") == "Promise" || a.isIdentityCallback(call.Expression)) {
				current = call.Arguments.Nodes[0]
				continue
			}
			if a.isPassthroughThenCall(unwrapped) {
				if expr := unwrapExpression(call.Expression); expr != nil && expr.Kind == ast.KindPropertyAccessExpression &&
					expr.Name() != nil && expr.Name().Text() == "then" {
					current = expr.AsPropertyAccessExpression().Expression
					continue
				}
			}
		}
		current = unwrapped
		break
	}
	if current != nil && current.Kind == ast.KindIdentifier {
		return a.checker.GetSymbolAtLocation(current)
	}
	return nil
}

func (a *Analyzer) staticElementIndex(node *ast.Node) (string, bool) {
	return a.staticElementIndexWithVisited(node, nil)
}

func (a *Analyzer) staticElementIndexWithVisited(node *ast.Node, visited map[*ast.Symbol]bool) (string, bool) {
	node = unwrapExpression(node)
	if node == nil {
		return "", false
	}
	switch node.Kind {
	case ast.KindNumericLiteral:
		if t := a.checker.GetTypeAtLocation(node); t != nil && t.IsNumberLiteral() {
			return t.AsLiteralType().String(), true
		}
		return node.Text(), true
	case ast.KindStringLiteral, ast.KindNoSubstitutionTemplateLiteral:
		return node.Text(), true
	case ast.KindPrefixUnaryExpression:
		unary := node.AsPrefixUnaryExpression()
		switch unary.Operator {
		case ast.KindPlusToken, ast.KindMinusToken:
			operandText, ok := a.staticElementIndexWithVisited(unary.Operand, visited)
			if !ok {
				break
			}
			n, err := strconv.Atoi(operandText)
			if err != nil {
				break
			}
			if unary.Operator == ast.KindMinusToken {
				n = -n
			}
			return strconv.Itoa(n), true
		}
	case ast.KindIdentifier:
		symbol := a.checker.GetSymbolAtLocation(node)
		if symbol != nil && symbol.Flags()&ast.SymbolFlagsAlias != 0 {
			symbol = a.checker.GetAliasedSymbol(symbol)
		}
		if symbol != nil {
			if visited == nil {
				visited = make(map[*ast.Symbol]bool)
			}
			if !visited[symbol] {
				visited[symbol] = true
				for _, decl := range symbol.Declarations() {
					if decl != nil && decl.Kind == ast.KindVariableDeclaration &&
						decl.Parent != nil && decl.Parent.Kind == ast.KindVariableDeclarationList &&
						decl.Parent.Flags&ast.NodeFlagsConst != 0 {
						if idx, ok := a.staticElementIndexWithVisited(decl.AsVariableDeclaration().Initializer, visited); ok {
							return idx, true
						}
					}
				}
			}
		}
	}
	if t := a.checker.GetTypeAtLocation(node); t != nil {
		if t.IsNumberLiteral() {
			return t.AsLiteralType().String(), true
		}
		if t.IsStringLiteral() {
			if s, ok := t.AsLiteralType().Value().(string); ok {
				return s, true
			}
		}
	}
	return "", false
}

func (a *Analyzer) elementAccessMatchesIndex(elemAccessNode *ast.Node, elemIndex int) bool {
	if elemAccessNode == nil || elemAccessNode.Kind != ast.KindElementAccessExpression {
		return false
	}
	idxText, ok := a.staticElementIndex(elemAccessNode.AsElementAccessExpression().ArgumentExpression)
	return ok && idxText == strconv.Itoa(elemIndex)
}

func isTupleElementCallbackMethod(name string) bool {
	switch name {
	case "forEach", "map", "every", "some", "find", "filter", "flatMap":
		return true
	}
	return false
}

func (a *Analyzer) isTupleElementCallbackHandled(callback *ast.Node, callNode *ast.Node, method string, state *handleSearchState) bool {
	targets, ok := a.resolveCallbackTargets(callback)
	if !ok || len(targets) == 0 {
		return false
	}
	for _, cb := range targets {
		switch a.classifyResultCallback(cb) {
		case resultCallbackConsumer:
			continue
		case resultCallbackTransformer:
			if (method == "map" || method == "flatMap") &&
				(a.isOuterCallExpressionReturnedOrVoided(callNode, state) || a.isConsumedByResultTaskStaticCall(callNode)) {
				continue
			}
			return false
		case resultCallbackTupleCombiner, resultCallbackTupleConsumer:
			return false
		}
		if len(cb.Parameters()) == 0 {
			return false
		}
		param := cb.Parameters()[0].Name()
		if param == nil || param.Kind != ast.KindIdentifier {
			return false
		}
		targetCb := cb
		if !state.withCallback(targetCb, callNode, method, -1, func() bool {
			return a.isIdentifierVariableHandled(param, state)
		}) {
			return false
		}
	}
	return true
}

func (a *Analyzer) isSingleResultThenCallbackHandled(callback *ast.Node, callNode *ast.Node, state *handleSearchState) bool {
	return a.isSingleResultCallArgumentHandled(callback, callNode, 0, state)
}

func (a *Analyzer) isSingleResultCallArgumentHandled(callback *ast.Node, callNode *ast.Node, argIndex int, state *handleSearchState) bool {
	if argIndex < 0 {
		return false
	}
	targets, ok := a.resolveCallbackTargets(callback)
	if !ok || len(targets) == 0 {
		return false
	}
	isSingleArgCall := callNode == nil || callNode.Kind != ast.KindCallExpression || len(callNode.AsCallExpression().Arguments.Nodes) <= 1
	for _, cb := range targets {
		if argIndex == 0 && isSingleArgCall {
			switch a.classifyResultCallback(cb) {
			case resultCallbackConsumer:
				continue
			case resultCallbackTransformer:
				if a.isHandledReferenceWithState(callNode, state) {
					continue
				}
				return false
			case resultCallbackTupleCombiner, resultCallbackTupleConsumer:
				return false
			}
		} else if a.classifyResultCallback(cb) != resultCallbackNone {
			return false
		}
		params := cb.Parameters()
		if argIndex >= len(params) || params[argIndex].Name() == nil {
			return false
		}
		paramNode := params[argIndex]
		param := paramNode.Name()
		targetCb := cb
		if !state.withCallback(targetCb, callNode, "then", -1, func() bool {
			if paramNode.AsParameterDeclaration().DotDotDotToken != nil {
				if argIndex != 0 {
					return false
				}
				if param.Kind == ast.KindIdentifier {
					return a.isTupleVariableElementHandled(param, 0, state)
				}
				if param.Kind == ast.KindArrayBindingPattern {
					return a.isArrayBindingElementHandled(param, 0, false, state.sourceSymbol, state)
				}
				return false
			}
			if param.Kind == ast.KindIdentifier {
				return a.isIdentifierVariableHandled(param, state)
			}
			return false
		}) {
			return false
		}
	}
	return true
}

func (a *Analyzer) isArrayBindingElementHandled(patternNode *ast.Node, elemIndex int, allowMustUseBinding bool, sourceSymbol *ast.Symbol, state *handleSearchState) bool {
	if state == nil || patternNode == nil || patternNode.Kind != ast.KindArrayBindingPattern {
		return false
	}
	for i, elem := range patternNode.Elements() {
		if elem == nil || elem.Kind != ast.KindBindingElement {
			continue
		}
		binding := elem.AsBindingElement()
		if binding.DotDotDotToken != nil && i <= elemIndex {
			restName := elem.Name()
			restIndex := elemIndex - i
			if restName == nil {
				return false
			}
			if restName.Kind == ast.KindIdentifier {
				return a.isTupleVariableElementHandled(restName, restIndex, state)
			}
			if restName.Kind == ast.KindArrayBindingPattern {
				return a.isArrayBindingElementHandled(restName, restIndex, allowMustUseBinding, sourceSymbol, state)
			}
			return false
		}
		if i == elemIndex {
			bindingName := elem.Name()
			if bindingName == nil || bindingName.Kind != ast.KindIdentifier {
				return false
			}
			targetSymbol := a.checker.GetSymbolAtLocation(bindingName)
			if (sourceSymbol != nil && targetSymbol == sourceSymbol) ||
				(state.sourceSymbol != nil && targetSymbol == state.sourceSymbol) {
				return false
			}
			if allowMustUseBinding && isMustUseResultarType(a.checker.GetTypeAtLocation(bindingName)) {
				return true
			}
			return a.isIdentifierVariableHandled(bindingName, state)
		}
	}
	return false
}

func (a *Analyzer) isConsumedByPromiseAll(identifier *ast.Node, state *handleSearchState) bool {
	elemRoot, elemParent := a.referenceChainRoot(identifier)
	if elemParent == nil || elemParent.Kind != ast.KindArrayLiteralExpression {
		return false
	}
	elemIndex := -1
	for i, elem := range elemParent.Elements() {
		if elem == elemRoot {
			elemIndex = i
			break
		}
	}
	if elemIndex < 0 {
		return false
	}
	arr := elemParent
	for arr.Parent != nil && (isWrapperParent(arr.Parent, arr) || a.isIdentityCall(arr.Parent, arr)) {
		arr = arr.Parent
	}
	arrParent := arr.Parent
	if arrParent == nil {
		return false
	}
	if a.isPromiseResolveCall(arrParent, arr) || a.isPromiseAllCall(arrParent, arr) {
		return a.isPromiseAllCallElementHandled(arrParent, elemIndex, state)
	}
	if arrParent.Kind == ast.KindVariableDeclaration {
		decl := arrParent.AsVariableDeclaration()
		name := arrParent.Name()
		if decl.Initializer == arr && name != nil && !isExplicitDiscard(arr) {
			if name.Kind == ast.KindArrayBindingPattern {
				return a.isArrayBindingElementHandled(name, elemIndex, false, state.sourceSymbol, state)
			}
			if name.Kind == ast.KindIdentifier &&
				a.checker.GetSymbolAtLocation(name) != a.checker.GetSymbolAtLocation(identifier) &&
				(state.sourceSymbol == nil || a.checker.GetSymbolAtLocation(name) != state.sourceSymbol) {
				return a.isTupleVariableElementHandled(name, elemIndex, state)
			}
		}
	}
	return false
}

func (a *Analyzer) isPromiseAllCallElementHandled(allExpr *ast.Node, elemIndex int, state *handleSearchState) bool {
	if allExpr == nil || state == nil {
		return false
	}
	key := nodeVisitKey{node: allExpr, elemIndex: elemIndex, kind: nodeVisitPromiseAll, callContext: state.activeCallContext()}
	if state.visitedNodes[key] {
		return false
	}
	state.visitedNodes[key] = true
	allRoot := allExpr
	awaited := false
	for allRoot.Parent != nil {
		parent := allRoot.Parent
		if isWrapperParent(parent, allRoot) || a.isIdentityCall(parent, allRoot) {
			allRoot = parent
			continue
		}
		if parent.Kind == ast.KindAwaitExpression && parent.Expression() == allRoot {
			awaited = true
			allRoot = parent
			continue
		}
		if a.isPromiseResolveCall(parent, allRoot) || (awaited && a.isPromiseAllCall(parent, allRoot)) {
			awaited = false
			allRoot = parent
			continue
		}
		if !awaited && parent.Kind == ast.KindPropertyAccessExpression &&
			parent.AsPropertyAccessExpression().Expression == allRoot &&
			parent.Name() != nil && parent.Name().Text() == "then" &&
			parent.Parent != nil && parent.Parent.Kind == ast.KindCallExpression &&
			parent.Parent.AsCallExpression().Expression == parent &&
			a.isPassthroughThenCall(parent.Parent) {
			allRoot = parent.Parent
			continue
		}
		break
	}
	allParent := allRoot.Parent
	if allParent == nil {
		return false
	}
	if allParent.Kind == ast.KindPropertyAccessExpression && allParent.AsPropertyAccessExpression().Expression == allRoot {
		propName := allParent.Name().Text()
		if !awaited && propName == "then" && allParent.Parent != nil && allParent.Parent.Kind == ast.KindCallExpression && allParent.Parent.AsCallExpression().Expression == allParent {
			thenArgs := allParent.Parent.AsCallExpression().Arguments.Nodes
			return len(thenArgs) > 0 && a.isPromiseAllThenCallbackHandled(thenArgs[0], allParent.Parent, elemIndex, state)
		}
		if awaited && isTupleElementCallbackMethod(propName) && allParent.Parent != nil && allParent.Parent.Kind == ast.KindCallExpression && allParent.Parent.AsCallExpression().Expression == allParent {
			callArgs := allParent.Parent.AsCallExpression().Arguments.Nodes
			return len(callArgs) > 0 && a.isTupleElementCallbackHandled(callArgs[0], allParent.Parent, propName, state)
		}
		return false
	}
	if allParent.Kind == ast.KindYieldExpression && allParent.AsYieldExpression().AsteriskToken != nil && allParent.Expression() == allRoot {
		return true
	}
	if (allParent.Kind == ast.KindReturnStatement && allParent.AsReturnStatement().Expression == allRoot) ||
		(allParent.Kind == ast.KindArrowFunction && allParent.Body() == allRoot) {
		return a.isReturnedTupleHandled(allParent, elemIndex, state)
	}
	if allParent.Kind == ast.KindVoidExpression && allParent.Expression() == allRoot {
		return true
	}
	if awaited && allParent.Kind == ast.KindElementAccessExpression && allParent.AsElementAccessExpression().Expression == allRoot && a.elementAccessMatchesIndex(allParent, elemIndex) {
		return a.isHandledReferenceWithState(allParent, state)
	}
	if awaited && allParent.Kind == ast.KindCallExpression && !a.isInsideDiscardedResultExpression(allParent) {
		if isMustUseResultarType(a.checker.GetTypeAtLocation(allParent)) {
			return true
		}
		call := allParent.AsCallExpression()
		if len(call.Arguments.Nodes) > 0 && call.Arguments.Nodes[0] == allRoot &&
			a.isResultTaskStaticConsumerCall(call.Expression) {
			return true
		}
	}
	if awaited && allParent.Kind == ast.KindForOfStatement && allParent.AsForInOrOfStatement().Expression == allRoot {
		initializer := allParent.AsForInOrOfStatement().Initializer
		if initializer != nil && initializer.Kind == ast.KindVariableDeclarationList && len(initializer.AsVariableDeclarationList().Declarations.Nodes) == 1 {
			loopDecl := initializer.AsVariableDeclarationList().Declarations.Nodes[0]
			if loopDecl.Name() != nil && loopDecl.Name().Kind == ast.KindIdentifier {
				return a.isIdentifierVariableHandled(loopDecl.Name(), state)
			}
		}
	}
	if allParent.Kind == ast.KindVariableDeclaration {
		declaration := allParent.AsVariableDeclaration()
		name := allParent.Name()
		if declaration.Initializer == allRoot && name != nil && !isExplicitDiscard(allRoot) {
			if awaited && name.Kind == ast.KindArrayBindingPattern {
				return a.isArrayBindingElementHandled(name, elemIndex, isCallLikeDiscard(allRoot), state.sourceSymbol, state)
			}
			exprSymbol := a.unwrappedExpressionSymbol(allExpr)
			if awaited && name.Kind == ast.KindIdentifier &&
				a.checker.GetSymbolAtLocation(name) != exprSymbol {
				return a.isTupleVariableElementHandled(name, elemIndex, state)
			}
			if !awaited && name.Kind == ast.KindIdentifier &&
				a.checker.GetSymbolAtLocation(name) != exprSymbol {
				return a.isPromiseAllVariableElementHandled(name, elemIndex, state)
			}
		}
	}
	return false
}

func (a *Analyzer) isPromiseAllThenCallbackHandled(callback *ast.Node, callNode *ast.Node, elemIndex int, state *handleSearchState) bool {
	return a.isTupleCallArgumentHandled(callback, callNode, 0, elemIndex, state)
}

func (a *Analyzer) isTupleCallArgumentHandled(callback *ast.Node, callNode *ast.Node, argIndex int, elemIndex int, state *handleSearchState) bool {
	if argIndex < 0 {
		return false
	}
	targets, ok := a.resolveCallbackTargets(callback)
	if !ok || len(targets) == 0 {
		return false
	}
	isSingleArgCall := callNode == nil || callNode.Kind != ast.KindCallExpression || len(callNode.AsCallExpression().Arguments.Nodes) <= 1
	for _, cb := range targets {
		if argIndex == 0 && isSingleArgCall {
			switch a.classifyResultCallback(cb) {
			case resultCallbackTupleConsumer:
				continue
			case resultCallbackTupleCombiner:
				if a.isHandledReferenceWithState(callNode, state) {
					continue
				}
				return false
			case resultCallbackConsumer, resultCallbackTransformer:
				return false
			}
		} else if a.classifyResultCallback(cb) != resultCallbackNone {
			return false
		}
		params := cb.Parameters()
		if argIndex >= len(params) || params[argIndex].Name() == nil || params[argIndex].AsParameterDeclaration().DotDotDotToken != nil {
			return false
		}
		paramName := params[argIndex].Name()
		targetCb := cb
		if !state.withCallback(targetCb, callNode, "then", elemIndex, func() bool {
			if paramName.Kind == ast.KindArrayBindingPattern {
				return a.isArrayBindingElementHandled(paramName, elemIndex, false, state.sourceSymbol, state)
			}
			if paramName.Kind == ast.KindIdentifier {
				return a.isTupleVariableElementHandled(paramName, elemIndex, state)
			}
			return false
		}) {
			return false
		}
	}
	return true
}

func (a *Analyzer) isPromiseAllVariableElementHandled(nameNode *ast.Node, elemIndex int, state *handleSearchState) bool {
	if nameNode == nil || nameNode.Kind != ast.KindIdentifier || state == nil {
		return false
	}
	symbol := a.checker.GetSymbolAtLocation(nameNode)
	file := ast.GetSourceFileOfNode(nameNode)
	if symbol == nil || file == nil {
		return false
	}
	key := symbolVisitKey{symbol: symbol, elemIndex: elemIndex, kind: symVisitPromiseAll, callContext: state.activeCallContext()}
	if state.visitedSymbols[key] {
		return false
	}
	state.visitedSymbols[key] = true
	handled := false
	visit(file.AsNode(), func(node *ast.Node) {
		if handled || node == nameNode || node.Kind != ast.KindIdentifier || isDeclarationIdentifier(node) {
			return
		}
		if a.checker.GetSymbolAtLocation(node) == symbol && a.isPromiseAllCallElementHandled(node, elemIndex, state) {
			handled = true
		}
	})
	return handled
}

func (a *Analyzer) isDirectWholeTupleHandled(node *ast.Node, elemIndex int, state *handleSearchState) bool {
	current := node
	for current.Parent != nil {
		parent := current.Parent
		if isWrapperParent(parent, current) ||
			(parent.Kind == ast.KindAwaitExpression && parent.Expression() == current) ||
			a.isIdentityCall(parent, current) {
			current = parent
			continue
		}
		if a.isPromiseResolveCall(parent, current) || a.isPromiseAllCall(parent, current) {
			return a.isPromiseAllCallElementHandled(parent, elemIndex, state)
		}
		break
	}
	parent := current.Parent
	if parent == nil {
		return false
	}
	if (parent.Kind == ast.KindReturnStatement && parent.AsReturnStatement().Expression == current) ||
		(parent.Kind == ast.KindArrowFunction && parent.Body() == current) {
		return a.isReturnedTupleHandled(parent, elemIndex, state)
	}
	if parent.Kind == ast.KindVoidExpression && parent.Expression() == current {
		return true
	}
	if parent.Kind == ast.KindYieldExpression && parent.AsYieldExpression().AsteriskToken != nil && parent.Expression() == current {
		return true
	}
	if parent.Kind == ast.KindCallExpression && !a.isInsideDiscardedResultExpression(parent) {
		call := parent.AsCallExpression()
		if len(call.Arguments.Nodes) > 0 && call.Arguments.Nodes[0] == current {
			if a.isResultTaskStaticConsumerCall(call.Expression) {
				return true
			}
			if a.classifyCallbackOrResolved(call.Expression) == resultCallbackTupleCombiner &&
				a.isHandledReferenceWithState(parent, state) {
				return true
			}
		}
		argIndex := -1
		for i, arg := range call.Arguments.Nodes {
			if arg == current {
				argIndex = i
				break
			}
		}
		if argIndex >= 0 && a.isTupleCallArgumentHandled(call.Expression, parent, argIndex, elemIndex, state) {
			return true
		}
	}
	return false
}

func (a *Analyzer) isTupleVariableElementHandled(nameNode *ast.Node, elemIndex int, state *handleSearchState) bool {
	if nameNode == nil || nameNode.Kind != ast.KindIdentifier || state == nil {
		return false
	}
	symbol := a.checker.GetSymbolAtLocation(nameNode)
	file := ast.GetSourceFileOfNode(nameNode)
	if symbol == nil || file == nil {
		return false
	}
	key := symbolVisitKey{symbol: symbol, elemIndex: elemIndex, kind: symVisitTuple, callContext: state.activeCallContext()}
	if state.visitedSymbols[key] {
		return false
	}
	state.visitedSymbols[key] = true
	handled := false
	visit(file.AsNode(), func(node *ast.Node) {
		if handled || node == nameNode || node.Kind != ast.KindIdentifier || isDeclarationIdentifier(node) {
			return
		}
		if a.checker.GetSymbolAtLocation(node) != symbol {
			return
		}
		if a.isDirectWholeTupleHandled(node, elemIndex, state) {
			handled = true
			return
		}
		current := node
		for current.Parent != nil {
			p := current.Parent
			if isWrapperParent(p, current) ||
				(p.Kind == ast.KindAwaitExpression && p.Expression() == current) ||
				a.isIdentityCall(p, current) {
				current = p
				continue
			}
			break
		}
		parent := current.Parent
		if parent == nil {
			return
		}
		if parent.Kind == ast.KindElementAccessExpression && parent.AsElementAccessExpression().Expression == current && a.elementAccessMatchesIndex(parent, elemIndex) {
			if a.isHandledReferenceWithState(parent, state) {
				handled = true
				return
			}
			elemRoot, elemParent := a.referenceChainRoot(parent)
			if elemParent != nil && elemParent.Kind == ast.KindVariableDeclaration && elemParent.AsVariableDeclaration().Initializer == elemRoot &&
				elemParent.Name() != nil && elemParent.Name().Kind == ast.KindIdentifier &&
				(state.sourceSymbol == nil || a.checker.GetSymbolAtLocation(elemParent.Name()) != state.sourceSymbol) &&
				a.isIdentifierVariableHandled(elemParent.Name(), state) {
				handled = true
				return
			}
		}
		if parent.Kind == ast.KindVariableDeclaration && parent.AsVariableDeclaration().Initializer == current &&
			parent.Name() != nil && !isExplicitDiscard(current) {
			if parent.Name().Kind == ast.KindArrayBindingPattern &&
				a.isArrayBindingElementHandled(parent.Name(), elemIndex, isCallLikeDiscard(current), symbol, state) {
				handled = true
				return
			}
			if parent.Name().Kind == ast.KindIdentifier &&
				a.checker.GetSymbolAtLocation(parent.Name()) != symbol &&
				a.isTupleVariableElementHandled(parent.Name(), elemIndex, state) {
				handled = true
				return
			}
		}
		if parent.Kind == ast.KindForOfStatement && parent.AsForInOrOfStatement().Expression == current {
			initializer := parent.AsForInOrOfStatement().Initializer
			if initializer != nil && initializer.Kind == ast.KindVariableDeclarationList && len(initializer.AsVariableDeclarationList().Declarations.Nodes) == 1 {
				loopDecl := initializer.AsVariableDeclarationList().Declarations.Nodes[0]
				if loopDecl.Name() != nil && loopDecl.Name().Kind == ast.KindIdentifier && a.isIdentifierVariableHandled(loopDecl.Name(), state) {
					handled = true
					return
				}
			}
		}
		if parent.Kind == ast.KindPropertyAccessExpression && parent.AsPropertyAccessExpression().Expression == current &&
			isTupleElementCallbackMethod(parent.Name().Text()) &&
			parent.Parent != nil && parent.Parent.Kind == ast.KindCallExpression && parent.Parent.AsCallExpression().Expression == parent {
			args := parent.Parent.AsCallExpression().Arguments.Nodes
			if len(args) > 0 && a.isTupleElementCallbackHandled(args[0], parent.Parent, parent.Name().Text(), state) {
				handled = true
				return
			}
		}
	})
	return handled
}

func (a *Analyzer) isConsumedByResultTaskStaticCall(identifier *ast.Node) bool {
	current := identifier
	for parent := current.Parent; parent != nil; parent = current.Parent {
		if isReturnValueContainer(parent, current) ||
			(parent.Kind == ast.KindAwaitExpression && parent.Expression() == current) ||
			a.isPromiseResolveCall(parent, current) ||
			a.isIdentityCall(parent, current) ||
			a.isCurriedTransformerCall(parent, current) {
			current = parent
			continue
		}
		if parent.Kind == ast.KindPropertyAccessExpression && parent.AsPropertyAccessExpression().Expression == current {
			if parent.Name() != nil && parent.Name().Text() == "then" {
				if parent.Parent != nil && parent.Parent.Kind == ast.KindCallExpression &&
					parent.Parent.AsCallExpression().Expression == parent &&
					a.isPassthroughThenCall(parent.Parent) {
					current = parent.Parent
					continue
				}
				return false
			}
			if parent.Parent != nil && parent.Parent.Kind == ast.KindCallExpression &&
				parent.Parent.AsCallExpression().Expression == parent {
				callType := a.checker.GetTypeAtLocation(parent.Parent)
				if isMustUseResultarType(callType) || a.isPromiseOfResultLikeType(callType) {
					current = parent.Parent
					continue
				}
			}
			return false
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
			if len(call.Arguments.Nodes) >= 2 && call.Arguments.Nodes[0] == current && a.isPipeFunction(call.Expression) {
				steps := call.Arguments.Nodes[1:]
				allPrefixValid := true
				for _, step := range steps[:len(steps)-1] {
					if !a.isIdentityCallback(step) && !a.isCallbackTransformerExpression(step) {
						allPrefixValid = false
						break
					}
				}
				lastStep := steps[len(steps)-1]
				if allPrefixValid && a.isResultTaskStaticConsumerCall(lastStep) && !a.isInsideDiscardedResultExpression(parent) {
					return true
				}
				if everyUnionPart(a.checker.GetTypeAtLocation(current), isResultTaskLikeType) && !a.isInsideDiscardedResultExpression(parent) {
					return true
				}
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
				callType := a.checker.GetTypeAtLocation(parent)
				if isMustUseResultarType(callType) || a.isPromiseOfResultLikeType(callType) {
					current = parent
					continue
				}
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
	if a.classifyCallbackOrResolved(expression) == resultCallbackConsumer {
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
	if identifier == nil {
		return false
	}
	return a.isConsumedByReceiverChainWithState(identifier, newHandleSearchState(a.checker.GetSymbolAtLocation(identifier)))
}

func (a *Analyzer) isConsumedByReceiverChainWithState(identifier *ast.Node, state *handleSearchState) bool {
	current := identifier
	for parent := current.Parent; parent != nil; parent = current.Parent {
		if isWrapperParent(parent, current) ||
			(parent.Kind == ast.KindAwaitExpression && parent.Expression() == current) ||
			a.isPromiseResolveCall(parent, current) ||
			a.isIdentityCall(parent, current) ||
			a.isCurriedTransformerCall(parent, current) {
			current = parent
			continue
		}
		if parent.Kind == ast.KindPropertyAccessExpression && parent.AsPropertyAccessExpression().Expression == current {
			name := parent.Name().Text()
			if _, ok := consumerProperties[name]; ok {
				return true
			}
			if parent.Parent != nil && parent.Parent.Kind == ast.KindCallExpression && parent.Parent.AsCallExpression().Expression == parent {
				callNode := parent.Parent
				if _, ok := consumerMethods[name]; ok || a.isResultTaskInstanceRunner(name, parent.AsPropertyAccessExpression().Expression) {
					return true
				}
				if name == "then" {
					if a.isPassthroughThenCall(callNode) {
						current = callNode
						continue
					}
					thenArgs := callNode.AsCallExpression().Arguments.Nodes
					return len(thenArgs) > 0 && a.isSingleResultThenCallbackHandled(thenArgs[0], callNode, state)
				}
				if name == "pipe" && len(callNode.AsCallExpression().Arguments.Nodes) >= 1 {
					return true
				}
				callType := a.checker.GetTypeAtLocation(callNode)
				if isMustUseResultarType(callType) || a.isPromiseOfResultLikeType(callType) {
					current = callNode
					continue
				}
			}
			return false
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
