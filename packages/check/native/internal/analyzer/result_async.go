package analyzer

import (
	"path/filepath"
	"strings"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/checker"
)

func (a *Analyzer) preferResultAsync(file *ast.SourceFile) []Finding {
	findings := make([]Finding, 0)
	visit(file.AsNode(), func(node *ast.Node) {
		var type_ *checker.Type
		location := node
		if node.Kind == ast.KindTypeReference {
			type_ = a.checker.GetTypeAtLocation(node)
		} else if isFunctionLikeNode(node) && node.Type() == nil {
			signatures := a.checker.GetCallSignatures(a.checker.GetTypeAtLocation(node))
			if len(signatures) == 0 {
				return
			}
			type_ = a.checker.GetReturnTypeOfSignature(signatures[0])
			if node.Name() != nil {
				location = node.Name()
			} else if node.Parent != nil && node.Parent.Kind == ast.KindVariableDeclaration {
				location = node.Parent.Name()
			}
		} else {
			return
		}
		message := "Prefer ResultAsync<T, E> (or StrictResultAsync<T, E>) over Promise<Result<T, E>>. Remove the async wrapper and compose Resultar values directly, mapping external rejections at their source."
		if a.options.PreferResultAsyncMode == "all" {
			if !containsNativePromiseType(type_) {
				return
			}
			message = "Prefer ResultAsync<T, E> (or StrictResultAsync<T, E>) over native Promise contracts. Remove the async wrapper and map external rejections to typed errors in the adapter. Keep deliberate native framework boundaries explicit with a rule suppression."
		} else {
			if !isNativePromiseType(type_) {
				return
			}
			promised := a.checker.GetPromisedTypeOfPromise(type_)
			if !everyUnionPart(promised, isResultarSyncType) {
				return
			}
		}
		// Changing an annotation alone cannot turn an async function into ResultAsync.
		// This migration needs the implementation and its rejection boundaries to be reviewed.
		findings = append(findings, newFinding(file, location, "prefer-result-async", a.options.PreferResultAsync,
			message,
			a.checker.TypeToStringEx(type_, location, checker.TypeFormatFlagsNoTruncation, nil)))
	})
	return findings
}

func containsNativePromiseType(type_ *checker.Type) bool {
	if type_ == nil {
		return false
	}
	if type_.Flags()&(checker.TypeFlagsUnion|checker.TypeFlagsIntersection) != 0 {
		for _, part := range type_.Types() {
			if containsNativePromiseType(part) {
				return true
			}
		}
		return false
	}
	return isNativePromiseType(type_)
}

func isNativePromiseType(type_ *checker.Type) bool {
	if type_ == nil || type_.Flags()&checker.TypeFlagsObject == 0 || type_.ObjectFlags()&checker.ObjectFlagsReference == 0 {
		return false
	}
	target := type_.Target()
	if target == nil || target.Symbol() == nil || target.Symbol().Name != "Promise" {
		return false
	}
	for _, declaration := range target.Symbol().Declarations {
		file := ast.GetSourceFileOfNode(declaration)
		if file != nil && strings.HasPrefix(filepath.Base(file.FileName()), "lib.") && file.IsDeclarationFile {
			return true
		}
	}
	return false
}

func isResultarSyncType(type_ *checker.Type) bool {
	if type_ == nil {
		return false
	}
	if type_.Flags()&checker.TypeFlagsUnion != 0 {
		return everyUnionPart(type_, isResultarSyncType)
	}
	if type_.Flags()&checker.TypeFlagsIntersection != 0 {
		for _, part := range type_.Types() {
			if isResultarSyncType(part) {
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
		if symbol == nil || (symbol.Name != "Result" && symbol.Name != "StrictResult" && symbol.Name != "OkResult" && symbol.Name != "ErrResult") {
			continue
		}
		for _, declaration := range symbol.Declarations {
			file := ast.GetSourceFileOfNode(declaration)
			if file == nil {
				continue
			}
			path := filepath.ToSlash(file.FileName())
			if strings.Contains(path, "/node_modules/resultar/") || strings.Contains(path, "/packages/resultar/") {
				return true
			}
		}
	}
	return false
}
