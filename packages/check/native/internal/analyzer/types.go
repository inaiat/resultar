package analyzer

import (
	"regexp"

	"github.com/microsoft/TypeScript/tsc/internal/ast"
	"github.com/microsoft/TypeScript/tsc/internal/checker"
)

var resultTypeNames = map[string]struct{}{
	"DisposableResult": {}, "DisposableResultAsync": {}, "ErrResult": {}, "OkResult": {},
	"Result": {}, "ResultAsync": {}, "StrictResult": {}, "StrictResultAsync": {},
}

var resultTaskTypeNames = map[string]struct{}{
	"ResultTask": {},
}

var resultAsyncTypeNames = map[string]struct{}{
	"DisposableResultAsync": {}, "ResultAsync": {}, "StrictResultAsync": {},
}

var promiseTypePattern = regexp.MustCompile(`^Promise(?:Like)?<.+>$`)

func typeSymbolName(type_ *checker.Type) string {
	if type_ == nil {
		return ""
	}
	if alias := type_.Alias(); alias != nil && alias.Symbol() != nil {
		return alias.Symbol().Name()
	}
	if symbol := type_.Symbol(); symbol != nil {
		return symbol.Name()
	}
	if type_.Flags()&checker.TypeFlagsObject != 0 && type_.ObjectFlags()&checker.ObjectFlagsReference != 0 {
		if target := type_.Target(); target != nil && target.Symbol() != nil {
			return target.Symbol().Name()
		}
	}
	return ""
}

func isResultLikeType(type_ *checker.Type) bool {
	if type_ == nil {
		return false
	}
	if type_.Flags()&checker.TypeFlagsUnionOrIntersection != 0 {
		for _, part := range type_.Types() {
			if isResultLikeType(part) {
				return true
			}
		}
		return false
	}
	name := typeSymbolName(type_)
	if symbol := type_.Symbol(); symbol != nil {
		if _, ok := resultTypeNames[symbol.Name()]; ok {
			return true
		}
		if _, ok := resultTaskTypeNames[symbol.Name()]; ok {
			return true
		}
	}
	if _, ok := resultTypeNames[name]; ok {
		return true
	}
	_, ok := resultTaskTypeNames[name]
	return ok
}

func isMatchMatcherType(type_ *checker.Type) bool {
	if type_ == nil {
		return false
	}
	if type_.Flags()&checker.TypeFlagsUnionOrIntersection != 0 {
		for _, part := range type_.Types() {
			if isMatchMatcherType(part) {
				return true
			}
		}
		return false
	}
	if symbol := type_.Symbol(); symbol != nil && symbol.Name() == "MatchMatcher" {
		return true
	}
	return typeSymbolName(type_) == "MatchMatcher"
}

func isResultTaskLikeType(type_ *checker.Type) bool {
	if type_ == nil {
		return false
	}
	if type_.Flags()&checker.TypeFlagsUnionOrIntersection != 0 {
		for _, part := range type_.Types() {
			if isResultTaskLikeType(part) {
				return true
			}
		}
		return false
	}
	if alias := type_.Alias(); alias != nil && alias.Symbol() != nil {
		if _, ok := resultAsyncTypeNames[alias.Symbol().Name()]; ok {
			return false
		}
	}
	if symbol := type_.Symbol(); symbol != nil && symbol.Name() == "ResultTask" {
		return true
	}
	_, ok := resultTaskTypeNames[typeSymbolName(type_)]
	return ok
}

func isAwaitableResultTaskType(c *checker.Checker, type_ *checker.Type) bool {
	if type_ == nil || c == nil {
		return false
	}
	if type_.Flags()&checker.TypeFlagsUnionOrIntersection != 0 {
		for _, part := range type_.Types() {
			if isAwaitableResultTaskType(c, part) {
				return true
			}
		}
		return false
	}
	if !isResultTaskLikeType(type_) {
		return false
	}
	args := typeArguments(c, type_)
	if len(args) >= 3 && args[2] != nil && args[2].Flags()&checker.TypeFlagsNever != 0 {
		return true
	}
	return false
}

func isResultAsyncLikeType(type_ *checker.Type) bool {
	if type_ == nil {
		return false
	}
	if type_.Flags()&checker.TypeFlagsUnionOrIntersection != 0 {
		for _, part := range type_.Types() {
			if isResultAsyncLikeType(part) {
				return true
			}
		}
		return false
	}
	_, ok := resultAsyncTypeNames[typeSymbolName(type_)]
	return ok
}

// nodeCannotBeResultarType returns true for AST expressions whose grammar
// guarantees they can never produce a Result, ResultAsync, or ResultTask value,
// avoiding unnecessary checker.GetTypeAtLocation queries.
func nodeCannotBeResultarType(node *ast.Node) bool {
	node = unwrapExpression(node)
	if node == nil {
		return true
	}
	switch node.Kind {
	case ast.KindNumericLiteral,
		ast.KindBigIntLiteral,
		ast.KindStringLiteral,
		ast.KindRegularExpressionLiteral,
		ast.KindNoSubstitutionTemplateLiteral,
		ast.KindTemplateExpression,
		ast.KindTrueKeyword,
		ast.KindFalseKeyword,
		ast.KindNullKeyword,
		ast.KindPrefixUnaryExpression,
		ast.KindPostfixUnaryExpression,
		ast.KindDeleteExpression,
		ast.KindTypeOfExpression,
		ast.KindVoidExpression,
		ast.KindArrowFunction,
		ast.KindFunctionExpression,
		ast.KindClassExpression,
		ast.KindArrayLiteralExpression:
		return true
	default:
		return false
	}
}

func typeArguments(c *checker.Checker, t *checker.Type) []*checker.Type {
	if t == nil {
		return nil
	}
	if t.Flags()&checker.TypeFlagsObject != 0 && t.ObjectFlags()&checker.ObjectFlagsReference != 0 {
		return c.GetTypeArguments(t)
	}
	if alias := t.Alias(); alias != nil {
		return alias.TypeArguments()
	}
	return nil
}

func isPromiseLikeType(checker_ *checker.Checker, type_ *checker.Type) bool {
	if type_ == nil {
		return false
	}
	if type_.Flags()&checker.TypeFlagsUnionOrIntersection != 0 {
		for _, part := range type_.Types() {
			if isPromiseLikeType(checker_, part) {
				return true
			}
		}
		return false
	}
	name := typeSymbolName(type_)
	if name == "Promise" || name == "PromiseLike" {
		return true
	}
	return promiseTypePattern.MatchString(checker_.TypeToString(type_))
}

func hasUnknownOrAnyError(checker_ *checker.Checker, type_ *checker.Type) bool {
	if type_ == nil {
		return false
	}
	if type_.Flags()&checker.TypeFlagsUnionOrIntersection != 0 {
		for _, part := range type_.Types() {
			if hasUnknownOrAnyError(checker_, part) {
				return true
			}
		}
		return false
	}
	if !isResultLikeType(type_) {
		return false
	}
	arguments := typeArguments(checker_, type_)
	if len(arguments) < 2 || arguments[1] == nil {
		return false
	}
	return arguments[1].Flags()&checker.TypeFlagsAnyOrUnknown != 0
}

func resultErrorTypes(checker_ *checker.Checker, type_ *checker.Type) []*checker.Type {
	if type_ == nil {
		return nil
	}
	if type_.Flags()&checker.TypeFlagsUnionOrIntersection != 0 {
		result := make([]*checker.Type, 0)
		for _, part := range type_.Types() {
			result = append(result, resultErrorTypes(checker_, part)...)
		}
		return result
	}
	if !isResultLikeType(type_) {
		return nil
	}
	arguments := typeArguments(checker_, type_)
	if len(arguments) < 2 || arguments[1] == nil {
		return nil
	}
	return []*checker.Type{arguments[1]}
}

func isUnknownOrAnyType(type_ *checker.Type) bool {
	return type_ != nil && type_.Flags()&checker.TypeFlagsAnyOrUnknown != 0
}

func expressionName(node *ast.Node) string {
	node = unwrapExpression(node)
	if node == nil {
		return ""
	}
	if node.Kind == ast.KindIdentifier {
		return node.Text()
	}
	if node.Kind == ast.KindPropertyAccessExpression && node.Name() != nil {
		return node.Name().Text()
	}
	return ""
}

func unwrapExpression(node *ast.Node) *ast.Node {
	for node != nil {
		switch node.Kind {
		case ast.KindParenthesizedExpression, ast.KindAsExpression, ast.KindTypeAssertionExpression,
			ast.KindNonNullExpression, ast.KindSatisfiesExpression:
			node = node.Expression()
		default:
			return node
		}
	}
	return nil
}

// taskRequirementTypes extracts R, preserving aliases and union constituents.
func taskRequirementTypes(c *checker.Checker, t *checker.Type) []*checker.Type {
	if t == nil {
		return nil
	}
	if t.Flags()&checker.TypeFlagsUnionOrIntersection != 0 {
		var result []*checker.Type
		for _, part := range t.Types() {
			result = append(result, taskRequirementTypes(c, part)...)
		}
		return result
	}
	if !isResultTaskLikeType(t) {
		return nil
	}
	args := typeArguments(c, t)
	if len(args) < 3 {
		return nil
	}
	return []*checker.Type{args[2]}
}
