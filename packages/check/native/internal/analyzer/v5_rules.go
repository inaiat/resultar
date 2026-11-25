package analyzer

import (
	"fmt"
	"sort"
	"strings"

	"github.com/microsoft/TypeScript/tsc/internal/ast"
	"github.com/microsoft/TypeScript/tsc/internal/checker"
	"github.com/microsoft/TypeScript/tsc/internal/scanner"
)

var resultMemberNames = map[string]struct{}{
	"_tag": {}, "value": {}, "error": {},
	"isOk": {}, "isErr": {}, "match": {}, "matchTags": {}, "matchTagsPartial": {},
	"map": {}, "mapErr": {}, "andThen": {}, "orElse": {}, "orElseSucceed": {},
	"unwrapOr": {}, "unwrapOrElse": {}, "unwrapOrThrow": {}, "unwrapErr": {},
	"_unsafeUnwrap": {}, "_unsafeUnwrapErr": {},
	"inspect": {}, "inspectError": {}, "inspectBoth": {}, "log": {},
	"as": {}, "asVoid": {}, "toDisposable": {},
	"filterOrElse": {}, "catchTag": {}, "catchTags": {}, "catchReason": {}, "catchReasons": {},
	"unwrapReason": {}, "if": {}, "when": {}, "unless": {},
	"flip": {}, "toOption": {}, "pipe": {},
}

// Members that exist ONLY on synchronous Result (never on ResultTask).
var resultOnlyMemberNames = map[string]struct{}{
	"_tag": {}, "value": {}, "error": {},
	"isOk": {}, "isErr": {},
	"unwrapOrElse": {}, "unwrapOrThrow": {}, "unwrapErr": {},
	"_unsafeUnwrap": {}, "_unsafeUnwrapErr": {},
	"toDisposable": {},
}

// Members that exist ONLY on ResultTask (never on synchronous Result).
var taskOnlyMemberNames = map[string]struct{}{
	"runResult": {}, "runPromise": {}, "runExit": {}, "runSync": {}, "runSyncExit": {}, "runFork": {},
	"provideService": {}, "provideServices": {}, "provideServiceResolver": {}, "provideScope": {},
	"provideClock": {}, "provideTracer": {}, "provideScheduler": {},
	"retry": {}, "repeat": {}, "timeout": {}, "timed": {}, "delay": {},
	"tap": {}, "tapError": {}, "tapBoth": {}, "tapCause": {},
	"catchCause": {}, "inspectCause": {}, "ensuring": {}, "onExit": {}, "onInterrupt": {},
	"fork": {}, "forkChild": {}, "sandbox": {}, "unsandbox": {}, "scoped": {}, "zip": {},
	"schedule": {}, "withSpan": {}, "annotateSpan": {},
}

type awaitSurroundingIntent int

const (
	awaitIntentUnknown awaitSurroundingIntent = iota
	awaitIntentResult
	awaitIntentTask
)

func (a *Analyzer) isInsideResultTaskGen(node *ast.Node) bool {
	for current := node.Parent; current != nil; current = current.Parent {
		if isFunctionLikeNode(current) {
			parent := current.Parent
			for parent != nil && (parent.Kind == ast.KindParenthesizedExpression || parent.Kind == ast.KindAsExpression || parent.Kind == ast.KindSatisfiesExpression) {
				parent = parent.Parent
			}
			return parent != nil && a.resultTaskGenBody(parent) == current
		}
	}
	return false
}

// inspectMemberChain walks a fluent property/call chain starting at propAccess
// (e.g., `later.inspect(fn).map(g).runPromise()`) and reports whether it hits a
// Task-only member, a Result-only member, or any Result-compatible member, plus
// the outermost expression node at the end of the chain.
func inspectMemberChain(propAccess *ast.Node) (sawTaskOnly, sawResultOnly, sawResultMember bool, endExpr *ast.Node) {
	chainCur := propAccess
	endExpr = propAccess
	for chainCur != nil && chainCur.Kind == ast.KindPropertyAccessExpression && chainCur.Name() != nil {
		member := chainCur.Name().Text()
		if _, ok := taskOnlyMemberNames[member]; ok {
			sawTaskOnly = true
		}
		if _, ok := resultOnlyMemberNames[member]; ok {
			sawResultOnly = true
		}
		if _, ok := resultMemberNames[member]; ok {
			sawResultMember = true
		}
		endExpr = chainCur
		nextParent := chainCur.Parent
		if nextParent != nil && nextParent.Kind == ast.KindCallExpression && nextParent.AsCallExpression().Expression == chainCur {
			endExpr = nextParent
			afterCall := nextParent.Parent
			for afterCall != nil && afterCall.Kind == ast.KindParenthesizedExpression {
				afterCall = afterCall.Parent
			}
			if afterCall != nil && afterCall.Kind == ast.KindPropertyAccessExpression && afterCall.Expression() == unwrapParenthesesUp(nextParent, afterCall) {
				chainCur = afterCall
				continue
			}
		}
		break
	}
	return sawTaskOnly, sawResultOnly, sawResultMember, endExpr
}

func unwrapParenthesesUp(node, stop *ast.Node) *ast.Node {
	cur := node
	for cur != nil && cur.Parent != nil && cur.Parent != stop && cur.Parent.Kind == ast.KindParenthesizedExpression {
		cur = cur.Parent
	}
	return cur
}

func (a *Analyzer) classifyFunctionReturnIntent(fn *ast.Node) awaitSurroundingIntent {
	if fn == nil {
		return awaitIntentUnknown
	}
	classifyRetType := func(retType *checker.Type) awaitSurroundingIntent {
		if retType == nil || retType.Flags()&(checker.TypeFlagsAnyOrUnknown|checker.TypeFlagsVoid) != 0 {
			return awaitIntentUnknown
		}
		if isNativePromiseType(retType) {
			retType = a.checker.GetPromisedTypeOfPromise(retType)
		}
		if retType == nil || retType.Flags()&(checker.TypeFlagsAnyOrUnknown|checker.TypeFlagsVoid) != 0 {
			return awaitIntentUnknown
		}
		if a.isResultarSyncType(retType) && !isResultTaskLikeType(retType) {
			return awaitIntentResult
		}
		if isNarrowedResultTaskType(a.checker, retType) && !a.isResultarSyncType(retType) {
			return awaitIntentTask
		}
		return awaitIntentUnknown
	}
	if fn.Type() != nil {
		return classifyRetType(a.checker.GetTypeAtLocation(fn.Type()))
	}
	// Check contextual return type (e.g. `const f: () => Promise<Result<...>> = async () => ...`).
	// If the function's return type is purely inferred (no explicit annotation or contextual contract),
	// return awaitIntentUnknown so `--fix` never alters an inferred Promise<ResultTask<...>> contract.
	fnCtx := a.checker.GetContextualType(fn, checker.ContextFlagsNone)
	if fnCtx == nil {
		return awaitIntentUnknown
	}
	sigs := a.checker.GetCallSignatures(fnCtx)
	if len(sigs) == 0 {
		return awaitIntentUnknown
	}
	intent := awaitIntentUnknown
	for i, sig := range sigs {
		sigIntent := classifyRetType(a.checker.GetReturnTypeOfSignature(sig))
		if sigIntent == awaitIntentUnknown {
			return awaitIntentUnknown
		}
		if i == 0 {
			intent = sigIntent
		} else if intent != sigIntent {
			return awaitIntentUnknown
		}
	}
	return intent
}

func (a *Analyzer) classifyVariableUsage(file *ast.SourceFile, declNode *ast.Node, nameNode *ast.Node) awaitSurroundingIntent {
	if nameNode == nil || nameNode.Kind != ast.KindIdentifier {
		return awaitIntentUnknown
	}
	varSym := a.checker.GetSymbolAtLocation(nameNode)
	if varSym == nil {
		return awaitIntentUnknown
	}

	// Search within the enclosing function-like scope (or whole file if top-level).
	searchRoot := file.AsNode()
	for cur := declNode.Parent; cur != nil; cur = cur.Parent {
		if isFunctionLikeNode(cur) {
			searchRoot = cur
			break
		}
	}

	visited := make(map[*ast.Symbol]bool)
	usedAsTask, usedAsResult := a.collectSymbolUsageIntent(searchRoot, varSym, nameNode, visited)
	if usedAsTask && !usedAsResult {
		return awaitIntentTask
	}
	if usedAsResult && !usedAsTask {
		return awaitIntentResult
	}
	return awaitIntentUnknown
}

func (a *Analyzer) collectSymbolUsageIntent(searchRoot *ast.Node, sym *ast.Symbol, declIdent *ast.Node, visited map[*ast.Symbol]bool) (usedAsTask bool, usedAsResult bool) {
	if sym == nil || visited[sym] {
		return false, false
	}
	visited[sym] = true

	classifyConsumer := func(expr *ast.Node) {
		child := expr
		parent := expr.Parent
		for parent != nil && parent.Kind == ast.KindParenthesizedExpression {
			child = parent
			parent = parent.Parent
		}
		if parent == nil {
			return
		}

		// Follow derived local variables (e.g., `const next = later.inspect(fn); await next.runPromise()`).
		if parent.Kind == ast.KindVariableDeclaration && parent.Initializer() == child {
			if parent.Type() != nil {
				declaredType := a.checker.GetTypeAtLocation(parent.Type())
				if isNarrowedResultTaskType(a.checker, declaredType) && !a.isResultarSyncType(declaredType) {
					usedAsTask = true
				} else if a.isResultarSyncType(declaredType) {
					usedAsResult = true
				}
				return
			}
			if derivedName := parent.Name(); derivedName != nil && derivedName.Kind == ast.KindIdentifier {
				if derivedSym := a.checker.GetSymbolAtLocation(derivedName); derivedSym != nil {
					t, r := a.collectSymbolUsageIntent(searchRoot, derivedSym, derivedName, visited)
					usedAsTask = usedAsTask || t
					usedAsResult = usedAsResult || r
				}
			}
			return
		}

		// `yield* expr` inside ResultTask.gen expects a yieldable ResultTask.
		if parent.Kind == ast.KindYieldExpression && parent.AsYieldExpression().AsteriskToken != nil {
			if a.isInsideResultTaskGen(parent) {
				usedAsTask = true
				return
			}
		}

		// Explicit or contextual return type on enclosing function.
		if parent.Kind == ast.KindReturnStatement {
			for anc := parent.Parent; anc != nil; anc = anc.Parent {
				if isFunctionLikeNode(anc) {
					switch a.classifyFunctionReturnIntent(anc) {
					case awaitIntentTask:
						usedAsTask = true
					case awaitIntentResult:
						usedAsResult = true
					}
					break
				}
			}
			return
		}

		// Assignment to typed target (`target = expr`).
		if parent.Kind == ast.KindBinaryExpression {
			bin := parent.AsBinaryExpression()
			if bin.OperatorToken != nil && bin.OperatorToken.Kind == ast.KindEqualsToken && bin.Right == child {
				lhsType := a.checker.GetTypeAtLocation(bin.Left)
				if isNarrowedResultTaskType(a.checker, lhsType) && !a.isResultarSyncType(lhsType) {
					usedAsTask = true
				} else if a.isResultarSyncType(lhsType) {
					usedAsResult = true
				}
				return
			}
		}

		// Contextual type from call argument / property value.
		contextual := a.checker.GetContextualType(child, checker.ContextFlagsNone)
		if contextual != nil && contextual.Flags()&(checker.TypeFlagsAnyOrUnknown|checker.TypeFlagsVoid) == 0 {
			if isNarrowedResultTaskType(a.checker, contextual) && !a.isResultarSyncType(contextual) {
				usedAsTask = true
			} else if a.isResultarSyncType(contextual) {
				usedAsResult = true
			}
		}
	}

	visit(searchRoot, func(ref *ast.Node) {
		if ref == nil || ref.Kind != ast.KindIdentifier || ref == declIdent {
			return
		}
		if isDeclarationIdentifier(ref) {
			return
		}
		refSym := a.checker.GetSymbolAtLocation(ref)
		if ref.Parent != nil && ref.Parent.Kind == ast.KindShorthandPropertyAssignment && ref.Parent.Name() == ref {
			refSym = a.checker.GetShorthandAssignmentValueSymbol(ref.Parent)
		}
		if refSym != sym {
			return
		}

		child := ref
		parent := ref.Parent
		for parent != nil && parent.Kind == ast.KindParenthesizedExpression {
			child = parent
			parent = parent.Parent
		}
		if parent == nil {
			return
		}

		// Inspect full fluent property/call chain (e.g., `later.inspect(fn).runPromise()`).
		if parent.Kind == ast.KindPropertyAccessExpression && parent.Expression() == child && parent.Name() != nil {
			if a.ambiguousSuccessMember(ref, parent.Name().Text()) {
				return
			}
			sawTaskOnly, sawResultOnly, _, endExpr := inspectMemberChain(parent)
			if sawTaskOnly {
				usedAsTask = true
				return
			}
			if sawResultOnly {
				usedAsResult = true
				return
			}
			// Shared operators (map, inspect, unwrapOr, etc.) — inspect how the chain result is consumed!
			classifyConsumer(endExpr)
			return
		}

		classifyConsumer(ref)
	})

	return usedAsTask, usedAsResult
}

func (a *Analyzer) ambiguousSuccessMember(operand *ast.Node, name string) bool {
	if _, ok := resultOnlyMemberNames[name]; !ok {
		return false
	}
	args := typeArguments(a.checker, a.checker.GetTypeAtLocation(operand))
	if len(args) == 0 {
		return true
	}
	t := args[0]
	return !everyUnionPart(t, func(part *checker.Type) bool {
		return part.Flags()&(checker.TypeFlagsAnyOrUnknown|checker.TypeFlagsTypeParameter) == 0 && a.checker.GetPropertyOfType(part, name) == nil
	})
}

func (a *Analyzer) classifyAwaitSurrounding(file *ast.SourceFile, awaitNode *ast.Node) awaitSurroundingIntent {
	if awaitNode == nil {
		return awaitIntentUnknown
	}
	parent := awaitNode.Parent
	child := awaitNode
	for parent != nil && parent.Kind == ast.KindParenthesizedExpression {
		child = parent
		parent = parent.Parent
	}
	if parent == nil {
		return awaitIntentUnknown
	}

	switch parent.Kind {
	case ast.KindExpressionStatement:
		return awaitIntentUnknown
	case ast.KindPropertyAccessExpression:
		if parent.Expression() == child && parent.Name() != nil {
			if a.ambiguousSuccessMember(awaitNode.Expression(), parent.Name().Text()) {
				return awaitIntentUnknown
			}
			sawTaskOnly, sawResultOnly, _, endExpr := inspectMemberChain(parent)
			if sawTaskOnly && !sawResultOnly {
				return awaitIntentTask
			}
			if sawTaskOnly && sawResultOnly {
				return awaitIntentUnknown
			}
			if sawResultOnly {
				return awaitIntentResult
			}
			// Shared chain like `(await task).inspect(fn)` — check how endExpr is consumed.
			if endExpr != nil {
				endParent := endExpr.Parent
				endChild := endExpr
				for endParent != nil && endParent.Kind == ast.KindParenthesizedExpression {
					endChild = endParent
					endParent = endParent.Parent
				}
				if endParent != nil {
					if endParent.Kind == ast.KindVariableDeclaration && endParent.Initializer() == endChild {
						if intent := a.classifyVariableUsage(file, endParent, endParent.Name()); intent != awaitIntentUnknown {
							return intent
						}
					}
					if endParent.Kind == ast.KindReturnStatement {
						for anc := endParent.Parent; anc != nil; anc = anc.Parent {
							if isFunctionLikeNode(anc) {
								if intent := a.classifyFunctionReturnIntent(anc); intent != awaitIntentUnknown {
									return intent
								}
								break
							}
						}
					}
					contextual := a.checker.GetContextualType(endChild, checker.ContextFlagsNone)
					if contextual != nil && contextual.Flags()&(checker.TypeFlagsAnyOrUnknown|checker.TypeFlagsVoid) == 0 {
						if isNarrowedResultTaskType(a.checker, contextual) && !a.isResultarSyncType(contextual) {
							return awaitIntentTask
						}
						if a.isResultarSyncType(contextual) && !isResultTaskLikeType(contextual) {
							return awaitIntentResult
						}
					}
				}
			}
			return awaitIntentUnknown
		}
	case ast.KindVariableDeclaration:
		if parent.Initializer() != child {
			return awaitIntentUnknown
		}
		if parent.Type() != nil {
			declaredType := a.checker.GetTypeAtLocation(parent.Type())
			if a.isResultarSyncType(declaredType) {
				return awaitIntentResult
			}
			if isNarrowedResultTaskType(a.checker, declaredType) {
				return awaitIntentTask
			}
			return awaitIntentUnknown
		}
		if name := parent.Name(); name != nil && name.Kind == ast.KindObjectBindingPattern {
			sawResultOnly := false
			sawTaskOnly := false
			for _, elem := range name.AsBindingPattern().Elements.Nodes {
				propName := elem.PropertyName()
				if propName == nil {
					propName = elem.Name()
				}
				if propName == nil || propName.Kind != ast.KindIdentifier {
					return awaitIntentUnknown
				}
				if a.ambiguousSuccessMember(awaitNode.Expression(), propName.Text()) {
					return awaitIntentUnknown
				}
				if _, ok := resultOnlyMemberNames[propName.Text()]; ok {
					sawResultOnly = true
				}
				if _, ok := taskOnlyMemberNames[propName.Text()]; ok {
					sawTaskOnly = true
				} else if _, known := resultMemberNames[propName.Text()]; !known {
					return awaitIntentUnknown
				}
			}
			if sawResultOnly && !sawTaskOnly {
				return awaitIntentResult
			}
			if sawTaskOnly && !sawResultOnly {
				return awaitIntentTask
			}
			return awaitIntentUnknown
		}
		return a.classifyVariableUsage(file, parent, parent.Name())
	case ast.KindReturnStatement:
		for ancestor := parent.Parent; ancestor != nil; ancestor = ancestor.Parent {
			if isFunctionLikeNode(ancestor) {
				return a.classifyFunctionReturnIntent(ancestor)
			}
		}
		return awaitIntentUnknown
	case ast.KindArrowFunction:
		if parent.Body() == child {
			return a.classifyFunctionReturnIntent(parent)
		}
	case ast.KindBinaryExpression:
		bin := parent.AsBinaryExpression()
		if bin.OperatorToken != nil && bin.OperatorToken.Kind == ast.KindEqualsToken && bin.Right == child {
			lhsType := a.checker.GetTypeAtLocation(bin.Left)
			if a.isResultarSyncType(lhsType) {
				return awaitIntentResult
			}
			if isNarrowedResultTaskType(a.checker, lhsType) {
				return awaitIntentTask
			}
			return awaitIntentUnknown
		}
	}

	contextual := a.checker.GetContextualType(child, checker.ContextFlagsNone)
	if contextual != nil && contextual.Flags()&(checker.TypeFlagsAnyOrUnknown|checker.TypeFlagsVoid) == 0 {
		if a.isResultarSyncType(contextual) {
			return awaitIntentResult
		}
		if isNarrowedResultTaskType(a.checker, contextual) {
			return awaitIntentTask
		}
	}
	return awaitIntentUnknown
}

func operandNeedsParensForMemberAccess(node *ast.Node) bool {
	if node == nil {
		return false
	}
	switch node.Kind {
	case ast.KindIdentifier, ast.KindCallExpression, ast.KindPropertyAccessExpression,
		ast.KindElementAccessExpression, ast.KindParenthesizedExpression, ast.KindNonNullExpression,
		ast.KindThisKeyword, ast.KindSuperKeyword:
		return false
	default:
		return true
	}
}

func hasCommentTrivia(gap string) bool {
	return strings.Contains(gap, "//") || strings.Contains(gap, "/*")
}

func removeAwaitFix(file *ast.SourceFile, awaitNode, operand *ast.Node) Fix {
	awaitRange := scanner.GetRangeOfTokenAtPosition(file, awaitNode.Pos())
	awaitStart := awaitRange.Pos()
	awaitEnd := awaitRange.End()
	operandStart := scanner.GetRangeOfTokenAtPosition(file, operand.Pos()).Pos()
	text := file.Text()
	gap := text[awaitEnd:operandStart]
	if hasCommentTrivia(gap) {
		deleteEnd := awaitEnd
		for deleteEnd < operandStart && (text[deleteEnd] == ' ' || text[deleteEnd] == '\t') {
			deleteEnd++
		}
		if awaitNode.Parent != nil &&
			(awaitNode.Parent.Kind == ast.KindReturnStatement || awaitNode.Parent.Kind == ast.KindThrowStatement) &&
			strings.ContainsAny(gap, "\r\n") {
			return Fix{
				Title: "Remove redundant await on ResultTask",
				Kind:  FixCorrection,
				Edits: []TextEdit{
					{Start: awaitStart, Length: deleteEnd - awaitStart, NewText: "("},
					{Start: operand.End(), Length: 0, NewText: ")"},
				},
			}
		}
		return Fix{
			Title: "Remove redundant await on ResultTask",
			Kind:  FixCorrection,
			Edits: []TextEdit{{Start: awaitStart, Length: deleteEnd - awaitStart, NewText: ""}},
		}
	}
	return Fix{
		Title: "Remove redundant await on ResultTask",
		Kind:  FixCorrection,
		Edits: []TextEdit{{Start: awaitStart, Length: operandStart - awaitStart, NewText: ""}},
	}
}

func (a *Analyzer) noAwaitResultTask(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		if node.Kind != ast.KindAwaitExpression {
			return
		}
		operand := node.Expression()
		if operand == nil {
			return
		}
		operandType := a.checker.GetTypeAtLocation(operand)
		if !isResultTaskLikeType(operandType) {
			return
		}
		typeText := a.checker.TypeToStringEx(operandType, operand, checker.TypeFormatFlagsNoTruncation, nil)
		if a.isInsideResultTaskGen(node) {
			findings = append(findings, newFinding(file, node, "no-await-result-task", a.options.NoAwaitResultTask,
				"Do not `await` a ResultTask inside `ResultTask.gen` / `ResultTask.fn`. ResultTask is lazy and not a Promise; use `yield*` to unwrap success and propagate typed failure (changing to `yield*` alters control flow and requires review).", typeText))
			return
		}

		if !isNarrowedResultTaskType(a.checker, operandType) {
			findings = append(findings, newFinding(file, node, "no-await-result-task", a.options.NoAwaitResultTask,
				"Do not `await` a union containing ResultTask; ResultTask is lazy and not a Promise. Narrow the ResultTask branch and execute it explicitly with `.runResult()` or `.runPromise()`.", typeText))
			return
		}

		intent := a.classifyAwaitSurrounding(file, node)

		if intent == awaitIntentTask {
			finding := newFinding(file, node, "no-await-result-task", a.options.NoAwaitResultTask,
				"Do not `await` a ResultTask directly; ResultTask is lazy and not a Promise. Remove the redundant `await` when passing or executing the ResultTask explicitly later.", typeText)
			finding.Fixes = []Fix{removeAwaitFix(file, node, operand)}
			findings = append(findings, finding)
			return
		}

		if !taskHasNoServiceRequirements(a.checker, operandType) {
			findings = append(findings, newFinding(file, node, "no-await-result-task", a.options.NoAwaitResultTask,
				"Do not `await` a ResultTask directly; ResultTask is lazy and requires services. Provide its services with `.provideServices(...)` before executing with `.runResult()` or `.runPromise()`.", typeText))
			return
		}

		finding := newFinding(file, node, "no-await-result-task", a.options.NoAwaitResultTask,
			"Do not `await` a ResultTask directly; ResultTask is lazy and not a Promise. Execute it explicitly with `.runResult()` (returns `Promise<Result<...>>`) or `.runPromise()` at an async boundary.", typeText)
		if intent == awaitIntentResult {
			if operandNeedsParensForMemberAccess(operand) {
				sourceText := strings.TrimSpace(nodeSourceText(file, operand))
				finding.Fixes = []Fix{replaceSpanFix(file, operand, operand, "Execute ResultTask with .runResult()", fmt.Sprintf("(%s).runResult()", sourceText))}
			} else {
				finding.Fixes = []Fix{{
					Title: "Execute ResultTask with .runResult()",
					Kind:  FixCorrection,
					Edits: []TextEdit{{Start: operand.End(), Length: 0, NewText: ".runResult()"}},
				}}
			}
		}
		findings = append(findings, finding)
	})
	return findings
}

// Result.inspect swallows observer exceptions. Only autofix straightforward writes
// to initialized local variables; other observer bodies remain manual suggestions.
func safeInspectCallback(c *checker.Checker, callback *ast.Node) bool {
	statements := callback.Body().Statements()
	for _, statement := range statements[:len(statements)-1] {
		if statement.Kind != ast.KindExpressionStatement {
			return false
		}
		expr := unwrapExpression(statement.Expression())
		if expr.Kind != ast.KindBinaryExpression {
			return false
		}
		write := expr.AsBinaryExpression()
		if write.Left.Kind != ast.KindIdentifier || write.Right.Kind != ast.KindNumericLiteral {
			return false
		}
		switch write.OperatorToken.Kind {
		case ast.KindEqualsToken:
		case ast.KindPlusEqualsToken, ast.KindMinusEqualsToken:
			if t := c.GetTypeAtLocation(write.Left); t == nil || t.Flags()&checker.TypeFlagsNumberLike == 0 {
				return false
			}
		default:
			return false
		}
		sym := c.GetSymbolAtLocation(write.Left)
		if sym == nil || len(sym.Declarations()) != 1 {
			return false
		}
		decl := sym.Declarations()[0]
		if decl.Kind != ast.KindVariableDeclaration || decl.Parent == nil || decl.Parent.Flags&ast.NodeFlagsLet == 0 ||
			decl.AsVariableDeclaration().Initializer == nil || decl.End() >= callback.Pos() {
			return false
		}
		// A previous let in the same statement list has been initialized when
		// the callback runs. Crossing a function boundary loses that guarantee.
		group := decl.Parent.Parent
		if group == nil || group.Kind != ast.KindVariableStatement {
			return false
		}
		scope := callback.Parent
		for scope != nil && scope != group.Parent && !isFunctionLikeNode(scope) {
			scope = scope.Parent
		}
		if scope != group.Parent {
			return false
		}
	}
	return true
}

func preferTapVoidCallbackFix(
	file *ast.SourceFile,
	nameNode *ast.Node,
	callback *ast.Node,
	returned []*ast.Node,
	method string,
	replacement string,
) (Fix, bool) {
	if callback == nil || callback.Type() != nil || ast.HasSyntacticModifier(callback, ast.ModifierFlagsAsync) {
		return Fix{}, false
	}
	body := callback.Body()
	if body == nil || body.Kind != ast.KindBlock {
		return Fix{}, false
	}
	stmts := body.Statements()
	if len(stmts) < 2 || len(returned) == 0 {
		return Fix{}, false
	}
	renameRange := scanner.GetRangeOfTokenAtPosition(file, nameNode.Pos()).WithEnd(nameNode.End())
	edits := []TextEdit{{
		Start:   renameRange.Pos(),
		Length:  renameRange.Len(),
		NewText: replacement,
	}}
	seenRet := make(map[*ast.Node]bool, len(returned))
	for _, expr := range returned {
		if expr == nil || expr.Parent == nil || expr.Parent.Kind != ast.KindReturnStatement {
			return Fix{}, false
		}
		retStmt := expr.Parent
		if seenRet[retStmt] {
			continue
		}
		seenRet[retStmt] = true
		if retStmt == stmts[len(stmts)-1] {
			prevEnd := stmts[len(stmts)-2].End()
			retTokenStart := scanner.GetRangeOfTokenAtPosition(file, retStmt.Pos()).Pos()
			retEnd := retStmt.End()
			gap := file.Text()[prevEnd:retTokenStart]
			if !strings.Contains(gap, "//") && !strings.Contains(gap, "/*") {
				edits = append(edits, TextEdit{Start: prevEnd, Length: retEnd - prevEnd, NewText: ""})
			} else {
				edits = append(edits, TextEdit{Start: retTokenStart, Length: retEnd - retTokenStart, NewText: ""})
			}
		} else {
			retKeywordRange := scanner.GetRangeOfTokenAtPosition(file, retStmt.Pos())
			edits = append(edits, TextEdit{
				Start:   retKeywordRange.End(),
				Length:  expr.End() - retKeywordRange.End(),
				NewText: "",
			})
		}
	}
	sort.Slice(edits, func(i, j int) bool {
		return edits[i].Start < edits[j].Start
	})
	return Fix{
		Title: fmt.Sprintf("Replace %s with %s", method, replacement),
		Kind:  FixCorrection,
		Edits: edits,
	}, true
}
