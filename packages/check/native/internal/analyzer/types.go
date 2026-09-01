package analyzer

import (
	"regexp"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/checker"
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
		return alias.Symbol().Name
	}
	if symbol := type_.Symbol(); symbol != nil {
		return symbol.Name
	}
	if type_.Flags()&checker.TypeFlagsObject != 0 && type_.ObjectFlags()&checker.ObjectFlagsReference != 0 {
		if target := type_.Target(); target != nil && target.Symbol() != nil {
			return target.Symbol().Name
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
	if _, ok := resultTypeNames[name]; ok {
		return true
	}
	_, ok := resultTaskTypeNames[name]
	return ok
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
	_, ok := resultTaskTypeNames[typeSymbolName(type_)]
	return ok
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

func typeArguments(checker_ *checker.Checker, type_ *checker.Type) []*checker.Type {
	if type_ == nil {
		return nil
	}
	if alias := type_.Alias(); alias != nil && len(alias.TypeArguments()) > 0 {
		return alias.TypeArguments()
	}
	if type_.Flags()&checker.TypeFlagsObject != 0 && type_.ObjectFlags()&checker.ObjectFlagsReference != 0 {
		return checker_.GetTypeArguments(type_)
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
