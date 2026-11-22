package analyzer

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/microsoft/TypeScript/tsc/internal/ast"
	"github.com/microsoft/TypeScript/tsc/internal/checker"
	"github.com/microsoft/TypeScript/tsc/internal/compiler"
	"github.com/microsoft/TypeScript/tsc/internal/scanner"
	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/config"
)

type MigrationKind string

const (
	MigrationEdit   MigrationKind = "edit"
	MigrationReview MigrationKind = "review"
)

type MigrationItem struct {
	Kind        MigrationKind `json:"kind"`
	Category    string        `json:"category"`
	File        string        `json:"file"`
	Line        int           `json:"line"`
	Column      int           `json:"column"`
	Original    string        `json:"original"`
	Replacement string        `json:"replacement,omitempty"`
	Reason      string        `json:"reason"`
	Edits       []TextEdit    `json:"-"`
	Applied     bool          `json:"applied,omitempty"`
}

var eagerMovedToAsyncSubpath = map[string]bool{
	"ResultAsync":                       true,
	"StrictResultAsync":                 true,
	"DisposableResultAsync":             true,
	"okAsync":                           true,
	"errAsync":                          true,
	"unitAsync":                         true,
	"fromPromise":                       true,
	"fromSafePromise":                   true,
	"tryResultAsync":                    true,
	"fromCallback":                      true,
	"fromThrowableAsync":                true,
	"runPromise":                        true,
	"tryAsync":                          true,
	"tryCatchAsync":                     true,
	"safeTry":                           true,
	"asyncMap":                          true,
	"asyncAndThen":                      true,
	"TryResultAsyncOptions":             true,
	"AsyncResultGenOptions":             true,
	"ResultAsyncGenerator":              true,
	"SafeTryOptions":                    true,
	"SafeTryAsyncOptions":               true,
	"ResultAsyncAbortSignal":            true,
	"ResultAsyncCallbackCleanup":        true,
	"ResultAsyncCallbackContext":        true,
	"ResultAsyncConcurrency":            true,
	"ResultAsyncFromCallbackOptions":    true,
	"ResultAsyncRaceHandle":             true,
	"ResultAsyncRaceTask":               true,
	"ResultAsyncResourceAcquire":        true,
	"ResultAsyncResourceEffect":         true,
	"ResultAsyncResourceRelease":        true,
	"ResultAsyncResourceReleaseContext": true,
	"ResultAsyncResourceUse":            true,
	"ResultAsyncRetryContext":           true,
	"ResultAsyncRetryOptions":           true,
	"ResultAsyncRetryOrElseOptions":     true,
	"ResultAsyncRetryTask":              true,
	"ResultAsyncTimeoutOptions":         true,
	"ResultAsyncWithResourceOptions":    true,
}

var removedCoreImports = map[string]string{
	"try":                    "`try` was removed in v5; use `tryResult` / `Result.try`.",
	"tryCatch":               "`tryCatch` was removed in v5; use `tryResult` (sync) or `ResultTask.try` / `ResultTask.tryPromise`.",
	"ResultTaskRetryOptions": "`ResultTaskRetryOptions` was removed in v5; use `Retry.policy(...)` (`RetryPolicy<E>`).",
}

var deprecatedResultTaskAliases = map[string]string{
	"succeed":  "ok",
	"fail":     "err",
	"flatMap":  "andThen",
	"mapError": "mapErr",
	"catchAll": "orElse",
}

var deprecatedResultStaticAliases = map[string]string{
	"combine":              "all",
	"combineWithAllErrors": "validateAll",
	"tryCatch":             "try",
}

var deprecatedResultAsyncStatics = map[string]string{
	"all":                  "ResultTask.all",
	"combine":              "ResultTask.all",
	"combineWithAllErrors": "ResultTask.validateAll",
	"validateAll":          "ResultTask.validateAll",
	"zip":                  "ResultTask.zip",
	"retry":                "ResultTask.retry",
	"retryOrElse":          "ResultTask.retry + orElse",
	"race":                 "ResultTask.race",
	"raceAll":              "ResultTask.raceAll",
	"timeout":              "ResultTask.timeout",
	"firstSuccessOf":       "ResultTask.firstSuccessOf",
	"withResource":         "ResultTask.acquireRelease + ResultTask.scoped",
	"loop":                 "ResultTask.loop",
	"iterate":              "ResultTask.iterate",
	"forEach":              "ResultTask.forEach",
	"fromCallback":         "ResultTask.fromCallback",
	"fromThrowable":        "ResultTask.tryPromise",
	"tryCatch":             "ResultTask.tryPromise",
}

var requestTaskRenames = map[string]string{
	"requestJsonTask":                     "requestJson",
	"requestJsonZodTask":                  "requestJsonZod",
	"requestJsonTypeBoxTask":              "requestJsonTypeBox",
	"RequestJsonTaskBaseInput":            "RequestJsonBaseInput",
	"RequestJsonTaskRetry":                "RequestJsonRetry",
	"RequestJsonTaskInput":                "RequestJsonInput",
	"RequestJsonTaskDecodeInput":          "RequestJsonDecodeInput",
	"RequestJsonTaskValidatorInput":       "RequestJsonValidatorInput",
	"RequestJsonTaskMappedInput":          "RequestJsonMappedInput",
	"RequestJsonTaskMappedDecodeInput":    "RequestJsonMappedDecodeInput",
	"RequestJsonTaskMappedValidatorInput": "RequestJsonMappedValidatorInput",
	"RequestJsonZodTaskInput":             "RequestJsonZodInput",
	"RequestJsonZodTaskMappedInput":       "RequestJsonZodMappedInput",
	"RequestJsonTypeBoxTaskInput":         "RequestJsonTypeBoxInput",
	"RequestJsonTypeBoxTaskMappedInput":   "RequestJsonTypeBoxMappedInput",
}

var runResultFluentAsyncMethods = map[string]bool{
	"map": true, "mapErr": true, "andThen": true, "orElse": true, "orElseSucceed": true,
	"inspect": true, "inspectError": true, "inspectBoth": true, "log": true,
	"tap": true, "tapError": true, "toAsyncDisposable": true,
	"unwrapOrElse": true, "catchTag": true, "catchTags": true,
	"catchReason": true, "catchReasons": true, "filterOrElse": true,
	"unwrapReason": true, "when": true, "unless": true, "pipe": true,
	"as": true, "asVoid": true, "flip": true, "toOption": true,
}

var resultAsyncOnlyVarMethods = map[string]bool{
	"map": true, "mapErr": true, "andThen": true, "orElse": true, "orElseSucceed": true,
	"match": true, "matchTags": true, "matchTagsPartial": true,
	"unwrapOr": true, "unwrapOrElse": true, "unwrapOrThrow": true,
	"inspect": true, "inspectError": true, "inspectBoth": true, "log": true,
	"tap": true, "tapError": true, "toAsyncDisposable": true,
	"catchTag": true, "catchTags": true, "catchReason": true, "catchReasons": true,
	"filterOrElse": true, "unwrapReason": true, "when": true, "unless": true, "pipe": true,
	"as": true, "asVoid": true, "flip": true, "toOption": true,
}

// MigrateV5 analyzes every inspected source file in program and produces both
// safe mechanical edits and manual review items for the v4 -> v5 migration.
func MigrateV5(ctx context.Context, program *compiler.Program, projectDir string, options config.Options) ([]MigrationItem, error) {
	checker_, done := program.GetTypeChecker(ctx)
	defer done()
	if checker_ == nil {
		return nil, fmt.Errorf("unable to acquire TypeScript checker")
	}
	a := Analyzer{program: program, checker: checker_, options: options, projectDir: projectDir, cache: newAnalyzerCache()}
	items := make([]MigrationItem, 0)
	for _, file := range program.SourceFiles() {
		fileName := string(file.FileName())
		if !options.ShouldInspect(fileName, projectDir) {
			continue
		}
		items = append(items, a.migrateFileV5(file)...)
	}
	sort.SliceStable(items, func(left, right int) bool {
		if items[left].File != items[right].File {
			return filepath.ToSlash(items[left].File) < filepath.ToSlash(items[right].File)
		}
		if items[left].Line != items[right].Line {
			return items[left].Line < items[right].Line
		}
		if items[left].Column != items[right].Column {
			return items[left].Column < items[right].Column
		}
		return items[left].Category < items[right].Category
	})
	return items, nil
}

func makeMigrationItem(file *ast.SourceFile, node *ast.Node, kind MigrationKind, category, original, replacement, reason string, edits []TextEdit) MigrationItem {
	start := scanner.GetRangeOfTokenAtPosition(file, node.Pos()).Pos()
	line, column := scanner.GetECMALineAndUTF16CharacterOfPosition(file, start)
	return MigrationItem{
		Kind:        kind,
		Category:    category,
		File:        string(file.FileName()),
		Line:        line + 1,
		Column:      int(column) + 1,
		Original:    strings.TrimSpace(original),
		Replacement: strings.TrimSpace(replacement),
		Reason:      reason,
		Edits:       edits,
	}
}

type asyncSpecifierNeed struct {
	exportedName string
	localName    string
}

func (n asyncSpecifierNeed) format() string {
	if n.localName == "" || n.localName == n.exportedName {
		return n.exportedName
	}
	return n.exportedName + " as " + n.localName
}

type coreNamespaceInfo struct {
	decl       *ast.Node
	localName  string
	asyncAlias string
	totalRefs  int
	movedRefs  int
}

type fileMigrationState struct {
	neededAsyncValues  map[string]asyncSpecifierNeed // exportedName -> desired binding
	asyncValueBindings map[string]string             // exportedName -> existing local value binding name
	usedIdentNames     map[string]bool               // all non-resultar-async declared identifiers in file
	asyncImportDecl    *ast.Node
	asyncImportDecls   []*ast.Node
	resultarImportDecl *ast.Node
	requestRenamedSyms map[*ast.Symbol]string             // imported requestJson*Task symbol -> canonical v5 name
	coreNamespaces     map[*ast.Symbol]*coreNamespaceInfo // `import * as R from "resultar"`
	requestNamespaces  map[*ast.Symbol]bool               // `import * as Req from "resultar-request*"`
	replacedCoreNodes  map[*ast.Node]bool                 // identifier nodes whose core import reference was rewritten away
	prunedCoreSpecs    map[*ast.ImportSpecifier]bool      // core import specifiers left unused by our own rewrites
}

func (s *fileMigrationState) chooseFreshIdent(preferred string) string {
	if !s.usedIdentNames[preferred] {
		s.usedIdentNames[preferred] = true
		return preferred
	}
	candidates := []string{
		"Resultar" + preferred,
		"_" + preferred,
	}
	for _, c := range candidates {
		if !s.usedIdentNames[c] {
			s.usedIdentNames[c] = true
			return c
		}
	}
	for i := 2; ; i++ {
		c := fmt.Sprintf("Resultar%s%d", preferred, i)
		if !s.usedIdentNames[c] {
			s.usedIdentNames[c] = true
			return c
		}
	}
}

func (s *fileMigrationState) useAsyncValue(exportedName string) string {
	if localName, ok := s.asyncValueBindings[exportedName]; ok {
		return localName
	}
	if need, ok := s.neededAsyncValues[exportedName]; ok {
		return need.localName
	}
	localName := s.chooseFreshIdent(exportedName)
	s.neededAsyncValues[exportedName] = asyncSpecifierNeed{
		exportedName: exportedName,
		localName:    localName,
	}
	return localName
}

func (s *fileMigrationState) useAsyncNamespace(info *coreNamespaceInfo) string {
	if info.asyncAlias != "" {
		return info.asyncAlias
	}
	info.asyncAlias = s.chooseFreshIdent(info.localName + "Async")
	return info.asyncAlias
}

func collectDeclaredIdentifiers(file *ast.SourceFile, out map[string]bool) {
	visit(file.AsNode(), func(node *ast.Node) {
		if node == nil {
			return
		}
		switch node.Kind {
		case ast.KindVariableDeclaration, ast.KindBindingElement, ast.KindParameter,
			ast.KindFunctionDeclaration, ast.KindClassDeclaration,
			ast.KindInterfaceDeclaration, ast.KindTypeAliasDeclaration, ast.KindEnumDeclaration:
			if name := node.Name(); name != nil && name.Kind == ast.KindIdentifier {
				out[name.Text()] = true
			}
		case ast.KindNamespaceImport:
			if name := node.Name(); name != nil && name.Kind == ast.KindIdentifier {
				out[name.Text()] = true
			}
		case ast.KindImportClause:
			if name := node.Name(); name != nil && name.Kind == ast.KindIdentifier {
				out[name.Text()] = true
			}
		case ast.KindImportSpecifier:
			// Exclude unaliased type-only `resultar`/`resultar/async` specifiers for eager async symbols
			// so `import type { ResultAsync }` can be promoted cleanly to `import { ResultAsync }`.
			spec := node.AsImportSpecifier()
			impDecl := importDeclOfSpecifier(node)
			if impDecl != nil && impDecl.AsImportDeclaration().ModuleSpecifier != nil && impDecl.AsImportDeclaration().ModuleSpecifier.Kind == ast.KindStringLiteral {
				mod := impDecl.AsImportDeclaration().ModuleSpecifier.Text()
				if mod == "resultar" || mod == "resultar-app" || mod == "resultar/async" {
					importedName := spec.Name().Text()
					if spec.PropertyName != nil {
						importedName = spec.PropertyName.Text()
					}
					if eagerMovedToAsyncSubpath[importedName] && spec.PropertyName == nil {
						return
					}
				}
			}
			out[spec.Name().Text()] = true
		}
	})
}

func classifyResultarModule(moduleName string) string {
	switch moduleName {
	case "resultar", "resultar/result", "resultar/task", "resultar/tagged", "resultar/match", "resultar/retry", "resultar/function":
		return "core"
	case "resultar/async":
		return "async"
	case "resultar-app":
		return "app"
	case "resultar-request", "resultar-request-zod", "resultar-request-typebox":
		return "request"
	default:
		return ""
	}
}

func classifyResultarSourceFile(file *ast.SourceFile) string {
	if file == nil {
		return ""
	}
	p := strings.ReplaceAll(string(file.FileName()), "\\", "/")
	switch {
	case strings.Contains(p, "/node_modules/resultar/") || strings.Contains(p, "/packages/resultar/"):
		if strings.Contains(p, "/result-async/") || strings.HasSuffix(p, "/async.d.ts") || strings.HasSuffix(p, "/async.ts") {
			return "async"
		}
		return "core"
	case strings.Contains(p, "/node_modules/resultar-request") ||
		strings.Contains(p, "/packages/request/") ||
		strings.Contains(p, "/packages/request-zod/") ||
		strings.Contains(p, "/packages/request-typebox/"):
		return "request"
	case strings.Contains(p, "/node_modules/resultar-app/") || strings.Contains(p, "/packages/app/"):
		return "app"
	default:
		return ""
	}
}

func importDeclOfSpecifier(spec *ast.Node) *ast.Node {
	for cur := spec; cur != nil; cur = cur.Parent {
		if cur.Kind == ast.KindImportDeclaration {
			return cur
		}
	}
	return nil
}

// resolvePackageExport resolves node via the TypeScript checker to a Resultar
// package export, ignoring shadowed local parameters, variables, or unrelated classes.
func (a *Analyzer) resolvePackageExport(node *ast.Node) (pkgGroup string, exportName string, ok bool) {
	node = unwrapExpression(node)
	if node == nil {
		return "", "", false
	}
	sym := a.checker.GetSymbolAtLocation(node)
	if sym == nil {
		return "", "", false
	}

	// 1. Check direct import specifier alias on this symbol.
	if sym.Flags()&ast.SymbolFlagsAlias != 0 {
		for _, decl := range sym.Declarations() {
			if decl == nil || decl.Kind != ast.KindImportSpecifier {
				continue
			}
			impDecl := importDeclOfSpecifier(decl)
			if impDecl == nil {
				continue
			}
			modSpec := impDecl.AsImportDeclaration().ModuleSpecifier
			if modSpec == nil || modSpec.Kind != ast.KindStringLiteral {
				continue
			}
			if group := classifyResultarModule(modSpec.Text()); group != "" {
				spec := decl.AsImportSpecifier()
				name := spec.Name().Text()
				if spec.PropertyName != nil {
					name = spec.PropertyName.Text()
				}
				return group, name, true
			}
		}
	}

	// 2. Follow alias chain (re-exports, namespace member accesses like `R.ResultTask`).
	resolved := a.resolveAliasedSymbol(sym)
	if resolved == nil {
		return "", "", false
	}
	for _, decl := range resolved.Declarations() {
		if decl == nil {
			continue
		}
		sf := ast.GetSourceFileOfNode(decl)
		if group := classifyResultarSourceFile(sf); group != "" {
			return group, resolved.Name(), true
		}
	}
	return "", "", false
}

// isResultarDeclaredType verifies that at least one component of type_ is actually
// declared inside a Resultar package (not an unrelated user class sharing a name).
func (a *Analyzer) isResultarDeclaredType(type_ *checker.Type) bool {
	if type_ == nil {
		return false
	}
	if type_.Flags()&checker.TypeFlagsUnionOrIntersection != 0 {
		for _, part := range type_.Types() {
			if a.isResultarDeclaredType(part) {
				return true
			}
		}
		return false
	}
	checkSym := func(sym *ast.Symbol) bool {
		if sym == nil {
			return false
		}
		resolved := a.resolveAliasedSymbol(sym)
		if resolved == nil {
			resolved = sym
		}
		for _, decl := range resolved.Declarations() {
			if decl == nil {
				continue
			}
			if classifyResultarSourceFile(ast.GetSourceFileOfNode(decl)) != "" {
				return true
			}
		}
		return false
	}
	if alias := type_.Alias(); alias != nil && checkSym(alias.Symbol()) {
		return true
	}
	if checkSym(type_.Symbol()) {
		return true
	}
	if type_.Flags()&checker.TypeFlagsObject != 0 && type_.ObjectFlags()&checker.ObjectFlagsReference != 0 {
		if target := type_.Target(); target != nil && checkSym(target.Symbol()) {
			return true
		}
	}
	return false
}

func (a *Analyzer) migrateFileV5(file *ast.SourceFile) []MigrationItem {
	state := &fileMigrationState{
		neededAsyncValues:  make(map[string]asyncSpecifierNeed),
		asyncValueBindings: make(map[string]string),
		usedIdentNames:     make(map[string]bool),
		requestRenamedSyms: make(map[*ast.Symbol]string),
		coreNamespaces:     make(map[*ast.Symbol]*coreNamespaceInfo),
		requestNamespaces:  make(map[*ast.Symbol]bool),
		replacedCoreNodes:  make(map[*ast.Node]bool),
		prunedCoreSpecs:    make(map[*ast.ImportSpecifier]bool),
	}

	collectDeclaredIdentifiers(file, state.usedIdentNames)

	items := make([]MigrationItem, 0)
	var coreImportDecls []*ast.Node
	var coreExportDecls []*ast.Node
	var requestImportDecls []*ast.Node
	var requestExportDecls []*ast.Node
	var coreNamespaceOrder []*ast.Symbol

	for _, stmt := range file.Statements.Nodes {
		if stmt.Kind == ast.KindExportDeclaration {
			expDecl := stmt.AsExportDeclaration()
			if expDecl.ModuleSpecifier != nil && expDecl.ModuleSpecifier.Kind == ast.KindStringLiteral {
				switch expDecl.ModuleSpecifier.Text() {
				case "resultar", "resultar-app":
					coreExportDecls = append(coreExportDecls, stmt)
				case "resultar-request", "resultar-request-zod", "resultar-request-typebox":
					requestExportDecls = append(requestExportDecls, stmt)
				}
			}
			continue
		}
		if stmt.Kind != ast.KindImportDeclaration {
			continue
		}
		decl := stmt.AsImportDeclaration()
		if decl.ModuleSpecifier == nil || decl.ModuleSpecifier.Kind != ast.KindStringLiteral {
			continue
		}
		moduleName := decl.ModuleSpecifier.Text()
		switch moduleName {
		case "resultar", "resultar-app":
			if state.resultarImportDecl == nil {
				state.resultarImportDecl = stmt
			}
			coreImportDecls = append(coreImportDecls, stmt)
			if decl.ImportClause != nil {
				clause := decl.ImportClause.AsImportClause()
				collectAsyncValueBindings(clause, state.asyncValueBindings)
				if clause.NamedBindings != nil && clause.NamedBindings.Kind == ast.KindNamespaceImport {
					nsName := clause.NamedBindings.Name()
					if sym := a.checker.GetSymbolAtLocation(nsName); sym != nil {
						state.coreNamespaces[sym] = &coreNamespaceInfo{
							decl:      stmt,
							localName: nsName.Text(),
						}
						coreNamespaceOrder = append(coreNamespaceOrder, sym)
					}
				}
			}
		case "resultar/async":
			if state.asyncImportDecl == nil {
				state.asyncImportDecl = stmt
			}
			state.asyncImportDecls = append(state.asyncImportDecls, stmt)
			if decl.ImportClause != nil {
				collectAsyncValueBindings(decl.ImportClause.AsImportClause(), state.asyncValueBindings)
			}
		case "resultar-request", "resultar-request-zod", "resultar-request-typebox":
			requestImportDecls = append(requestImportDecls, stmt)
			if decl.ImportClause != nil {
				clause := decl.ImportClause.AsImportClause()
				if clause.NamedBindings != nil && clause.NamedBindings.Kind == ast.KindNamespaceImport {
					if sym := a.checker.GetSymbolAtLocation(clause.NamedBindings.Name()); sym != nil {
						state.requestNamespaces[sym] = true
					}
				}
			}
		}
	}

	// Count total references to any `import * as R from "resultar"` namespace so we can
	// tell whether every reference moved to `resultar/async` (avoiding unused-import warnings).
	if len(state.coreNamespaces) > 0 {
		visit(file.AsNode(), func(node *ast.Node) {
			if node == nil || node.Kind != ast.KindIdentifier || isDeclarationIdentifier(node) {
				return
			}
			if node.Parent != nil && node.Parent.Kind == ast.KindNamespaceImport {
				return
			}
			if sym := a.checker.GetSymbolAtLocation(node); sym != nil {
				if info, ok := state.coreNamespaces[sym]; ok {
					info.totalRefs++
				}
			}
		})
	}

	// Collect request package renames (keyed by TS symbol so shadowed locals are never renamed).
	for _, stmt := range requestImportDecls {
		items = append(items, a.migrateRequestImport(file, stmt, state)...)
	}
	for _, stmt := range requestExportDecls {
		items = append(items, migrateRequestExportDecl(file, stmt)...)
	}
	for _, stmt := range coreExportDecls {
		items = append(items, migrateCoreExportDecl(file, stmt)...)
	}

	// Track which call expressions were already handled as part of a larger pattern (e.g. runResult().unwrapOrThrow()).
	consumedNodes := make(map[*ast.Node]bool)

	// Walk AST for call expressions, namespace member accesses, and renamed requestJson*Task identifier references.
	visit(file.AsNode(), func(node *ast.Node) {
		if consumedNodes[node] {
			return
		}
		switch node.Kind {
		case ast.KindCallExpression:
			items = append(items, a.migrateCallV5(file, node, state, consumedNodes)...)
		case ast.KindPropertyAccessExpression:
			items = append(items, a.migrateNamespaceAccessV5(file, node.Expression(), node.Name(), state)...)
		case ast.KindQualifiedName:
			qn := node.AsQualifiedName()
			items = append(items, a.migrateNamespaceAccessV5(file, qn.Left, qn.Right, state)...)
		case ast.KindElementAccessExpression:
			elem := node.AsElementAccessExpression()
			items = append(items, a.checkNamespaceElementAccessV5(file, elem.Expression, elem.ArgumentExpression, state)...)
		case ast.KindVariableDeclaration:
			items = append(items, a.checkNamespaceDestructureV5(file, node, state)...)
		case ast.KindIdentifier:
			if len(state.requestRenamedSyms) == 0 {
				return
			}
			if node.Parent != nil && (node.Parent.Kind == ast.KindImportSpecifier ||
				(node.Parent.Kind == ast.KindPropertyAccessExpression && node.Parent.Name() == node) ||
				(node.Parent.Kind == ast.KindPropertyAssignment && node.Parent.Name() == node)) {
				return
			}
			refSym := a.checker.GetSymbolAtLocation(node)
			isShorthand := node.Parent != nil && node.Parent.Kind == ast.KindShorthandPropertyAssignment && node.Parent.Name() == node
			if isShorthand {
				refSym = a.checker.GetShorthandAssignmentValueSymbol(node.Parent)
			}
			if refSym != nil {
				if newName, ok := state.requestRenamedSyms[refSym]; ok {
					repl := newName
					if isShorthand {
						repl = node.Text() + ": " + newName
					}
					items = append(items, makeMigrationItem(
						file, node, MigrationEdit, "request-task-rename",
						node.Text(), repl,
						fmt.Sprintf("Rename `%s` to canonical v5 Task-native `%s`.", node.Text(), newName),
						[]TextEdit{renameFix(file, node, "Rename to "+newName, repl).Edits[0]},
					))
				}
			}
		}
	})

	// Prune core import specifiers (e.g. `Result` or `ResultTask`) ONLY when our own rewrites
	// (such as `Result.gen` -> `ResultAsync.gen`) removed their last remaining reference in this file.
	if len(state.replacedCoreNodes) > 0 {
		a.collectPrunedCoreImportSpecifiers(file, coreImportDecls, state)
	}

	// Process core `"resultar"` / `"resultar-app"` named imports AFTER walking the body so we can
	// merge any newly required `"resultar/async"` value imports cleanly in one edit.
	satisfiedValues := make(map[string]bool)
	satisfiedLocalValues := make(map[string]bool)
	for _, localName := range state.asyncValueBindings {
		satisfiedLocalValues[localName] = true
	}
	for _, stmt := range coreImportDecls {
		importItems := migrateCoreImport(file, stmt, state, satisfiedValues, satisfiedLocalValues)
		items = append(items, importItems...)
	}

	// Emit namespace imports and any remaining required named `resultar/async` imports.
	// Combine insertions targeting the same anchor offset into a single TextEdit so none are dropped.
	missingNamed := missingAsyncValues(state, satisfiedValues)
	var extraInsertLines []string
	var insertAnchor *ast.Node
	if state.resultarImportDecl != nil {
		insertAnchor = state.resultarImportDecl
	}

	// Handle `import * as R from "resultar"` namespaces that had eager members moved to `RAsync`
	// or had all references rewritten away (e.g. `R.Result.gen` -> `ResultAsync.gen`).
	for _, nsSym := range coreNamespaceOrder {
		info := state.coreNamespaces[nsSym]
		if info.asyncAlias == "" {
			if info.movedRefs > 0 && info.movedRefs == info.totalRefs {
				quote, semi := detectImportStyle(file, info.decl)
				orig := nodeSourceText(file, info.decl)
				if len(missingNamed) > 0 && len(state.asyncImportDecls) == 0 && info.decl == insertAnchor {
					replacement := formatNamedAsyncImport(missingNamed, quote, semi)
					for _, n := range missingNamed {
						satisfiedLocalValues[n.localName] = true
					}
					missingNamed = nil
					edit := replaceSpanFix(file, info.decl, info.decl, "Replace unused resultar namespace import with resultar/async import", replacement).Edits[0]
					items = append(items, makeMigrationItem(
						file, info.decl, MigrationEdit, "async-subpath-import",
						orig, replacement,
						fmt.Sprintf("Replace unused namespace import `%s` with `resultar/async` import.", info.localName),
						[]TextEdit{edit},
					))
				} else {
					edit := deleteStatementEdit(file, info.decl, "Remove unused resultar namespace import")
					items = append(items, makeMigrationItem(
						file, info.decl, MigrationEdit, "async-subpath-import",
						orig, "",
						fmt.Sprintf("Remove unused namespace import `%s` after migrating its usages to `resultar/async`.", info.localName),
						[]TextEdit{edit},
					))
				}
			}
			continue
		}
		quote, semi := detectImportStyle(file, info.decl)
		nsKeyword := "import"
		if clause := info.decl.AsImportDeclaration().ImportClause; clause != nil && clause.AsImportClause().PhaseModifier == ast.KindTypeKeyword {
			nsKeyword = "import type"
		}
		nsLine := fmt.Sprintf("%s * as %s from %sresultar/async%s%s", nsKeyword, info.asyncAlias, quote, quote, semi)
		if info.movedRefs > 0 && info.movedRefs == info.totalRefs {
			// Every reference to the namespace moved to `resultar/async` — replace the original import directly.
			replacement := nsLine
			if len(missingNamed) > 0 && len(state.asyncImportDecls) == 0 && info.decl == insertAnchor {
				replacement += "\n" + formatNamedAsyncImport(missingNamed, quote, semi)
				for _, n := range missingNamed {
					satisfiedLocalValues[n.localName] = true
				}
				missingNamed = nil
			}
			orig := nodeSourceText(file, info.decl)
			edit := replaceSpanFix(file, info.decl, info.decl, "Move eager namespace import to resultar/async", replacement).Edits[0]
			items = append(items, makeMigrationItem(
				file, info.decl, MigrationEdit, "async-subpath-import",
				orig, replacement,
				fmt.Sprintf("Move eager namespace import `%s` to `%s` from `resultar/async`.", info.localName, info.asyncAlias),
				[]TextEdit{edit},
			))
		} else {
			extraInsertLines = append(extraInsertLines, nsLine)
			if insertAnchor == nil {
				insertAnchor = info.decl
			}
		}
	}

	editedAsyncDecls := make(map[*ast.Node]bool)
	if len(missingNamed) > 0 {
		if len(state.asyncImportDecls) > 0 {
			items = append(items, mergeMissingIntoAsyncImports(file, state.asyncImportDecls, missingNamed, satisfiedLocalValues, editedAsyncDecls)...)
		} else {
			quote := "\""
			semi := ";"
			if insertAnchor != nil {
				quote, semi = detectImportStyle(file, insertAnchor)
			}
			for _, n := range missingNamed {
				satisfiedLocalValues[n.localName] = true
			}
			extraInsertLines = append(extraInsertLines, formatNamedAsyncImport(missingNamed, quote, semi))
		}
	}

	// Deduplicate any remaining unaliased type-only `resultar/async` specifiers whose local binding
	// is already satisfied by a value import (avoiding TS2300 duplicate identifier).
	for _, decl := range state.asyncImportDecls {
		if editedAsyncDecls[decl] {
			continue
		}
		if item, ok := pruneRedundantTypeOnlyAsyncImport(file, decl, satisfiedLocalValues); ok {
			items = append(items, item)
		}
	}

	if len(extraInsertLines) > 0 {
		combined := strings.Join(extraInsertLines, "\n")
		insertAt := 0
		prefix := ""
		suffix := "\n"
		anchor := file.AsNode()
		if insertAnchor != nil {
			anchor = insertAnchor
			insertAt = insertAnchor.End()
			prefix = "\n"
			suffix = ""
		}
		items = append(items, makeMigrationItem(
			file, anchor, MigrationEdit, "async-subpath-import",
			"", combined,
			"Add `resultar/async` compatibility import(s).",
			[]TextEdit{{Start: insertAt, Length: 0, NewText: prefix + combined + suffix}},
		))
	}

	return items
}

func (a *Analyzer) migrateNamespaceAccessV5(file *ast.SourceFile, left *ast.Node, right *ast.Node, state *fileMigrationState) []MigrationItem {
	if left == nil || right == nil || left.Kind != ast.KindIdentifier || right.Kind != ast.KindIdentifier {
		return nil
	}
	sym := a.checker.GetSymbolAtLocation(left)
	if sym == nil {
		return nil
	}
	member := right.Text()

	// 1. `import * as R from "resultar"` -> `R.okAsync`, `R.StrictResultAsync`, `R.ResultAsync`, etc.
	if info, ok := state.coreNamespaces[sym]; ok {
		if reason, removed := removedCoreImports[member]; removed {
			return []MigrationItem{makeMigrationItem(
				file, right, MigrationReview, "removed-v4-import",
				left.Text()+"."+member, "", reason, nil,
			)}
		}
		if eagerMovedToAsyncSubpath[member] {
			alias := state.useAsyncNamespace(info)
			info.movedRefs++
			edit := renameFix(file, left, "Use "+alias+" from resultar/async", alias).Edits[0]
			return []MigrationItem{makeMigrationItem(
				file, left, MigrationEdit, "async-subpath-import",
				left.Text()+"."+member, alias+"."+member,
				fmt.Sprintf("`%s` moved from `resultar` to `resultar/async`; access via `%s.%s`.", member, alias, member),
				[]TextEdit{edit},
			)}
		}
		return nil
	}

	// 2. `import * as Req from "resultar-request*"` -> `Req.requestJsonTask` -> `Req.requestJson`
	if state.requestNamespaces[sym] {
		if newName, ok := requestTaskRenames[member]; ok {
			edit := renameFix(file, right, "Rename "+member+" to "+newName, newName).Edits[0]
			return []MigrationItem{makeMigrationItem(
				file, right, MigrationEdit, "request-task-rename",
				left.Text()+"."+member, left.Text()+"."+newName,
				fmt.Sprintf("Rename `%s.%s` to canonical v5 Task-native `%s.%s`.", left.Text(), member, left.Text(), newName),
				[]TextEdit{edit},
			)}
		}
	}

	return nil
}

func (a *Analyzer) checkNamespaceElementAccessV5(file *ast.SourceFile, left *ast.Node, arg *ast.Node, state *fileMigrationState) []MigrationItem {
	if left == nil || left.Kind != ast.KindIdentifier || len(state.coreNamespaces) == 0 {
		return nil
	}
	sym := a.checker.GetSymbolAtLocation(left)
	if sym == nil {
		return nil
	}
	if _, ok := state.coreNamespaces[sym]; !ok {
		return nil
	}
	if arg != nil && arg.Kind == ast.KindStringLiteral {
		member := arg.Text()
		if reason, removed := removedCoreImports[member]; removed {
			return []MigrationItem{makeMigrationItem(
				file, arg, MigrationReview, "removed-v4-import",
				left.Text()+"["+nodeSourceText(file, arg)+"]", "", reason, nil,
			)}
		}
		if eagerMovedToAsyncSubpath[member] {
			return []MigrationItem{makeMigrationItem(
				file, arg, MigrationReview, "async-subpath-import",
				left.Text()+"["+nodeSourceText(file, arg)+"]", "",
				fmt.Sprintf("`%s` moved from `resultar` to `resultar/async`; import it from `resultar/async`.", member),
				nil,
			)}
		}
	}
	return nil
}

func (a *Analyzer) checkNamespaceDestructureV5(file *ast.SourceFile, decl *ast.Node, state *fileMigrationState) []MigrationItem {
	if len(state.coreNamespaces) == 0 {
		return nil
	}
	init := unwrapExpression(decl.Initializer())
	if init == nil || init.Kind != ast.KindIdentifier {
		return nil
	}
	name := decl.Name()
	if name == nil || name.Kind != ast.KindObjectBindingPattern {
		return nil
	}
	sym := a.checker.GetSymbolAtLocation(init)
	if sym == nil {
		return nil
	}
	if _, ok := state.coreNamespaces[sym]; !ok {
		return nil
	}
	var items []MigrationItem
	for _, elem := range name.AsBindingPattern().Elements.Nodes {
		prop := elem.PropertyName()
		if prop == nil {
			prop = elem.Name()
		}
		if prop == nil || prop.Kind != ast.KindIdentifier {
			continue
		}
		member := prop.Text()
		if reason, removed := removedCoreImports[member]; removed {
			items = append(items, makeMigrationItem(
				file, elem, MigrationReview, "removed-v4-import",
				nodeSourceText(file, elem), "", reason, nil,
			))
		} else if eagerMovedToAsyncSubpath[member] {
			items = append(items, makeMigrationItem(
				file, elem, MigrationReview, "async-subpath-import",
				nodeSourceText(file, elem), "",
				fmt.Sprintf("`%s` moved from `resultar` to `resultar/async`; destructure or import it from `resultar/async` instead of `%s`.", member, init.Text()),
				nil,
			))
		}
	}
	return items
}

func formatNamedAsyncImport(needs []asyncSpecifierNeed, quote, semi string) string {
	parts := make([]string, 0, len(needs))
	for _, n := range needs {
		parts = append(parts, n.format())
	}
	return fmt.Sprintf("import { %s } from %sresultar/async%s%s", strings.Join(parts, ", "), quote, quote, semi)
}

func formatNeedNames(needs []asyncSpecifierNeed) string {
	parts := make([]string, 0, len(needs))
	for _, n := range needs {
		parts = append(parts, n.format())
	}
	return strings.Join(parts, ", ")
}

func collectAsyncValueBindings(clause *ast.ImportClause, out map[string]string) {
	if clause == nil || clause.PhaseModifier == ast.KindTypeKeyword {
		return
	}
	if clause.NamedBindings == nil || clause.NamedBindings.Kind != ast.KindNamedImports {
		return
	}
	for _, specNode := range clause.NamedBindings.AsNamedImports().Elements.Nodes {
		s := specNode.AsImportSpecifier()
		if s.IsTypeOnly {
			continue
		}
		localName := s.Name().Text()
		importedName := localName
		if s.PropertyName != nil {
			importedName = s.PropertyName.Text()
		}
		if eagerMovedToAsyncSubpath[importedName] {
			if _, exists := out[importedName]; !exists {
				out[importedName] = localName
			}
		}
	}
}

func detectImportStyle(file *ast.SourceFile, decl *ast.Node) (quote, semi string) {
	text := strings.TrimSpace(nodeSourceText(file, decl))
	quote = "\""
	var modSpec *ast.Node
	switch decl.Kind {
	case ast.KindImportDeclaration:
		modSpec = decl.AsImportDeclaration().ModuleSpecifier
	case ast.KindExportDeclaration:
		modSpec = decl.AsExportDeclaration().ModuleSpecifier
	}
	if modSpec != nil {
		modText := strings.TrimSpace(nodeSourceText(file, modSpec))
		if strings.HasPrefix(modText, "'") {
			quote = "'"
		}
	} else if strings.Contains(text, "'") && !strings.Contains(text, "\"") {
		quote = "'"
	}
	semi = ""
	if strings.HasSuffix(text, ";") {
		semi = ";"
	}
	return quote, semi
}

func missingAsyncValues(state *fileMigrationState, satisfied map[string]bool) []asyncSpecifierNeed {
	var missing []asyncSpecifierNeed
	for name, need := range state.neededAsyncValues {
		if _, hasValue := state.asyncValueBindings[name]; hasValue {
			continue
		}
		if satisfied[name] {
			continue
		}
		missing = append(missing, need)
	}
	sort.Slice(missing, func(i, j int) bool {
		return missing[i].exportedName < missing[j].exportedName
	})
	return missing
}

// formatModuleExportName formats an ImportSpecifier / ExportSpecifier identifier or ES2022
// string-literal module export name while preserving quotes on string literals (avoiding TS1005).
func formatModuleExportName(file *ast.SourceFile, node *ast.Node) string {
	if node == nil {
		return ""
	}
	if node.Kind == ast.KindStringLiteral {
		return strings.TrimSpace(nodeSourceText(file, node))
	}
	return node.Text()
}

func formatImportSpecifier(file *ast.SourceFile, s *ast.ImportSpecifier, includeTypePrefix bool) string {
	var parts []string
	if includeTypePrefix && s.IsTypeOnly {
		parts = append(parts, "type")
	}
	if s.PropertyName != nil {
		parts = append(parts, formatModuleExportName(file, s.PropertyName), "as", s.Name().Text())
	} else {
		parts = append(parts, s.Name().Text())
	}
	return strings.Join(parts, " ")
}

func formatExportSpecifier(file *ast.SourceFile, s *ast.ExportSpecifier, includeTypePrefix bool) string {
	var parts []string
	if includeTypePrefix && s.IsTypeOnly {
		parts = append(parts, "type")
	}
	if s.PropertyName != nil {
		parts = append(parts, formatModuleExportName(file, s.PropertyName), "as", formatModuleExportName(file, s.Name()))
	} else {
		parts = append(parts, formatModuleExportName(file, s.Name()))
	}
	return strings.Join(parts, " ")
}

func migrateCoreImport(
	file *ast.SourceFile,
	stmt *ast.Node,
	state *fileMigrationState,
	satisfiedValues map[string]bool,
	satisfiedLocalValues map[string]bool,
) []MigrationItem {
	decl := stmt.AsImportDeclaration()
	if decl.ImportClause == nil {
		return nil
	}
	clause := decl.ImportClause.AsImportClause()
	if clause.NamedBindings == nil || clause.NamedBindings.Kind != ast.KindNamedImports {
		return nil
	}
	quote, semi := detectImportStyle(file, stmt)
	moduleName := decl.ModuleSpecifier.Text()
	isWholeTypeOnly := clause.PhaseModifier == ast.KindTypeKeyword

	var coreSpecs []*ast.ImportSpecifier
	var asyncSpecs []*ast.ImportSpecifier
	prunedCount := 0
	items := make([]MigrationItem, 0)

	for _, specNode := range clause.NamedBindings.AsNamedImports().Elements.Nodes {
		spec := specNode.AsImportSpecifier()
		if state.prunedCoreSpecs[spec] {
			prunedCount++
			continue
		}
		importedName := spec.Name().Text()
		if spec.PropertyName != nil {
			importedName = spec.PropertyName.Text()
		}
		if reason, removed := removedCoreImports[importedName]; removed {
			items = append(items, makeMigrationItem(
				file, specNode, MigrationReview, "removed-v4-import",
				nodeSourceText(file, specNode), "", reason, nil,
			))
			coreSpecs = append(coreSpecs, spec)
			continue
		}
		if eagerMovedToAsyncSubpath[importedName] {
			asyncSpecs = append(asyncSpecs, spec)
			continue
		}
		coreSpecs = append(coreSpecs, spec)
	}

	if len(asyncSpecs) == 0 && prunedCount == 0 {
		return items
	}

	// Determine which async specs should be promoted from type-only to value if the body needs that unaliased value,
	// and skip unaliased type-only specs already satisfied by an earlier value import (preventing TS2300).
	promoted := make(map[*ast.ImportSpecifier]bool)
	var keptAsyncSpecs []*ast.ImportSpecifier
	for _, spec := range asyncSpecs {
		localName := spec.Name().Text()
		importedName := localName
		if spec.PropertyName != nil {
			importedName = spec.PropertyName.Text()
		}
		if (isWholeTypeOnly || spec.IsTypeOnly) && spec.PropertyName == nil && satisfiedLocalValues[localName] {
			continue
		}
		need, needed := state.neededAsyncValues[importedName]
		if (isWholeTypeOnly || spec.IsTypeOnly) && spec.PropertyName == nil && needed && need.localName == localName && !satisfiedValues[importedName] {
			promoted[spec] = true
			satisfiedValues[importedName] = true
			satisfiedLocalValues[localName] = true
		} else if !isWholeTypeOnly && !spec.IsTypeOnly {
			if spec.PropertyName == nil {
				satisfiedValues[importedName] = true
			}
			satisfiedLocalValues[localName] = true
		}
		keptAsyncSpecs = append(keptAsyncSpecs, spec)
	}

	// Merge any newly required value imports from `resultar/async` into the split import if there is no separate existing `resultar/async` import.
	var extraNeeds []asyncSpecifierNeed
	if len(state.asyncImportDecls) == 0 && !isWholeTypeOnly {
		extraNeeds = missingAsyncValues(state, satisfiedValues)
		for _, n := range extraNeeds {
			satisfiedValues[n.exportedName] = true
			satisfiedLocalValues[n.localName] = true
		}
	}

	origText := nodeSourceText(file, stmt)
	if len(keptAsyncSpecs) == 0 && len(extraNeeds) == 0 {
		if len(coreSpecs) == 0 && clause.Name() == nil {
			edit := deleteStatementEdit(file, stmt, "Remove now-unused "+moduleName+" import")
			items = append(items, makeMigrationItem(
				file, stmt, MigrationEdit, "async-subpath-import",
				origText, "",
				"Remove now-unused `"+moduleName+"` import after migrating usages to `resultar/async`.",
				[]TextEdit{edit},
			))
			return items
		}
		coreFormatted := make([]string, 0, len(coreSpecs))
		for _, spec := range coreSpecs {
			coreFormatted = append(coreFormatted, formatImportSpecifier(file, spec, !isWholeTypeOnly))
		}
		coreKeyword := "import"
		if isWholeTypeOnly {
			coreKeyword = "import type"
		}
		replacement := fmt.Sprintf("%s { %s } from %s%s%s%s", coreKeyword, strings.Join(coreFormatted, ", "), quote, moduleName, quote, semi)
		edit := replaceSpanFix(file, stmt, stmt, "Remove redundant type-only ResultAsync specifiers", replacement).Edits[0]
		items = append(items, makeMigrationItem(
			file, stmt, MigrationEdit, "async-subpath-import",
			origText, replacement,
			"Move eager ResultAsync imports from `"+moduleName+"` to `resultar/async`.",
			[]TextEdit{edit},
		))
		return items
	}

	allAsyncTypeOnly := len(extraNeeds) == 0
	for _, spec := range keptAsyncSpecs {
		if promoted[spec] || (!isWholeTypeOnly && !spec.IsTypeOnly) {
			allAsyncTypeOnly = false
			break
		}
	}

	asyncFormatted := make([]string, 0, len(keptAsyncSpecs)+len(extraNeeds))
	for _, spec := range keptAsyncSpecs {
		if promoted[spec] {
			asyncFormatted = append(asyncFormatted, spec.Name().Text())
		} else if isWholeTypeOnly && !allAsyncTypeOnly {
			asyncFormatted = append(asyncFormatted, "type "+formatImportSpecifier(file, spec, false))
		} else {
			asyncFormatted = append(asyncFormatted, formatImportSpecifier(file, spec, !allAsyncTypeOnly))
		}
	}
	for _, n := range extraNeeds {
		asyncFormatted = append(asyncFormatted, n.format())
	}

	asyncImportKeyword := "import"
	if allAsyncTypeOnly {
		asyncImportKeyword = "import type"
	}
	asyncLine := fmt.Sprintf("%s { %s } from %sresultar/async%s%s", asyncImportKeyword, strings.Join(asyncFormatted, ", "), quote, quote, semi)

	var replacement string
	if len(coreSpecs) == 0 {
		replacement = asyncLine
	} else {
		coreFormatted := make([]string, 0, len(coreSpecs))
		for _, spec := range coreSpecs {
			coreFormatted = append(coreFormatted, formatImportSpecifier(file, spec, !isWholeTypeOnly))
		}
		coreKeyword := "import"
		if isWholeTypeOnly {
			coreKeyword = "import type"
		}
		coreLine := fmt.Sprintf("%s { %s } from %s%s%s%s", coreKeyword, strings.Join(coreFormatted, ", "), quote, moduleName, quote, semi)
		replacement = coreLine + "\n" + asyncLine
	}

	edit := replaceSpanFix(file, stmt, stmt, "Move eager ResultAsync imports to resultar/async", replacement).Edits[0]
	items = append(items, makeMigrationItem(
		file, stmt, MigrationEdit, "async-subpath-import",
		origText, replacement,
		"Move eager ResultAsync imports from `"+moduleName+"` to `resultar/async`.",
		[]TextEdit{edit},
	))
	return items
}

func (a *Analyzer) markReplacedCoreReceiver(node *ast.Node, state *fileMigrationState) {
	node = unwrapExpression(node)
	if node == nil {
		return
	}
	if node.Kind == ast.KindIdentifier {
		state.replacedCoreNodes[node] = true
		return
	}
	if node.Kind == ast.KindPropertyAccessExpression {
		left := unwrapExpression(node.Expression())
		if left != nil && left.Kind == ast.KindIdentifier {
			state.replacedCoreNodes[left] = true
			if sym := a.checker.GetSymbolAtLocation(left); sym != nil {
				if info, ok := state.coreNamespaces[sym]; ok {
					info.movedRefs++
				}
			}
		}
	}
}

func (a *Analyzer) collectPrunedCoreImportSpecifiers(file *ast.SourceFile, coreImportDecls []*ast.Node, state *fileMigrationState) {
	replacedSyms := make(map[*ast.Symbol]bool)
	for node := range state.replacedCoreNodes {
		if sym := a.checker.GetSymbolAtLocation(node); sym != nil {
			replacedSyms[sym] = true
		}
	}
	if len(replacedSyms) == 0 {
		return
	}
	remainingRefs := make(map[*ast.Symbol]int)
	visit(file.AsNode(), func(n *ast.Node) {
		if n == nil || n.Kind != ast.KindIdentifier || state.replacedCoreNodes[n] {
			return
		}
		if n.Parent != nil {
			switch n.Parent.Kind {
			case ast.KindImportSpecifier, ast.KindNamespaceImport:
				return
			case ast.KindPropertyAccessExpression, ast.KindPropertyAssignment:
				if n.Parent.Name() == n {
					return
				}
			}
		}
		refSym := a.checker.GetSymbolAtLocation(n)
		if n.Parent != nil && n.Parent.Kind == ast.KindShorthandPropertyAssignment && n.Parent.Name() == n {
			refSym = a.checker.GetShorthandAssignmentValueSymbol(n.Parent)
		}
		if refSym != nil && replacedSyms[refSym] {
			remainingRefs[refSym]++
		}
	})
	for _, stmt := range coreImportDecls {
		decl := stmt.AsImportDeclaration()
		if decl.ImportClause == nil {
			continue
		}
		clause := decl.ImportClause.AsImportClause()
		if clause.NamedBindings == nil || clause.NamedBindings.Kind != ast.KindNamedImports {
			continue
		}
		for _, specNode := range clause.NamedBindings.AsNamedImports().Elements.Nodes {
			spec := specNode.AsImportSpecifier()
			localName := spec.Name().Text()
			if isLocallyReexported(file, localName) {
				continue
			}
			specSym := a.checker.GetSymbolAtLocation(spec.Name())
			if specSym != nil && replacedSyms[specSym] && remainingRefs[specSym] == 0 {
				state.prunedCoreSpecs[spec] = true
			}
		}
	}
}

func deleteStatementEdit(file *ast.SourceFile, stmt *ast.Node, _ string) TextEdit {
	edit := replaceSpanFix(file, stmt, stmt, "", "").Edits[0]
	end := edit.Start + edit.Length
	text := file.Text()
	if end < len(text) && text[end] == '\r' {
		end++
	}
	if end < len(text) && text[end] == '\n' {
		end++
	}
	edit.Length = end - edit.Start
	return edit
}

func mergeMissingIntoAsyncImports(
	file *ast.SourceFile,
	decls []*ast.Node,
	missing []asyncSpecifierNeed,
	satisfiedLocalValues map[string]bool,
	editedDecls map[*ast.Node]bool,
) []MigrationItem {
	byDecl := make(map[*ast.Node][]asyncSpecifierNeed)
	var primary *ast.Node
	for _, decl := range decls {
		clauseNode := decl.AsImportDeclaration().ImportClause
		if clauseNode == nil {
			continue
		}
		clause := clauseNode.AsImportClause()
		if clause.NamedBindings == nil || clause.NamedBindings.Kind != ast.KindNamedImports {
			continue
		}
		if primary == nil || (primary.AsImportDeclaration().ImportClause.AsImportClause().PhaseModifier == ast.KindTypeKeyword && clause.PhaseModifier != ast.KindTypeKeyword) {
			primary = decl
		}
	}
	if primary == nil {
		return nil
	}

	for _, n := range missing {
		var matched *ast.Node
		for _, decl := range decls {
			clauseNode := decl.AsImportDeclaration().ImportClause
			if clauseNode == nil {
				continue
			}
			clause := clauseNode.AsImportClause()
			if clause.NamedBindings == nil || clause.NamedBindings.Kind != ast.KindNamedImports {
				continue
			}
			isWholeTypeOnly := clause.PhaseModifier == ast.KindTypeKeyword
			for _, specNode := range clause.NamedBindings.AsNamedImports().Elements.Nodes {
				spec := specNode.AsImportSpecifier()
				if (isWholeTypeOnly || spec.IsTypeOnly) && spec.PropertyName == nil && spec.Name().Text() == n.localName && n.exportedName == n.localName {
					matched = decl
					break
				}
			}
			if matched != nil {
				break
			}
		}
		if matched != nil {
			byDecl[matched] = append(byDecl[matched], n)
		} else {
			byDecl[primary] = append(byDecl[primary], n)
		}
		satisfiedLocalValues[n.localName] = true
	}

	var items []MigrationItem
	for _, decl := range decls {
		needs := byDecl[decl]
		if len(needs) == 0 {
			continue
		}
		if edit, orig, repl, ok := addSpecifiersToImport(file, decl, needs); ok {
			editedDecls[decl] = true
			items = append(items, makeMigrationItem(
				file, decl, MigrationEdit, "async-subpath-import",
				orig, repl,
				fmt.Sprintf("Import %s from `resultar/async`.", formatNeedNames(needs)),
				[]TextEdit{edit},
			))
		}
	}
	return items
}

func pruneRedundantTypeOnlyAsyncImport(
	file *ast.SourceFile,
	stmt *ast.Node,
	satisfiedLocalValues map[string]bool,
) (MigrationItem, bool) {
	decl := stmt.AsImportDeclaration()
	if decl.ImportClause == nil {
		return MigrationItem{}, false
	}
	clause := decl.ImportClause.AsImportClause()
	if clause.NamedBindings == nil || clause.NamedBindings.Kind != ast.KindNamedImports {
		return MigrationItem{}, false
	}
	isWholeTypeOnly := clause.PhaseModifier == ast.KindTypeKeyword
	var kept []*ast.ImportSpecifier
	removed := false
	for _, specNode := range clause.NamedBindings.AsNamedImports().Elements.Nodes {
		spec := specNode.AsImportSpecifier()
		localName := spec.Name().Text()
		if (isWholeTypeOnly || spec.IsTypeOnly) && spec.PropertyName == nil && satisfiedLocalValues[localName] {
			removed = true
			continue
		}
		kept = append(kept, spec)
	}
	if !removed {
		return MigrationItem{}, false
	}
	orig := nodeSourceText(file, stmt)
	if len(kept) == 0 && clause.Name() == nil {
		edit := deleteStatementEdit(file, stmt, "Remove redundant type-only resultar/async import")
		return makeMigrationItem(
			file, stmt, MigrationEdit, "async-subpath-import",
			orig, "",
			"Remove redundant type-only `resultar/async` import already covered by value import.",
			[]TextEdit{edit},
		), true
	}
	quote, semi := detectImportStyle(file, stmt)
	formatted := make([]string, 0, len(kept))
	for _, spec := range kept {
		formatted = append(formatted, formatImportSpecifier(file, spec, !isWholeTypeOnly))
	}
	kw := "import"
	if isWholeTypeOnly {
		kw = "import type"
	}
	repl := fmt.Sprintf("%s { %s } from %sresultar/async%s%s", kw, strings.Join(formatted, ", "), quote, quote, semi)
	edit := replaceSpanFix(file, stmt, stmt, "Remove redundant type-only specifiers", repl).Edits[0]
	return makeMigrationItem(
		file, stmt, MigrationEdit, "async-subpath-import",
		orig, repl,
		"Remove redundant type-only specifier(s) from `resultar/async`.",
		[]TextEdit{edit},
	), true
}

func addSpecifiersToImport(file *ast.SourceFile, stmt *ast.Node, needs []asyncSpecifierNeed) (TextEdit, string, string, bool) {
	decl := stmt.AsImportDeclaration()
	if decl.ImportClause == nil {
		return TextEdit{}, "", "", false
	}
	clause := decl.ImportClause.AsImportClause()
	if clause.NamedBindings == nil || clause.NamedBindings.Kind != ast.KindNamedImports {
		return TextEdit{}, "", "", false
	}
	quote, semi := detectImportStyle(file, stmt)
	existing := clause.NamedBindings.AsNamedImports().Elements.Nodes
	needMap := make(map[string]asyncSpecifierNeed, len(needs))
	for _, n := range needs {
		needMap[n.exportedName] = n
	}
	formatted := make([]string, 0, len(existing)+len(needs))
	isWholeTypeOnly := clause.PhaseModifier == ast.KindTypeKeyword
	for _, specNode := range existing {
		spec := specNode.AsImportSpecifier()
		localName := spec.Name().Text()
		if need, ok := needMap[localName]; ok && (isWholeTypeOnly || spec.IsTypeOnly) && spec.PropertyName == nil && need.localName == localName {
			// Promote existing unaliased type-only specifier to a value import.
			formatted = append(formatted, localName)
			delete(needMap, localName)
			continue
		}
		if isWholeTypeOnly {
			formatted = append(formatted, "type "+formatImportSpecifier(file, spec, false))
		} else {
			formatted = append(formatted, formatImportSpecifier(file, spec, true))
		}
	}
	var remaining []asyncSpecifierNeed
	for _, n := range needMap {
		remaining = append(remaining, n)
	}
	sort.Slice(remaining, func(i, j int) bool {
		return remaining[i].exportedName < remaining[j].exportedName
	})
	for _, n := range remaining {
		formatted = append(formatted, n.format())
	}
	replacement := fmt.Sprintf("import { %s } from %sresultar/async%s%s", strings.Join(formatted, ", "), quote, quote, semi)
	orig := nodeSourceText(file, stmt)
	edit := replaceSpanFix(file, stmt, stmt, "Add resultar/async imports", replacement).Edits[0]
	return edit, orig, replacement, true
}

// hasConflictingRequestBinding reports whether file declares or references `targetName`
// from any binding other than an unaliased import of `targetName` from `moduleName`.
// When true, renaming `requestJson*Task` to `targetName` in place would either collide at
// module scope (TS2440) or be silently captured by an inner local binding (e.g. a local
// `const requestJson = ...`), so the import must preserve the local name via an alias.
func (a *Analyzer) hasConflictingRequestBinding(file *ast.SourceFile, moduleName, targetName string) bool {
	isSameModuleDirectImport := func(specNode *ast.Node) bool {
		if specNode == nil || specNode.Kind != ast.KindImportSpecifier {
			return false
		}
		spec := specNode.AsImportSpecifier()
		if spec.PropertyName != nil || spec.Name() == nil || spec.Name().Text() != targetName {
			return false
		}
		impDecl := importDeclOfSpecifier(specNode)
		if impDecl == nil || impDecl.AsImportDeclaration().ModuleSpecifier == nil ||
			impDecl.AsImportDeclaration().ModuleSpecifier.Kind != ast.KindStringLiteral {
			return false
		}
		return impDecl.AsImportDeclaration().ModuleSpecifier.Text() == moduleName
	}

	conflict := false
	visit(file.AsNode(), func(node *ast.Node) {
		if conflict || node == nil {
			return
		}
		switch node.Kind {
		case ast.KindVariableDeclaration, ast.KindBindingElement, ast.KindParameter,
			ast.KindFunctionDeclaration, ast.KindFunctionExpression,
			ast.KindClassDeclaration, ast.KindClassExpression,
			ast.KindInterfaceDeclaration, ast.KindTypeAliasDeclaration,
			ast.KindEnumDeclaration, ast.KindModuleDeclaration,
			ast.KindTypeParameter, ast.KindImportEqualsDeclaration,
			ast.KindNamespaceImport, ast.KindImportClause:
			if name := node.Name(); name != nil && name.Kind == ast.KindIdentifier && name.Text() == targetName {
				conflict = true
			}
		case ast.KindImportSpecifier:
			spec := node.AsImportSpecifier()
			if spec.Name() != nil && spec.Name().Text() == targetName && !isSameModuleDirectImport(node) {
				conflict = true
			}
		case ast.KindIdentifier:
			if node.Text() != targetName || isDeclarationIdentifier(node) {
				return
			}
			if node.Parent != nil {
				switch node.Parent.Kind {
				case ast.KindImportSpecifier, ast.KindPropertySignature, ast.KindPropertyDeclaration, ast.KindMethodDeclaration, ast.KindMethodSignature:
					if node.Parent.Name() == node {
						return
					}
				case ast.KindPropertyAccessExpression, ast.KindPropertyAssignment:
					if node.Parent.Name() == node {
						return
					}
				case ast.KindQualifiedName:
					if node.Parent.AsQualifiedName().Right == node {
						return
					}
				}
			}
			// Check whether an existing reference (such as an ambient global `requestJson`) resolves
			// to something other than `targetName` imported from `moduleName`.
			refSym := a.checker.GetSymbolAtLocation(node)
			if node.Parent != nil && node.Parent.Kind == ast.KindShorthandPropertyAssignment && node.Parent.Name() == node {
				refSym = a.checker.GetShorthandAssignmentValueSymbol(node.Parent)
			}
			if refSym == nil {
				return
			}
			for _, d := range refSym.Declarations() {
				if isSameModuleDirectImport(d) {
					return
				}
			}
			conflict = true
		}
	})
	return conflict
}

// isLocallyReexported reports whether `localName` is re-exported by a local `export { ... }`
// declaration in file (e.g. `export { requestJsonTask }` or `export { requestJsonTask as foo }`).
// Preserving the local binding via `import { requestJson as requestJsonTask }` keeps the module's
// public export contract intact and prevents breaking `export { requestJsonTask }` with TS2552.
func isLocallyReexported(file *ast.SourceFile, localName string) bool {
	for _, stmt := range file.Statements.Nodes {
		if stmt.Kind != ast.KindExportDeclaration {
			continue
		}
		expDecl := stmt.AsExportDeclaration()
		if expDecl.ModuleSpecifier != nil || expDecl.ExportClause == nil || expDecl.ExportClause.Kind != ast.KindNamedExports {
			continue
		}
		for _, specNode := range expDecl.ExportClause.AsNamedExports().Elements.Nodes {
			expSpec := specNode.AsExportSpecifier()
			localIdent := expSpec.Name()
			if expSpec.PropertyName != nil {
				localIdent = expSpec.PropertyName
			}
			if localIdent != nil && localIdent.Kind == ast.KindIdentifier && localIdent.Text() == localName {
				return true
			}
		}
	}
	return false
}

func migrateCoreExportDecl(file *ast.SourceFile, stmt *ast.Node) []MigrationItem {
	expDecl := stmt.AsExportDeclaration()
	if expDecl.ModuleSpecifier == nil || expDecl.ModuleSpecifier.Kind != ast.KindStringLiteral {
		return nil
	}
	moduleName := expDecl.ModuleSpecifier.Text()
	// Wildcard or namespace re-export (`export * from "resultar"` / `export * as R from "resultar"`):
	// v5 removed eager ResultAsync exports and `try`/`tryCatch` from root `"resultar"`, so downstream
	// importers relying on those re-exported names will break. Flag for manual review.
	if expDecl.ExportClause == nil || expDecl.ExportClause.Kind == ast.KindNamespaceExport {
		return []MigrationItem{makeMigrationItem(
			file, stmt, MigrationReview, "core-star-reexport",
			nodeSourceText(file, stmt), "",
			fmt.Sprintf("Wildcard re-export from `%s` no longer re-exports eager `ResultAsync` APIs (`ResultAsync`, `okAsync`, `errAsync`, `safeTry`, etc.) or `try`/`tryCatch` in v5; add explicit re-exports from `resultar/async` if downstream consumers depend on them.", moduleName),
			nil,
		)}
	}
	if expDecl.ExportClause.Kind != ast.KindNamedExports {
		return nil
	}
	quote, semi := detectImportStyle(file, stmt)
	isWholeTypeOnly := expDecl.IsTypeOnly

	var coreSpecs []*ast.ExportSpecifier
	var asyncSpecs []*ast.ExportSpecifier
	items := make([]MigrationItem, 0)

	for _, specNode := range expDecl.ExportClause.AsNamedExports().Elements.Nodes {
		spec := specNode.AsExportSpecifier()
		sourceName := spec.Name().Text()
		if spec.PropertyName != nil {
			sourceName = spec.PropertyName.Text()
		}
		if reason, removed := removedCoreImports[sourceName]; removed {
			items = append(items, makeMigrationItem(
				file, specNode, MigrationReview, "removed-v4-import",
				nodeSourceText(file, specNode), "", reason, nil,
			))
			coreSpecs = append(coreSpecs, spec)
			continue
		}
		if eagerMovedToAsyncSubpath[sourceName] {
			asyncSpecs = append(asyncSpecs, spec)
			continue
		}
		coreSpecs = append(coreSpecs, spec)
	}
	if len(asyncSpecs) == 0 {
		return items
	}
	exportKeyword := "export"
	if isWholeTypeOnly {
		exportKeyword = "export type"
	}
	asyncFormatted := make([]string, 0, len(asyncSpecs))
	for _, spec := range asyncSpecs {
		asyncFormatted = append(asyncFormatted, formatExportSpecifier(file, spec, !isWholeTypeOnly))
	}
	asyncLine := fmt.Sprintf("%s { %s } from %sresultar/async%s%s", exportKeyword, strings.Join(asyncFormatted, ", "), quote, quote, semi)

	var replacement string
	if len(coreSpecs) == 0 {
		replacement = asyncLine
	} else {
		coreFormatted := make([]string, 0, len(coreSpecs))
		for _, spec := range coreSpecs {
			coreFormatted = append(coreFormatted, formatExportSpecifier(file, spec, !isWholeTypeOnly))
		}
		coreLine := fmt.Sprintf("%s { %s } from %s%s%s%s", exportKeyword, strings.Join(coreFormatted, ", "), quote, moduleName, quote, semi)
		replacement = coreLine + "\n" + asyncLine
	}
	orig := nodeSourceText(file, stmt)
	edit := replaceSpanFix(file, stmt, stmt, "Move eager ResultAsync re-exports to resultar/async", replacement).Edits[0]
	items = append(items, makeMigrationItem(
		file, stmt, MigrationEdit, "async-subpath-import",
		orig, replacement,
		"Move eager `ResultAsync` re-exports from `"+moduleName+"` to `resultar/async`.",
		[]TextEdit{edit},
	))
	return items
}

func migrateRequestExportDecl(file *ast.SourceFile, stmt *ast.Node) []MigrationItem {
	expDecl := stmt.AsExportDeclaration()
	if expDecl.ModuleSpecifier == nil || expDecl.ModuleSpecifier.Kind != ast.KindStringLiteral {
		return nil
	}
	moduleName := expDecl.ModuleSpecifier.Text()
	// Wildcard or namespace re-export (`export * from "resultar-request"` / `export * as Req from "resultar-request"`):
	// v5 removed `requestJson*Task` / `RequestJson*Task*` and switched `requestJson*` to lazy `ResultTask`,
	// so downstream importers of `*Task` symbols will fail with TS2724. Flag for manual review!
	if expDecl.ExportClause == nil || expDecl.ExportClause.Kind == ast.KindNamespaceExport {
		return []MigrationItem{makeMigrationItem(
			file, stmt, MigrationReview, "request-star-reexport",
			nodeSourceText(file, stmt), "",
			fmt.Sprintf("Wildcard re-export from `%s` drops removed v4 `*Task` symbols (`requestJson*Task`, `RequestJson*Task*`) and switches `requestJson*` from eager `ResultAsync` to lazy `ResultTask` in v5; downstream importers of `*Task` symbols will fail with TS2724. Add explicit compatibility aliases (e.g. `export { requestJson as requestJsonTask } from \"%s\"`) or update consumers.", moduleName, moduleName),
			nil,
		)}
	}
	if expDecl.ExportClause.Kind != ast.KindNamedExports {
		return nil
	}
	quote, semi := detectImportStyle(file, stmt)
	isWholeTypeOnly := expDecl.IsTypeOnly

	specNodes := expDecl.ExportClause.AsNamedExports().Elements.Nodes
	formatted := make([]string, 0, len(specNodes))
	changed := false
	for _, specNode := range specNodes {
		spec := specNode.AsExportSpecifier()
		exportedRaw := formatModuleExportName(file, spec.Name())
		isStringExported := spec.Name().Kind == ast.KindStringLiteral
		sourceName := spec.Name().Text()
		if spec.PropertyName != nil {
			sourceName = spec.PropertyName.Text()
		}
		if newName, ok := requestTaskRenames[sourceName]; ok {
			changed = true
			entry := newName + " as " + exportedRaw
			if !isStringExported && newName == exportedRaw {
				entry = newName
			}
			if !isWholeTypeOnly && spec.IsTypeOnly {
				entry = "type " + entry
			}
			formatted = append(formatted, entry)
			continue
		}
		formatted = append(formatted, formatExportSpecifier(file, spec, !isWholeTypeOnly))
	}
	if !changed {
		return nil
	}
	exportKeyword := "export"
	if isWholeTypeOnly {
		exportKeyword = "export type"
	}
	replacement := fmt.Sprintf("%s { %s } from %s%s%s%s", exportKeyword, strings.Join(formatted, ", "), quote, moduleName, quote, semi)
	orig := nodeSourceText(file, stmt)
	edit := replaceSpanFix(file, stmt, stmt, "Preserve requestJson*Task re-export via canonical v5 name", replacement).Edits[0]
	return []MigrationItem{makeMigrationItem(
		file, stmt, MigrationEdit, "request-task-rename",
		orig, replacement,
		"Re-export canonical v5 Task-native symbol while preserving the existing public export name.",
		[]TextEdit{edit},
	)}
}

func (a *Analyzer) migrateRequestImport(file *ast.SourceFile, stmt *ast.Node, state *fileMigrationState) []MigrationItem {
	decl := stmt.AsImportDeclaration()
	if decl.ImportClause == nil {
		return nil
	}
	clause := decl.ImportClause.AsImportClause()
	if clause.NamedBindings == nil || clause.NamedBindings.Kind != ast.KindNamedImports {
		return nil
	}
	quote, semi := detectImportStyle(file, stmt)
	moduleName := decl.ModuleSpecifier.Text()
	isWholeTypeOnly := clause.PhaseModifier == ast.KindTypeKeyword

	specNodes := clause.NamedBindings.AsNamedImports().Elements.Nodes
	seen := make(map[string]bool, len(specNodes))
	formatted := make([]string, 0, len(specNodes))
	changed := false

	for _, specNode := range specNodes {
		spec := specNode.AsImportSpecifier()
		localName := spec.Name().Text()
		importedName := localName
		if spec.PropertyName != nil {
			importedName = spec.PropertyName.Text()
		}
		if newName, ok := requestTaskRenames[importedName]; ok {
			changed = true
			keepLocalAlias := spec.PropertyName != nil || isLocallyReexported(file, localName) || a.hasConflictingRequestBinding(file, moduleName, newName)
			if keepLocalAlias {
				entry := newName + " as " + localName
				if !isWholeTypeOnly && spec.IsTypeOnly {
					entry = "type " + entry
				}
				if !seen[entry] {
					seen[entry] = true
					formatted = append(formatted, entry)
				}
			} else {
				if sym := a.checker.GetSymbolAtLocation(spec.Name()); sym != nil {
					state.requestRenamedSyms[sym] = newName
				}
				entry := newName
				if !isWholeTypeOnly && spec.IsTypeOnly {
					entry = "type " + entry
				}
				if !seen[entry] {
					seen[entry] = true
					formatted = append(formatted, entry)
				}
			}
			continue
		}
		entry := formatImportSpecifier(file, spec, !isWholeTypeOnly)
		if !seen[entry] {
			seen[entry] = true
			formatted = append(formatted, entry)
		}
	}

	if !changed {
		return nil
	}
	importKeyword := "import"
	if isWholeTypeOnly {
		importKeyword = "import type"
	}
	replacement := fmt.Sprintf("%s { %s } from %s%s%s%s", importKeyword, strings.Join(formatted, ", "), quote, moduleName, quote, semi)
	orig := nodeSourceText(file, stmt)
	edit := replaceSpanFix(file, stmt, stmt, "Rename requestJson*Task imports to canonical v5 names", replacement).Edits[0]
	return []MigrationItem{makeMigrationItem(
		file, stmt, MigrationEdit, "request-task-rename",
		orig, replacement,
		"Rename `requestJson*Task` imports to canonical v5 Task-native symbols.",
		[]TextEdit{edit},
	)}
}

func (a *Analyzer) migrateCallV5(file *ast.SourceFile, node *ast.Node, state *fileMigrationState, consumed map[*ast.Node]bool) []MigrationItem {
	call := node.AsCallExpression()
	callee := unwrapExpression(call.Expression)
	if callee == nil {
		return nil
	}
	items := make([]MigrationItem, 0)

	// 1. Direct or namespace calls to requestJson / requestJsonZod / requestJsonTypeBox (v4 eager contract)
	if pkgGroup, exportName, ok := a.resolvePackageExport(callee); ok {
		if (pkgGroup == "request" || pkgGroup == "app") &&
			(exportName == "requestJson" || exportName == "requestJsonZod" || exportName == "requestJsonTypeBox") {
			if review := a.checkEagerRequestJsonCall(file, node, call.Arguments.Nodes); review != nil {
				items = append(items, *review)
			}
			return items
		}
		if (pkgGroup == "core" || pkgGroup == "app") && exportName == "safeTry" {
			items = append(items, makeMigrationItem(
				file, node, MigrationReview, "deprecated-safe-try",
				nodeSourceText(file, node), "",
				"`safeTry` moved to `@deprecated` `resultar/async` in v5 (retaining its returned-Result contract); consider migrating to `Result.gen` (sync) or `ResultTask.gen` (lazy async).",
				nil,
			))
			return items
		}
	}

	if callee.Kind != ast.KindPropertyAccessExpression {
		return items
	}
	propAccess := callee.AsPropertyAccessExpression()
	receiver := unwrapExpression(propAccess.Expression)
	methodNode := propAccess.Name()
	if receiver == nil || methodNode == nil {
		return items
	}
	method := methodNode.Text()

	// 2. Check chained call on `<task>.runResult(...)` or `ResultTask.runResult(...)`
	if receiver.Kind == ast.KindCallExpression && a.isRunResultCall(receiver) {
		consumed[receiver] = true
		if item, ok := a.migrateRunResultChain(file, node, receiver, method, call.Arguments.Nodes, state); ok {
			items = append(items, item)
			return items
		}
	}

	// 2b. Check bare `<task>.runResult(...)` / `ResultTask.runResult(...)` escaping into a ResultAsync / StrictResultAsync contract
	if a.isRunResultCall(node) {
		if a.runResultExpectsResultAsync(file, node) {
			asyncName := state.useAsyncValue("ResultAsync")
			nodeText := strings.TrimSpace(nodeSourceText(file, node))
			replacement := fmt.Sprintf("new %s(%s)", asyncName, nodeText)
			edit := replaceSpanFix(file, node, node, "Wrap runResult() in new "+asyncName+"(...) to preserve ResultAsync contract", replacement).Edits[0]
			items = append(items, makeMigrationItem(
				file, node, MigrationEdit, "run-result-async-contract",
				nodeText, replacement,
				fmt.Sprintf("`runResult()` returns a native `Promise<Result<...>>` in v5; wrap with `new %s(%s)` (from `resultar/async`) to preserve the `ResultAsync` / `StrictResultAsync` contract.", asyncName, nodeText),
				[]TextEdit{edit},
			))
			return items
		}
		if a.isExportedUnannotatedRunResultReturn(file, node) {
			callType := a.checker.GetTypeAtLocation(node)
			if isResultAsyncLikeType(callType) {
				items = append(items, makeMigrationItem(
					file, node, MigrationReview, "run-result-exported-contract",
					nodeSourceText(file, node), "",
					"This exported function or method returns bare `runResult()` without an explicit return annotation; in v5 its inferred return type changes from `ResultAsync` to `Promise<Result>`. Keep as a native Promise boundary or wrap with `new ResultAsync(...)` from `resultar/async` if callers chain fluent `ResultAsync` methods.",
					nil,
				))
				return items
			}
		}
	}

	// 3. Static calls resolved via TypeScript symbol to Resultar's ResultTask / Result / ResultAsync
	if pkgGroup, exportName, ok := a.resolvePackageExport(receiver); ok && (pkgGroup == "core" || pkgGroup == "async" || pkgGroup == "app") {
		switch exportName {
		case "ResultTask":
			if replacement, isAlias := deprecatedResultTaskAliases[method]; isAlias {
				edit := renameFix(file, methodNode, "Rename ResultTask."+method+" to ResultTask."+replacement, replacement).Edits[0]
				items = append(items, makeMigrationItem(
					file, methodNode, MigrationEdit, "result-task-alias",
					"ResultTask."+method, "ResultTask."+replacement,
					fmt.Sprintf("Replace deprecated `ResultTask.%s` alias with canonical `ResultTask.%s`.", method, replacement),
					[]TextEdit{edit},
				))
				return items
			}
			if method == "toResultAsync" && len(call.Arguments.Nodes) == 1 && call.Arguments.Nodes[0].Kind != ast.KindSpreadElement {
				a.markReplacedCoreReceiver(receiver, state)
				asyncName := state.useAsyncValue("ResultAsync")
				argsText := joinNodesText(file, call.Arguments.Nodes)
				replacement := fmt.Sprintf("%s.fromTask(%s)", asyncName, argsText)
				edit := replaceSpanFix(file, node, node, "Replace ResultTask.toResultAsync with "+asyncName+".fromTask", replacement).Edits[0]
				items = append(items, makeMigrationItem(
					file, node, MigrationEdit, "to-result-async",
					nodeSourceText(file, node), replacement,
					fmt.Sprintf("Replace `ResultTask.toResultAsync(task)` with `%s.fromTask(task)` from `resultar/async`.", asyncName),
					[]TextEdit{edit},
				))
				return items
			}
		case "Result":
			if replacement, isAlias := deprecatedResultStaticAliases[method]; isAlias {
				edit := renameFix(file, methodNode, "Rename Result."+method+" to Result."+replacement, replacement).Edits[0]
				items = append(items, makeMigrationItem(
					file, methodNode, MigrationEdit, "result-static-alias",
					"Result."+method, "Result."+replacement,
					fmt.Sprintf("Replace removed `Result.%s` alias with `Result.%s`.", method, replacement),
					[]TextEdit{edit},
				))
				return items
			}
			if (method == "gen" || method == "fn") && len(call.Arguments.Nodes) > 0 && a.isAsyncResultGenOrFnCall(node, method, call.Arguments.Nodes[0]) {
				a.markReplacedCoreReceiver(receiver, state)
				asyncName := state.useAsyncValue("ResultAsync")
				edit := replaceSpanFix(file, receiver, receiver, "Replace Result."+method+" with "+asyncName+"."+method, asyncName).Edits[0]
				items = append(items, makeMigrationItem(
					file, callee, MigrationEdit, "result-async-gen",
					"Result."+method, asyncName+"."+method,
					fmt.Sprintf("`Result.%s` is sync-only in v5; move async generator to `%s.%s` (from `resultar/async`) or migrate to `ResultTask.%s`.", method, asyncName, method, method),
					[]TextEdit{edit},
				))
				return items
			}
			if method == "asyncMap" || method == "asyncAndThen" {
				a.markReplacedCoreReceiver(receiver, state)
				helperName := state.useAsyncValue(method)
				edit := replaceSpanFix(file, receiver, methodNode, "Use standalone "+helperName+" from resultar/async", helperName).Edits[0]
				items = append(items, makeMigrationItem(
					file, callee, MigrationEdit, "result-async-helper",
					"Result."+method, helperName,
					fmt.Sprintf("`Result.%s` moved to standalone `%s` in `resultar/async`.", method, helperName),
					[]TextEdit{edit},
				))
				return items
			}
		case "ResultAsync":
			if target, deprecated := deprecatedResultAsyncStatics[method]; deprecated {
				items = append(items, makeMigrationItem(
					file, node, MigrationReview, "deprecated-result-async-helper",
					nodeSourceText(file, callee), target,
					fmt.Sprintf("`ResultAsync.%s` remains `@deprecated` in `resultar/async` during v5.x; consider migrating this workflow to `%s`.", method, target),
					nil,
				))
				return items
			}
		}
	}

	// 4. Instance & class calls resolved via TypeScript type checker (verified to be Resultar types)
	receiverType := a.checker.GetTypeAtLocation(receiver)

	// 4a. TaggedErrorClass.errAsync(...)
	if method == "errAsync" {
		callType := a.checker.GetTypeAtLocation(node)
		if isResultAsyncLikeType(callType) && a.isResultarDeclaredType(callType) {
			recvText := strings.TrimSpace(nodeSourceText(file, receiver))
			items = append(items, makeMigrationItem(
				file, node, MigrationReview, "removed-tagged-err-async",
				nodeSourceText(file, node), "",
				"`.errAsync(...)` on tagged errors was removed in v5; use `"+recvText+".taskErr(...)` or `errAsync(new "+recvText+"(...))` from `resultar/async`.",
				nil,
			))
			return items
		}
	}

	// 4b. ResultTask instance aliases, toResultAsync, and legacy match keys
	if isResultTaskLikeType(receiverType) && a.isResultarDeclaredType(receiverType) {
		if replacement, ok := deprecatedResultTaskAliases[method]; ok && (method == "flatMap" || method == "mapError" || method == "catchAll") {
			edit := renameFix(file, methodNode, "Rename ."+method+" to ."+replacement, replacement).Edits[0]
			items = append(items, makeMigrationItem(
				file, methodNode, MigrationEdit, "result-task-alias",
				"."+method, "."+replacement,
				fmt.Sprintf("Replace deprecated `ResultTask#%s` alias with canonical `.%s`.", method, replacement),
				[]TextEdit{edit},
			))
			return items
		}
		if method == "toResultAsync" && len(call.Arguments.Nodes) == 0 {
			if ast.IsOptionalChain(node) {
				items = append(items, makeMigrationItem(
					file, node, MigrationReview, "to-result-async",
					nodeSourceText(file, node), "",
					"Optional-chained `task?.toResultAsync()` cannot be rewritten directly to `ResultAsync.fromTask(task)` without narrowing `task` first.",
					nil,
				))
				return items
			}
			asyncName := state.useAsyncValue("ResultAsync")
			recvText := strings.TrimSpace(nodeSourceText(file, receiver))
			replacement := fmt.Sprintf("%s.fromTask(%s)", asyncName, recvText)
			edit := replaceSpanFix(file, node, node, "Replace .toResultAsync() with "+asyncName+".fromTask(...)", replacement).Edits[0]
			items = append(items, makeMigrationItem(
				file, node, MigrationEdit, "to-result-async",
				nodeSourceText(file, node), replacement,
				fmt.Sprintf("Replace `task.toResultAsync()` with `%s.fromTask(task)` from `resultar/async`.", asyncName),
				[]TextEdit{edit},
			))
			return items
		}
		if method == "match" && len(call.Arguments.Nodes) == 1 {
			items = append(items, a.migrateLegacyMatchObject(file, call.Arguments.Nodes[0], true)...)
		}
		return items
	}

	// 4c. Sync Result instance methods removed in v5: asyncMap, asyncAndThen, safeUnwrap, tap, tapError, match({ ok, error })
	if a.isResultarSyncType(receiverType) && a.isResultarDeclaredType(receiverType) {
		if (method == "asyncMap" || method == "asyncAndThen") && len(call.Arguments.Nodes) == 1 {
			if ast.IsOptionalChain(node) {
				items = append(items, makeMigrationItem(
					file, node, MigrationReview, "result-async-helper",
					nodeSourceText(file, node), "",
					fmt.Sprintf("Optional-chained `result?.%s(...)` cannot be rewritten directly to `%s(result, fn)` without narrowing `result` first.", method, method),
					nil,
				))
				return items
			}
			helperName := state.useAsyncValue(method)
			recvText := strings.TrimSpace(nodeSourceText(file, receiver))
			argText := strings.TrimSpace(nodeSourceText(file, call.Arguments.Nodes[0]))
			replacement := fmt.Sprintf("%s(%s, %s)", helperName, recvText, argText)
			edit := replaceSpanFix(file, node, node, "Use standalone "+helperName+" from resultar/async", replacement).Edits[0]
			items = append(items, makeMigrationItem(
				file, node, MigrationEdit, "result-async-helper",
				nodeSourceText(file, node), replacement,
				fmt.Sprintf("`Result#%s` moved to standalone `%s(result, fn)` in `resultar/async` (or lift to `ResultTask`).", method, helperName),
				[]TextEdit{edit},
			))
			return items
		}
		if method == "safeUnwrap" && len(call.Arguments.Nodes) == 0 {
			recvText := strings.TrimSpace(nodeSourceText(file, receiver))
			edit := replaceSpanFix(file, node, node, "Remove .safeUnwrap() in favor of direct yield* result", recvText).Edits[0]
			items = append(items, makeMigrationItem(
				file, node, MigrationEdit, "removed-safe-unwrap",
				nodeSourceText(file, node), recvText,
				"`Result#safeUnwrap()` was removed in v5; yield the `Result` directly with `yield* result`.",
				[]TextEdit{edit},
			))
			return items
		}
		if method == "tap" || method == "tapError" {
			target := "inspect"
			if method == "tapError" {
				target = "inspectError"
			}
			items = append(items, makeMigrationItem(
				file, methodNode, MigrationReview, "removed-result-tap",
				"."+method, "."+target,
				fmt.Sprintf("`Result#%s` was removed in v5; use `.%s` (best-effort observer that swallows throws) or review error propagation.", method, target),
				nil,
			))
			return items
		}
		if method == "match" && len(call.Arguments.Nodes) == 1 {
			items = append(items, a.migrateLegacyMatchObject(file, call.Arguments.Nodes[0], false)...)
		}
		return items
	}

	// 4d. ResultAsync instance methods preserved as @deprecated in resultar/async
	if isResultAsyncLikeType(receiverType) && a.isResultarDeclaredType(receiverType) {
		if method == "tap" || method == "tapError" {
			target := "inspect"
			if method == "tapError" {
				target = "inspectError"
			}
			items = append(items, makeMigrationItem(
				file, methodNode, MigrationReview, "deprecated-result-async-tap",
				"."+method, "."+target,
				fmt.Sprintf("`ResultAsync#%s` remains `@deprecated` in `resultar/async` during v5.x; prefer `.%s` or migrate to `ResultTask#%s`.", method, target, method),
				nil,
			))
			return items
		}
		if method == "toAsyncDisposable" {
			items = append(items, makeMigrationItem(
				file, methodNode, MigrationReview, "deprecated-to-async-disposable",
				".toAsyncDisposable()", "",
				"`ResultAsync#toAsyncDisposable` remains `@deprecated` in `resultar/async` during v5.x; consider migrating to `ResultTask.acquireRelease` or `ResultTask.acquireDisposable` with `ResultTask.scoped`.",
				nil,
			))
			return items
		}
	}

	return items
}

// runResultExpectsResultAsync returns true when a bare `task.runResult(...)` expression
// flows into a context requiring a `ResultAsync` / `StrictResultAsync` contract (explicit
// return type, variable/assignment type, contextual parameter/property type, or downstream
// fluent `ResultAsync` method calls on a local binding).
func (a *Analyzer) runResultExpectsResultAsync(file *ast.SourceFile, callNode *ast.Node) bool {
	child := callNode
	parent := callNode.Parent
	for parent != nil && parent.Kind == ast.KindParenthesizedExpression {
		child = parent
		parent = parent.Parent
	}
	if parent == nil {
		return false
	}

	// Already wrapped in `new ResultAsync(task.runResult())` -> idempotent!
	if parent.Kind == ast.KindNewExpression {
		if isResultAsyncLikeType(a.checker.GetTypeAtLocation(parent)) {
			return false
		}
		newCallee := unwrapExpression(parent.AsNewExpression().Expression)
		if _, exportName, ok := a.resolvePackageExport(newCallee); ok && exportName == "ResultAsync" {
			return false
		}
		if newCallee != nil && newCallee.Kind == ast.KindPropertyAccessExpression &&
			newCallee.Name() != nil && newCallee.Name().Text() == "ResultAsync" {
			return false
		}
	}
	// Part of a property access chain (`task.runResult().then(...)`, etc.) -> handled elsewhere.
	if parent.Kind == ast.KindPropertyAccessExpression && parent.Expression() == child {
		return false
	}
	// Directly awaited -> native Promise<Result> works identically without ResultAsync wrapper.
	if parent.Kind == ast.KindAwaitExpression {
		return false
	}

	checkExpectedType := func(t *checker.Type) bool {
		if t == nil || !isResultAsyncLikeType(t) || !a.isResultarDeclaredType(t) {
			return false
		}
		// If the expected type is a union that already accepts a native Promise,
		// bare runResult() (Promise<Result>) satisfies it without wrapping.
		if t.Flags()&checker.TypeFlagsUnion != 0 {
			for _, part := range t.Types() {
				if isNativePromiseType(part) {
					return false
				}
			}
		}
		return true
	}

	checkFnContextualReturn := func(fn *ast.Node) bool {
		if fn == nil {
			return false
		}
		fnCtx := a.checker.GetContextualType(fn, checker.ContextFlagsNone)
		if fnCtx == nil {
			return false
		}
		for _, sig := range a.checker.GetCallSignatures(fnCtx) {
			if checkExpectedType(a.checker.GetReturnTypeOfSignature(sig)) {
				return true
			}
		}
		return false
	}

	switch parent.Kind {
	case ast.KindArrowFunction:
		if parent.Body() == child {
			if parent.Type() != nil {
				return checkExpectedType(a.checker.GetTypeAtLocation(parent.Type()))
			}
			if checkExpectedType(a.checker.GetContextualType(child, checker.ContextFlagsNone)) {
				return true
			}
			if checkFnContextualReturn(parent) {
				return true
			}
			if a.memberContractExpectsResultAsync(file, parent, checkExpectedType) {
				return true
			}
			return a.unannotatedHelperUsedAsResultAsync(file, parent)
		}
	case ast.KindReturnStatement:
		for anc := parent.Parent; anc != nil; anc = anc.Parent {
			if isFunctionLikeNode(anc) {
				if anc.Type() != nil {
					return checkExpectedType(a.checker.GetTypeAtLocation(anc.Type()))
				}
				if checkExpectedType(a.checker.GetContextualType(child, checker.ContextFlagsNone)) {
					return true
				}
				if checkFnContextualReturn(anc) {
					return true
				}
				if a.memberContractExpectsResultAsync(file, anc, checkExpectedType) {
					return true
				}
				return a.unannotatedHelperUsedAsResultAsync(file, anc)
			}
		}
	case ast.KindVariableDeclaration:
		if parent.Initializer() == child {
			if parent.Type() != nil {
				return checkExpectedType(a.checker.GetTypeAtLocation(parent.Type()))
			}
			// Check whether downstream references to this local variable call fluent ResultAsync methods
			// or pass it into a ResultAsync-typed target.
			if name := parent.Name(); name != nil && name.Kind == ast.KindIdentifier {
				return a.variableUsedAsResultAsync(file, parent, name)
			}
		}
	case ast.KindBinaryExpression:
		bin := parent.AsBinaryExpression()
		if bin.OperatorToken != nil && bin.OperatorToken.Kind == ast.KindEqualsToken && bin.Right == child {
			return checkExpectedType(a.checker.GetTypeAtLocation(bin.Left))
		}
	case ast.KindSatisfiesExpression, ast.KindAsExpression:
		return checkExpectedType(a.checker.GetTypeAtLocation(parent.Type()))
	}

	return checkExpectedType(a.checker.GetContextualType(child, checker.ContextFlagsNone))
}

func (a *Analyzer) variableUsedAsResultAsync(file *ast.SourceFile, declNode *ast.Node, nameNode *ast.Node) bool {
	varSym := a.checker.GetSymbolAtLocation(nameNode)
	if varSym == nil {
		return false
	}
	searchRoot := file.AsNode()
	for cur := declNode.Parent; cur != nil; cur = cur.Parent {
		if isFunctionLikeNode(cur) {
			searchRoot = cur
			break
		}
	}
	found := false
	visit(searchRoot, func(ref *ast.Node) {
		if found || ref == nil || ref.Kind != ast.KindIdentifier || ref == nameNode || isDeclarationIdentifier(ref) {
			return
		}
		refSym := a.checker.GetSymbolAtLocation(ref)
		if ref.Parent != nil && ref.Parent.Kind == ast.KindShorthandPropertyAssignment && ref.Parent.Name() == ref {
			refSym = a.checker.GetShorthandAssignmentValueSymbol(ref.Parent)
		}
		if refSym != varSym {
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
		if parent.Kind == ast.KindPropertyAccessExpression && parent.Expression() == child && parent.Name() != nil {
			if resultAsyncOnlyVarMethods[parent.Name().Text()] {
				found = true
				return
			}
		}
		if ctxType := a.checker.GetContextualType(child, checker.ContextFlagsNone); ctxType != nil && isResultAsyncLikeType(ctxType) && a.isResultarDeclaredType(ctxType) {
			found = true
		}
	})
	return found
}

// memberContractExpectsResultAsync checks whether an unannotated class method, class arrow/function
// property, or object-literal method/property fulfills a `ResultAsync` / `StrictResultAsync` return
// contract declared by an `implements` interface, `extends` base class, explicit property type,
// structural `new ClassName()` target type, or contextual object-literal type.
func (a *Analyzer) memberContractExpectsResultAsync(
	file *ast.SourceFile,
	fn *ast.Node,
	checkExpectedType func(*checker.Type) bool,
) bool {
	if fn == nil || fn.Type() != nil || ast.HasSyntacticModifier(fn, ast.ModifierFlagsAsync) {
		return false
	}

	var typeMemberReturnsResultAsync func(containerType *checker.Type, memberName string, loc *ast.Node, depth int) bool
	typeMemberReturnsResultAsync = func(containerType *checker.Type, memberName string, loc *ast.Node, depth int) bool {
		if containerType == nil || depth > 8 {
			return false
		}
		if containerType.Flags()&checker.TypeFlagsUnionOrIntersection != 0 {
			for _, part := range containerType.Types() {
				if typeMemberReturnsResultAsync(part, memberName, loc, depth+1) {
					return true
				}
			}
			return false
		}
		propSym := a.checker.GetPropertyOfType(containerType, memberName)
		if propSym == nil {
			return false
		}
		propType := a.checker.GetTypeOfSymbolAtLocation(propSym, loc)
		if propType == nil {
			return false
		}
		for _, sig := range a.checker.GetSignaturesOfType(propType, checker.SignatureKindCall) {
			if checkExpectedType(a.checker.GetReturnTypeOfSignature(sig)) {
				return true
			}
		}
		return false
	}

	expectedTypeOfExpr := func(expr *ast.Node) *checker.Type {
		child := expr
		parent := expr.Parent
		for parent != nil && parent.Kind == ast.KindParenthesizedExpression {
			child = parent
			parent = parent.Parent
		}
		if parent != nil {
			switch parent.Kind {
			case ast.KindVariableDeclaration:
				if parent.Initializer() == child && parent.Type() != nil {
					return a.checker.GetTypeAtLocation(parent.Type())
				}
			case ast.KindBinaryExpression:
				bin := parent.AsBinaryExpression()
				if bin.OperatorToken != nil && bin.OperatorToken.Kind == ast.KindEqualsToken && bin.Right == child {
					return a.checker.GetTypeAtLocation(bin.Left)
				}
			case ast.KindSatisfiesExpression, ast.KindAsExpression:
				if parent.Type() != nil {
					return a.checker.GetTypeAtLocation(parent.Type())
				}
			case ast.KindReturnStatement:
				for anc := parent.Parent; anc != nil; anc = anc.Parent {
					if isFunctionLikeNode(anc) {
						if anc.Type() != nil {
							return a.checker.GetTypeAtLocation(anc.Type())
						}
						break
					}
				}
			case ast.KindArrowFunction:
				if parent.Body() == child && parent.Type() != nil {
					return a.checker.GetTypeAtLocation(parent.Type())
				}
			}
		}
		return a.checker.GetContextualType(child, checker.ContextFlagsNone)
	}

	// Determine member node, member name, and owning class or object literal.
	var memberNode *ast.Node
	var container *ast.Node
	switch fn.Kind {
	case ast.KindMethodDeclaration:
		memberNode = fn
		container = fn.Parent
	case ast.KindArrowFunction, ast.KindFunctionExpression:
		if fn.Parent != nil && (fn.Parent.Kind == ast.KindPropertyDeclaration || fn.Parent.Kind == ast.KindPropertyAssignment) && fn.Parent.Initializer() == fn {
			memberNode = fn.Parent
			container = fn.Parent.Parent
		}
	}
	if memberNode == nil || container == nil {
		return false
	}

	// Explicit type annotation on a class property field (`fetchPrice: () => StrictResultAsync<...> = () => task.runResult()`).
	if memberNode.Kind == ast.KindPropertyDeclaration && memberNode.Type() != nil {
		propType := a.checker.GetTypeAtLocation(memberNode.Type())
		for _, sig := range a.checker.GetSignaturesOfType(propType, checker.SignatureKindCall) {
			if checkExpectedType(a.checker.GetReturnTypeOfSignature(sig)) {
				return true
			}
		}
	}

	memberName, ok := staticPropertyNameText(memberNode.Name())
	if !ok || memberName == "" {
		return false
	}

	// 1. Object literal method/property implementing an expected interface type (`const svc: PricePort = { fetchPrice() { return task.runResult() } }`).
	if container.Kind == ast.KindObjectLiteralExpression {
		if targetType := expectedTypeOfExpr(container); targetType != nil {
			if typeMemberReturnsResultAsync(targetType, memberName, memberNode, 0) {
				return true
			}
		}
		return false
	}

	// 2. Class method/property implementing an interface (`implements PricePort`) or extending a base class (`extends BasePriceService`).
	if container.Kind != ast.KindClassDeclaration && container.Kind != ast.KindClassExpression {
		return false
	}
	isStatic := ast.HasSyntacticModifier(memberNode, ast.ModifierFlagsStatic)
	if heritage := container.ClassLikeData().HeritageClauses; heritage != nil {
		for _, clauseNode := range heritage.Nodes {
			if clauseNode == nil || clauseNode.Kind != ast.KindHeritageClause {
				continue
			}
			hc := clauseNode.AsHeritageClause()
			if hc.Types == nil {
				continue
			}
			if hc.Token == ast.KindImplementsKeyword {
				if isStatic {
					continue
				}
				for _, typeNode := range hc.Types.Nodes {
					if typeNode == nil {
						continue
					}
					if baseType := a.checker.GetTypeFromTypeNode(typeNode); baseType != nil {
						if typeMemberReturnsResultAsync(baseType, memberName, memberNode, 0) {
							return true
						}
					}
				}
			} else if hc.Token == ast.KindExtendsKeyword {
				for _, typeNode := range hc.Types.Nodes {
					if typeNode == nil {
						continue
					}
					if isStatic {
						if expr := typeNode.Expression(); expr != nil {
							if ctorType := a.checker.GetTypeAtLocation(expr); ctorType != nil {
								if typeMemberReturnsResultAsync(ctorType, memberName, memberNode, 0) {
									return true
								}
							}
						}
						continue
					}
					if baseType := a.checker.GetTypeFromTypeNode(typeNode); baseType != nil {
						if typeMemberReturnsResultAsync(baseType, memberName, memberNode, 0) {
							return true
						}
					}
					if expr := typeNode.Expression(); expr != nil {
						if ctorType := a.checker.GetTypeAtLocation(expr); ctorType != nil {
							for _, ctorSig := range a.checker.GetSignaturesOfType(ctorType, checker.SignatureKindConstruct) {
								if instType := a.checker.GetReturnTypeOfSignature(ctorSig); instType != nil {
									if typeMemberReturnsResultAsync(instType, memberName, memberNode, 0) {
										return true
									}
								}
							}
						}
					}
				}
			}
		}
	}

	// 3. Structural interface typing without `implements`: e.g. `const service: PricePort = new PriceService()`.
	if !isStatic {
		var classIdent *ast.Node
		if name := container.Name(); name != nil && name.Kind == ast.KindIdentifier {
			classIdent = name
		} else if container.Kind == ast.KindClassExpression && container.Parent != nil &&
			container.Parent.Kind == ast.KindVariableDeclaration && container.Parent.Initializer() == container {
			if name := container.Parent.Name(); name != nil && name.Kind == ast.KindIdentifier {
				classIdent = name
			}
		}
		if classIdent != nil {
			classSym := a.checker.GetSymbolAtLocation(classIdent)
			className := classIdent.Text()
			if classSym != nil {
				searchNewSites := func(sf *ast.SourceFile) bool {
					if sf == nil || (sf != file && !strings.Contains(sf.Text(), className)) {
						return false
					}
					matched := false
					visit(sf.AsNode(), func(n *ast.Node) {
						if matched || n == nil || n.Kind != ast.KindNewExpression {
							return
						}
						callee := unwrapExpression(n.AsNewExpression().Expression)
						if callee == nil {
							return
						}
						sym := a.checker.GetSymbolAtLocation(callee)
						if sym == nil {
							return
						}
						resolved := a.resolveAliasedSymbol(sym)
						if sym != classSym && resolved != classSym {
							return
						}
						if targetType := expectedTypeOfExpr(n); targetType != nil {
							if typeMemberReturnsResultAsync(targetType, memberName, memberNode, 0) {
								matched = true
							}
						}
					})
					return matched
				}
				if searchNewSites(file) {
					return true
				}
				if a.program != nil {
					for _, sf := range a.program.SourceFiles() {
						if sf == nil || sf == file || !a.options.ShouldInspect(string(sf.FileName()), a.projectDir) {
							continue
						}
						if searchNewSites(sf) {
							return true
						}
					}
				}
			}
		}
	}

	return false
}

func (a *Analyzer) unannotatedHelperUsedAsResultAsync(file *ast.SourceFile, fn *ast.Node) bool {
	if fn == nil || fn.Type() != nil || ast.HasSyntacticModifier(fn, ast.ModifierFlagsAsync) {
		return false
	}
	var declNode *ast.Node
	var nameNode *ast.Node
	switch fn.Kind {
	case ast.KindFunctionDeclaration, ast.KindMethodDeclaration:
		declNode = fn
		nameNode = fn.Name()
	case ast.KindArrowFunction, ast.KindFunctionExpression:
		if fn.Parent != nil {
			switch fn.Parent.Kind {
			case ast.KindVariableDeclaration:
				if fn.Parent.Initializer() == fn && fn.Parent.Type() == nil {
					declNode = fn.Parent
					nameNode = fn.Parent.Name()
				}
			case ast.KindPropertyAssignment, ast.KindPropertyDeclaration:
				if fn.Parent.Initializer() == fn && fn.Parent.Type() == nil {
					declNode = fn.Parent
					nameNode = fn.Parent.Name()
				}
			}
		}
	}
	if nameNode == nil || (nameNode.Kind != ast.KindIdentifier && nameNode.Kind != ast.KindPrivateIdentifier) {
		return false
	}
	fnSym := a.checker.GetSymbolAtLocation(nameNode)
	if fnSym == nil {
		return false
	}
	nameText := nameNode.Text()

	symbolMatchesHelper := func(sym *ast.Symbol) bool {
		if sym == nil {
			return false
		}
		if sym == fnSym {
			return true
		}
		resolved := a.resolveAliasedSymbol(sym)
		if resolved == fnSym {
			return true
		}
		hasDecl := func(s *ast.Symbol) bool {
			if s == nil {
				return false
			}
			for _, d := range s.Declarations() {
				if d == declNode || d == fn {
					return true
				}
			}
			return false
		}
		return hasDecl(sym) || hasDecl(resolved)
	}

	expressionUsedAsResultAsync := func(sf *ast.SourceFile, expr *ast.Node) bool {
		child := expr
		parent := expr.Parent
		for parent != nil && parent.Kind == ast.KindParenthesizedExpression {
			child = parent
			parent = parent.Parent
		}
		if parent == nil {
			return false
		}
		if parent.Kind == ast.KindPropertyAccessExpression && parent.Expression() == child && parent.Name() != nil {
			if resultAsyncOnlyVarMethods[parent.Name().Text()] {
				return true
			}
		}
		if parent.Kind == ast.KindVariableDeclaration && parent.Initializer() == child {
			if parent.Type() != nil {
				t := a.checker.GetTypeAtLocation(parent.Type())
				if t != nil && isResultAsyncLikeType(t) && a.isResultarDeclaredType(t) {
					return true
				}
			} else if vName := parent.Name(); vName != nil && vName.Kind == ast.KindIdentifier {
				if a.variableUsedAsResultAsync(sf, parent, vName) {
					return true
				}
			}
		}
		if ctxType := a.checker.GetContextualType(child, checker.ContextFlagsNone); ctxType != nil && isResultAsyncLikeType(ctxType) && a.isResultarDeclaredType(ctxType) {
			return true
		}
		return false
	}

	var checkAliasSymCalls func(sf *ast.SourceFile, root *ast.Node, declIdent *ast.Node, aliasSym *ast.Symbol) bool
	checkAliasSymCalls = func(sf *ast.SourceFile, root *ast.Node, declIdent *ast.Node, aliasSym *ast.Symbol) bool {
		if aliasSym == nil {
			return false
		}
		hit := false
		visit(root, func(r *ast.Node) {
			if hit || r == nil || r.Kind != ast.KindIdentifier || r == declIdent || isDeclarationIdentifier(r) {
				return
			}
			if a.checker.GetSymbolAtLocation(r) != aliasSym {
				return
			}
			c := r
			p := r.Parent
			for p != nil && p.Kind == ast.KindParenthesizedExpression {
				c = p
				p = p.Parent
			}
			if p != nil && p.Kind == ast.KindCallExpression && unwrapExpression(p.Expression()) == c {
				if expressionUsedAsResultAsync(sf, p) {
					hit = true
				}
			}
		})
		return hit
	}

	searchFile := func(sf *ast.SourceFile) bool {
		if sf == nil || (sf != file && !strings.Contains(sf.Text(), nameText)) {
			return false
		}
		found := false
		visit(sf.AsNode(), func(ref *ast.Node) {
			if found || ref == nil || ref == nameNode {
				return
			}
			// Destructured method binding: `const { fetchPrice } = service; fetchPrice().map(...)`
			if ref.Kind == ast.KindBindingElement {
				propNode := ref.PropertyName()
				if propNode == nil {
					propNode = ref.Name()
				}
				if propNode != nil && propNode.Kind == ast.KindIdentifier && propNode.Text() == nameText {
					if pattern := ref.Parent; pattern != nil && pattern.Kind == ast.KindObjectBindingPattern {
						if objType := a.checker.GetTypeAtLocation(pattern); objType != nil {
							if propSym := a.checker.GetPropertyOfType(objType, nameText); symbolMatchesHelper(propSym) {
								if localName := ref.Name(); localName != nil && localName.Kind == ast.KindIdentifier {
									scopeRoot := sf.AsNode()
									for cur := ref.Parent; cur != nil; cur = cur.Parent {
										if isFunctionLikeNode(cur) {
											scopeRoot = cur
											break
										}
									}
									if checkAliasSymCalls(sf, scopeRoot, localName, a.checker.GetSymbolAtLocation(localName)) {
										found = true
									}
								}
							}
						}
					}
				}
				return
			}
			if (ref.Kind != ast.KindIdentifier && ref.Kind != ast.KindPrivateIdentifier) || isDeclarationIdentifier(ref) {
				return
			}
			refSym := a.checker.GetSymbolAtLocation(ref)
			if ref.Parent != nil && ref.Parent.Kind == ast.KindShorthandPropertyAssignment && ref.Parent.Name() == ref {
				refSym = a.checker.GetShorthandAssignmentValueSymbol(ref.Parent)
			}
			if !symbolMatchesHelper(refSym) {
				return
			}

			// For method / property calls (`svc.fetchPrice().map(...)`, `this.fetchPrice().map(...)`, `svc?.fetchPrice()?.map(...)`),
			// advance from the member identifier to the owning PropertyAccessExpression before checking CallExpression.
			target := ref
			if target.Parent != nil && target.Parent.Kind == ast.KindPropertyAccessExpression && target.Parent.Name() == target {
				target = target.Parent
			}
			child := target
			parent := target.Parent
			for parent != nil && parent.Kind == ast.KindParenthesizedExpression {
				child = parent
				parent = parent.Parent
			}
			if parent == nil {
				return
			}
			if parent.Kind == ast.KindCallExpression && unwrapExpression(parent.Expression()) == child {
				if expressionUsedAsResultAsync(sf, parent) {
					found = true
					return
				}
			}
			if parent.Kind == ast.KindVariableDeclaration && parent.Initializer() == child {
				if vName := parent.Name(); vName != nil && vName.Kind == ast.KindIdentifier {
					scopeRoot := sf.AsNode()
					for cur := parent.Parent; cur != nil; cur = cur.Parent {
						if isFunctionLikeNode(cur) {
							scopeRoot = cur
							break
						}
					}
					if checkAliasSymCalls(sf, scopeRoot, vName, a.checker.GetSymbolAtLocation(vName)) {
						found = true
						return
					}
				}
			}
			if ctxType := a.checker.GetContextualType(child, checker.ContextFlagsNone); ctxType != nil {
				for _, sig := range a.checker.GetSignaturesOfType(ctxType, checker.SignatureKindCall) {
					if ret := a.checker.GetReturnTypeOfSignature(sig); ret != nil && isResultAsyncLikeType(ret) && a.isResultarDeclaredType(ret) {
						found = true
						return
					}
				}
			}
		})
		return found
	}

	if searchFile(file) {
		return true
	}
	if a.program != nil {
		for _, sf := range a.program.SourceFiles() {
			if sf == nil || sf == file {
				continue
			}
			if !a.options.ShouldInspect(string(sf.FileName()), a.projectDir) {
				continue
			}
			if searchFile(sf) {
				return true
			}
		}
	}
	return false
}

func isTopLevelBindingExported(file *ast.SourceFile, localName string) bool {
	if isLocallyReexported(file, localName) {
		return true
	}
	for _, stmt := range file.Statements.Nodes {
		if stmt.Kind == ast.KindExportAssignment {
			expr := unwrapExpression(stmt.AsExportAssignment().Expression)
			if expr != nil && expr.Kind == ast.KindIdentifier && expr.Text() == localName {
				return true
			}
		}
	}
	return false
}

func isContainerExported(file *ast.SourceFile, node *ast.Node) bool {
	for cur := node; cur != nil; cur = cur.Parent {
		switch cur.Kind {
		case ast.KindClassDeclaration, ast.KindFunctionDeclaration:
			if ast.HasSyntacticModifier(cur, ast.ModifierFlagsExport) || ast.HasSyntacticModifier(cur, ast.ModifierFlagsDefault) {
				return true
			}
			if name := cur.Name(); name != nil && name.Kind == ast.KindIdentifier && isTopLevelBindingExported(file, name.Text()) {
				return true
			}
			return false
		case ast.KindVariableDeclaration:
			if list := cur.Parent; list != nil && list.Parent != nil && list.Parent.Kind == ast.KindVariableStatement {
				if ast.HasSyntacticModifier(list.Parent, ast.ModifierFlagsExport) {
					return true
				}
				if name := cur.Name(); name != nil && name.Kind == ast.KindIdentifier && isTopLevelBindingExported(file, name.Text()) {
					return true
				}
			}
			return false
		case ast.KindExportAssignment:
			return true
		case ast.KindObjectLiteralExpression, ast.KindPropertyAssignment, ast.KindClassExpression,
			ast.KindParenthesizedExpression, ast.KindAsExpression, ast.KindSatisfiesExpression,
			ast.KindPropertyDeclaration, ast.KindMethodDeclaration:
			continue
		default:
			return false
		}
	}
	return false
}

func (a *Analyzer) isExportedUnannotatedRunResultReturn(file *ast.SourceFile, callNode *ast.Node) bool {
	child := callNode
	parent := callNode.Parent
	for parent != nil && parent.Kind == ast.KindParenthesizedExpression {
		child = parent
		parent = parent.Parent
	}
	if parent == nil {
		return false
	}
	var fn *ast.Node
	switch parent.Kind {
	case ast.KindArrowFunction:
		if parent.Body() == child {
			fn = parent
		}
	case ast.KindReturnStatement:
		for anc := parent.Parent; anc != nil; anc = anc.Parent {
			if isFunctionLikeNode(anc) {
				fn = anc
				break
			}
		}
	}
	if fn == nil || fn.Type() != nil || ast.HasSyntacticModifier(fn, ast.ModifierFlagsAsync) {
		return false
	}
	// Private class methods/fields are not part of the exported public surface.
	if fn.Kind == ast.KindMethodDeclaration {
		if ast.HasSyntacticModifier(fn, ast.ModifierFlagsPrivate) || (fn.Name() != nil && fn.Name().Kind == ast.KindPrivateIdentifier) {
			return false
		}
		return isContainerExported(file, fn.Parent)
	}
	if fn.Parent != nil && fn.Parent.Kind == ast.KindPropertyDeclaration && fn.Parent.Initializer() == fn {
		if fn.Parent.Type() != nil || ast.HasSyntacticModifier(fn.Parent, ast.ModifierFlagsPrivate) ||
			(fn.Parent.Name() != nil && fn.Parent.Name().Kind == ast.KindPrivateIdentifier) {
			return false
		}
		return isContainerExported(file, fn.Parent.Parent)
	}
	if ast.HasSyntacticModifier(fn, ast.ModifierFlagsExport) || ast.HasSyntacticModifier(fn, ast.ModifierFlagsDefault) {
		return true
	}
	if fn.Kind == ast.KindFunctionDeclaration {
		if name := fn.Name(); name != nil && name.Kind == ast.KindIdentifier && isTopLevelBindingExported(file, name.Text()) {
			return true
		}
	}
	return isContainerExported(file, fn.Parent)
}

func (a *Analyzer) isRunResultCall(node *ast.Node) bool {
	if node == nil || node.Kind != ast.KindCallExpression {
		return false
	}
	callee := unwrapExpression(node.AsCallExpression().Expression)
	if callee == nil || callee.Kind != ast.KindPropertyAccessExpression {
		return false
	}
	prop := callee.AsPropertyAccessExpression()
	if prop.Name() == nil || prop.Name().Text() != "runResult" {
		return false
	}
	recv := unwrapExpression(prop.Expression)
	if recv == nil {
		return false
	}
	if pkgGroup, exportName, ok := a.resolvePackageExport(recv); ok && (pkgGroup == "core" || pkgGroup == "app") && exportName == "ResultTask" {
		return true
	}
	recvType := a.checker.GetTypeAtLocation(recv)
	return isResultTaskLikeType(recvType) && a.isResultarDeclaredType(recvType)
}

func (a *Analyzer) migrateRunResultChain(
	file *ast.SourceFile,
	outerCall *ast.Node,
	runResultCall *ast.Node,
	method string,
	args []*ast.Node,
	state *fileMigrationState,
) (MigrationItem, bool) {
	runResultText := strings.TrimSpace(nodeSourceText(file, runResultCall))
	outerText := strings.TrimSpace(nodeSourceText(file, outerCall))
	outerCallee := unwrapExpression(outerCall.AsCallExpression().Expression).AsPropertyAccessExpression()
	innerCallee := unwrapExpression(runResultCall.AsCallExpression().Expression).AsPropertyAccessExpression()
	isOptionalRunResult := ast.IsOptionalChain(runResultCall) || (outerCallee != nil && outerCallee.QuestionDotToken != nil)
	thenRecvText := runResultText
	thenDot := "."
	if outerCallee != nil {
		thenRecvText = strings.TrimSpace(nodeSourceText(file, outerCallee.Expression))
		if outerCallee.QuestionDotToken != nil {
			thenDot = "?."
		}
	}

	// 1. task.runResult(opts).unwrapOrThrow() -> task.runPromise(opts) (preserving `?.`)
	if method == "unwrapOrThrow" && len(args) == 0 && innerCallee != nil {
		innerRecvText := strings.TrimSpace(nodeSourceText(file, innerCallee.Expression))
		innerArgsText := joinNodesText(file, runResultCall.AsCallExpression().Arguments.Nodes)
		dot := "."
		if innerCallee.QuestionDotToken != nil {
			dot = "?."
		}
		replacement := fmt.Sprintf("%s%srunPromise(%s)", innerRecvText, dot, innerArgsText)
		edit := replaceSpanFix(file, outerCall, outerCall, "Replace runResult().unwrapOrThrow() with runPromise()", replacement).Edits[0]
		return makeMigrationItem(
			file, outerCall, MigrationEdit, "run-result-unwrap-or-throw",
			outerText, replacement,
			"`runResult()` returns a native `Promise<Result<...>>` in v5; use `runPromise()` to unwrap or reject directly.",
			[]TextEdit{edit},
		), true
	}

	// 2. task.runResult(opts).match(...) / matchTags(...) / matchTagsPartial(...)
	if method == "match" || method == "matchTags" || method == "matchTagsPartial" {
		allSafe := true
		for _, arg := range args {
			if !a.isSafePostSettlementHandlerArg(file, arg, outerCall) {
				allSafe = false
				break
			}
		}
		if !allSafe {
			return makeMigrationItem(
				file, outerCall, MigrationReview, "run-result-match-order",
				outerText, "",
				fmt.Sprintf("`runResult().%s(...)` has handler expressions, computed keys, or mutable bindings whose evaluation order could change inside `.then(...)`; hoist them into `const` bindings or wrap with `new ResultAsync(%s)` from `resultar/async`.", method, runResultText),
				nil,
			), true
		}

		if method == "match" && len(args) == 1 {
			switch a.classifyRunResultMatchArg(args[0]) {
			case matchShapeLegacyCompat:
				if isOptionalRunResult {
					return makeMigrationItem(
						file, outerCall, MigrationReview, "run-result-match-legacy-handlers",
						outerText, "",
						"Optional-chained `runResult()` with legacy `{ ok, error }` handlers cannot be wrapped directly in `new ResultAsync(...)`; migrate the handler object to `{ ok, err }` or narrow the task before calling `runResult()`.",
						nil,
					), true
				}
				asyncName := state.useAsyncValue("ResultAsync")
				replacement := fmt.Sprintf("new %s(%s)", asyncName, runResultText)
				edit := replaceSpanFix(file, runResultCall, runResultCall, "Wrap runResult() in new "+asyncName+"(...) to preserve legacy { ok, error } match handlers", replacement).Edits[0]
				return makeMigrationItem(
					file, runResultCall, MigrationEdit, "run-result-match-legacy-handlers",
					runResultText, replacement,
					fmt.Sprintf("`runResult().match(...)` uses a legacy `{ ok, error }` handler reference or const computed key; wrap with `new %s(%s)` (from `resultar/async`) to preserve the `{ ok, error }` contract without mutating shared handlers.", asyncName, runResultText),
					[]TextEdit{edit},
				), true
			case matchShapeAmbiguous:
				return makeMigrationItem(
					file, outerCall, MigrationReview, "run-result-match-legacy-handlers",
					outerText, "",
					fmt.Sprintf("`runResult().match(...)` passes a handler object whose `err` vs legacy `error` shape cannot be statically proven for v5 synchronous `Result#match`; migrate the handler object to `{ ok, err }` or wrap with `new ResultAsync(%s)` from `resultar/async`.", runResultText),
					nil,
				), true
			}
		}

		paramName := chooseSafeParamName(file, args)
		var argsText string
		if method == "match" && len(args) == 1 {
			// Normalize legacy `{ ok, error }` / `{ ok, ['error'] }` -> `{ ok, err }` in the SAME pass
			// so `r.match(...)` compiles and handles Err against v5 synchronous `Result` immediately.
			argsText = a.formatNormalizedResultMatchArg(file, args[0])
		} else {
			argsText = joinNodesText(file, args)
		}
		replacement := fmt.Sprintf("%s%sthen((%s) => %s.%s(%s))", thenRecvText, thenDot, paramName, paramName, method, argsText)
		edit := replaceSpanFix(file, outerCall, outerCall, "Chain .then() after runResult()", replacement).Edits[0]
		return makeMigrationItem(
			file, outerCall, MigrationEdit, "run-result-match",
			outerText, replacement,
			fmt.Sprintf("`runResult()` returns a native `Promise<Result<...>>` in v5; fold after settlement with `.then((%s) => %s.%s(...))`.", paramName, paramName, method),
			[]TextEdit{edit},
		), true
	}

	// 3. task.runResult(opts).unwrapOr(fallback)
	if method == "unwrapOr" && len(args) == 1 {
		if a.isSafePostSettlementFallback(file, args[0], outerCall) {
			paramName := chooseSafeParamName(file, args)
			fallbackText := strings.TrimSpace(nodeSourceText(file, args[0]))
			replacement := fmt.Sprintf("%s%sthen((%s) => %s.unwrapOr(%s))", thenRecvText, thenDot, paramName, paramName, fallbackText)
			edit := replaceSpanFix(file, outerCall, outerCall, "Chain .then() for unwrapOr after runResult()", replacement).Edits[0]
			return makeMigrationItem(
				file, outerCall, MigrationEdit, "run-result-unwrap-or",
				outerText, replacement,
				fmt.Sprintf("`runResult()` returns a native `Promise<Result<...>>` in v5; unwrap after settlement with `.then((%s) => %s.unwrapOr(...))`.", paramName, paramName),
				[]TextEdit{edit},
			), true
		}
		return makeMigrationItem(
			file, outerCall, MigrationReview, "run-result-unwrap-or-order",
			outerText, "",
			fmt.Sprintf("`runResult().unwrapOr(...)` evaluates its fallback expression eagerly in v4; capture a stable `const` snapshot before `.then(...)` or wrap with `new ResultAsync(%s)` from `resultar/async`.", runResultText),
			nil,
		), true
	}

	// 4. Other fluent ResultAsync methods chained directly onto runResult(...)
	if runResultFluentAsyncMethods[method] {
		if isOptionalRunResult {
			return makeMigrationItem(
				file, outerCall, MigrationReview, "run-result-fluent-chain",
				outerText, "",
				fmt.Sprintf("Optional-chained `runResult()` with fluent `.%s(...)` cannot be wrapped directly in `new ResultAsync(...)`; move `.%s(...)` onto the `ResultTask` before `?.runResult()` or narrow the receiver first.", method, method),
				nil,
			), true
		}
		asyncName := state.useAsyncValue("ResultAsync")
		replacement := fmt.Sprintf("new %s(%s)", asyncName, runResultText)
		edit := replaceSpanFix(file, runResultCall, runResultCall, "Wrap runResult() in new "+asyncName+"(...) to preserve fluent chaining", replacement).Edits[0]
		return makeMigrationItem(
			file, runResultCall, MigrationEdit, "run-result-fluent-chain",
			runResultText, replacement,
			fmt.Sprintf("`runResult()` returns a native `Promise<Result<...>>` in v5; wrap with `new %s(%s)` (from `resultar/async`) to preserve eager `.%s(...)` chaining, or move `.%s(...)` before `.runResult()`.", asyncName, runResultText, method, method),
			[]TextEdit{edit},
		), true
	}

	return MigrationItem{}, false
}

type matchHandlerShape int

const (
	matchShapeCanonical matchHandlerShape = iota
	matchShapeLegacyCompat
	matchShapeAmbiguous
)

// staticPropertyNameText extracts text from non-computed property names without
// ever invoking Node.Text() on a KindComputedPropertyName (which panics in tsgo).
func staticPropertyNameText(name *ast.Node) (string, bool) {
	if name == nil {
		return "", false
	}
	switch name.Kind {
	case ast.KindIdentifier, ast.KindStringLiteral, ast.KindNumericLiteral,
		ast.KindNoSubstitutionTemplateLiteral, ast.KindPrivateIdentifier:
		return name.Text(), true
	default:
		return "", false
	}
}

// resolvePropertyNameKey resolves both static property names and computed property names
// whose expression is a string literal or has a compile-time string-literal type.
func (a *Analyzer) resolvePropertyNameKey(name *ast.Node) (key string, isComputed bool, isDirectLiteral bool, ok bool) {
	if name == nil {
		return "", false, false, false
	}
	if k, staticOK := staticPropertyNameText(name); staticOK {
		return k, false, true, true
	}
	if name.Kind != ast.KindComputedPropertyName {
		return "", false, false, false
	}
	expr := unwrapExpression(name.AsComputedPropertyName().Expression)
	if expr == nil {
		return "", true, false, false
	}
	if expr.Kind == ast.KindStringLiteral || expr.Kind == ast.KindNoSubstitutionTemplateLiteral {
		return expr.Text(), true, true, true
	}
	if exprType := a.checker.GetTypeAtLocation(expr); exprType != nil && exprType.Flags()&checker.TypeFlagsStringLiteral != 0 {
		if lit, isStr := exprType.AsLiteralType().Value().(string); isStr {
			return lit, true, false, true
		}
	}
	return "", true, false, false
}

func (a *Analyzer) classifyMatchHandlersType(t *checker.Type) matchHandlerShape {
	if t == nil || t.Flags()&(checker.TypeFlagsAnyOrUnknown|checker.TypeFlagsNever) != 0 {
		return matchShapeAmbiguous
	}
	if t.Flags()&checker.TypeFlagsUnion != 0 {
		parts := t.Types()
		if len(parts) == 0 {
			return matchShapeAmbiguous
		}
		var combined matchHandlerShape
		for i, part := range parts {
			shape := a.classifyMatchHandlersType(part)
			if shape == matchShapeAmbiguous {
				return matchShapeAmbiguous
			}
			if i == 0 {
				combined = shape
			} else if combined != shape {
				combined = matchShapeLegacyCompat
			}
		}
		return combined
	}
	errProp := a.checker.GetPropertyOfType(t, "err")
	errorProp := a.checker.GetPropertyOfType(t, "error")
	hasRequiredErr := errProp != nil && errProp.Flags()&ast.SymbolFlagsOptional == 0
	hasRequiredError := errorProp != nil && errorProp.Flags()&ast.SymbolFlagsOptional == 0
	if hasRequiredErr {
		return matchShapeCanonical
	}
	if hasRequiredError {
		return matchShapeLegacyCompat
	}
	return matchShapeAmbiguous
}

func (a *Analyzer) classifyRunResultMatchArg(arg *ast.Node) matchHandlerShape {
	unwrapped := unwrapExpression(arg)
	if unwrapped == nil {
		return matchShapeAmbiguous
	}
	if unwrapped.Kind == ast.KindObjectLiteralExpression {
		shape := matchShapeCanonical
		hasErr := false
		hasError := false
		for _, prop := range unwrapped.AsObjectLiteralExpression().Properties.Nodes {
			if prop.Kind == ast.KindSpreadAssignment {
				return matchShapeAmbiguous
			}
			key, isComputed, isDirectLiteral, known := a.resolvePropertyNameKey(prop.Name())
			if !known {
				return matchShapeAmbiguous
			}
			if key == "err" {
				hasErr = true
			}
			if key == "error" {
				hasError = true
			}
			// A const-backed computed key resolving to `"error"` (e.g. `const onFailure = 'error' as const; { [onFailure]: ... }`)
			// is preserved cleanly via `new ResultAsync(...)` so the const stays referenced (no TS6133 under noUnusedLocals)
			// and runtime semantics stay identical. Direct literal `['error']` can be normalized in place to `err`.
			if isComputed && !isDirectLiteral && key == "error" {
				shape = matchShapeLegacyCompat
			}
		}
		// When BOTH `err` and legacy `error` exist on the same object literal, renaming `error` -> `err`
		// would create a duplicate property (TS1117) and flip runtime precedence from `err` to `error`.
		// Preserve v4's `'err' in input ? input.err : input.error` precedence via `new ResultAsync(...)`.
		if hasErr && hasError {
			return matchShapeLegacyCompat
		}
		return shape
	}
	return a.classifyMatchHandlersType(a.checker.GetTypeAtLocation(arg))
}

// formatNormalizedResultMatchArg returns the source text of a `match(...)` argument with any
// legacy `{ error: ... }` / `{ error }` / `{ error(e) {} }` / `{ ['error']: ... }` handler key
// rewritten to `err` in a single pass.
func (a *Analyzer) formatNormalizedResultMatchArg(file *ast.SourceFile, arg *ast.Node) string {
	unwrapped := unwrapExpression(arg)
	if unwrapped == nil || unwrapped.Kind != ast.KindObjectLiteralExpression {
		return strings.TrimSpace(nodeSourceText(file, arg))
	}
	baseStart := scanner.GetRangeOfTokenAtPosition(file, arg.Pos()).Pos()
	baseEnd := arg.End()
	raw := file.Text()[baseStart:baseEnd]

	// Defensive guard: never rename `error` -> `err` if `err` already exists (avoids TS1117).
	for _, prop := range unwrapped.AsObjectLiteralExpression().Properties.Nodes {
		if key, _, _, known := a.resolvePropertyNameKey(prop.Name()); known && key == "err" {
			return strings.TrimSpace(raw)
		}
	}

	type relEdit struct {
		start   int
		end     int
		newText string
	}
	var edits []relEdit
	for _, prop := range unwrapped.AsObjectLiteralExpression().Properties.Nodes {
		key, _, _, known := a.resolvePropertyNameKey(prop.Name())
		if !known || key != "error" {
			continue
		}
		if prop.Kind == ast.KindShorthandPropertyAssignment {
			pStart := scanner.GetRangeOfTokenAtPosition(file, prop.Pos()).Pos()
			edits = append(edits, relEdit{
				start:   pStart - baseStart,
				end:     prop.End() - baseStart,
				newText: "err: error",
			})
		} else {
			nStart := scanner.GetRangeOfTokenAtPosition(file, prop.Name().Pos()).Pos()
			edits = append(edits, relEdit{
				start:   nStart - baseStart,
				end:     prop.Name().End() - baseStart,
				newText: "err",
			})
		}
	}
	if len(edits) == 0 {
		return strings.TrimSpace(raw)
	}
	sort.Slice(edits, func(i, j int) bool {
		return edits[i].start > edits[j].start
	})
	out := raw
	for _, e := range edits {
		if e.start >= 0 && e.end <= len(out) && e.start <= e.end {
			out = out[:e.start] + e.newText + out[e.end:]
		}
	}
	return strings.TrimSpace(out)
}

// isConstBindingDeclaration returns true when decl is a `const` variable or destructuring binding.
func isConstBindingDeclaration(decl *ast.Node) (isConst bool, isAmbient bool) {
	if decl == nil {
		return false, false
	}
	cur := decl
	for cur != nil && cur.Kind == ast.KindBindingElement {
		cur = cur.Parent
		if cur != nil && (cur.Kind == ast.KindObjectBindingPattern || cur.Kind == ast.KindArrayBindingPattern) {
			cur = cur.Parent
		}
	}
	if cur == nil || cur.Kind != ast.KindVariableDeclaration {
		return false, false
	}
	list := cur.Parent
	if list == nil || list.Kind != ast.KindVariableDeclarationList {
		return false, false
	}
	if list.Flags&ast.NodeFlagsConst == 0 {
		return false, false
	}
	if stmt := list.Parent; stmt != nil && stmt.Kind == ast.KindVariableStatement {
		isAmbient = ast.HasSyntacticModifier(stmt, ast.ModifierFlagsAmbient)
	}
	return true, isAmbient
}

// isStrictlyPrimitiveType returns true only when type_ is provably a JavaScript primitive
// (never an object such as Date, boxed primitive, any, or unknown whose unary coercion could
// call mutable valueOf / Symbol.toPrimitive methods).
func isStrictlyPrimitiveType(type_ *checker.Type) bool {
	if type_ == nil {
		return false
	}
	if type_.Flags()&(checker.TypeFlagsAnyOrUnknown|checker.TypeFlagsNever) != 0 {
		return false
	}
	if type_.Flags()&checker.TypeFlagsUnion != 0 {
		parts := type_.Types()
		if len(parts) == 0 {
			return false
		}
		for _, part := range parts {
			if !isStrictlyPrimitiveType(part) {
				return false
			}
		}
		return true
	}
	const primitiveMask = checker.TypeFlagsStringLike |
		checker.TypeFlagsNumberLike |
		checker.TypeFlagsBooleanLike |
		checker.TypeFlagsBigIntLike |
		checker.TypeFlagsNull |
		checker.TypeFlagsUndefined
	return type_.Flags()&primitiveMask != 0 && type_.Flags()&^primitiveMask == 0
}

// isStableIdentifier proves that reading ident after async settlement produces the exact same
// binding value as reading it synchronously at callNode. Mutable bindings (`let`, `var`, parameters,
// getters, or reassigned symbols) return false so the codemod routes them to manual review.
func (a *Analyzer) isStableIdentifier(file *ast.SourceFile, ident *ast.Node, callNode *ast.Node) bool {
	if ident == nil || ident.Kind != ast.KindIdentifier {
		return false
	}
	var sym *ast.Symbol
	if ident.Parent != nil && ident.Parent.Kind == ast.KindShorthandPropertyAssignment && ident.Parent.Name() == ident {
		sym = a.checker.GetShorthandAssignmentValueSymbol(ident.Parent)
	} else {
		sym = a.checker.GetSymbolAtLocation(ident)
	}
	if sym == nil {
		return ident.Text() == "undefined"
	}
	summary := a.getFileMutationSummary(file)
	if summary != nil && summary.mutatedSymbols[sym] {
		return false
	}
	resolved := a.resolveAliasedSymbol(sym)
	if resolved == nil {
		return false
	}
	if summary != nil && summary.mutatedSymbols[resolved] {
		return false
	}
	decls := resolved.Declarations()
	if len(decls) == 0 {
		return false
	}
	for _, decl := range decls {
		if decl == nil {
			return false
		}
		switch decl.Kind {
		case ast.KindVariableDeclaration, ast.KindBindingElement:
			isConst, isAmbient := isConstBindingDeclaration(decl)
			if !isConst {
				return false
			}
			// Guard against TDZ / later-declared local const in the same file.
			if !isAmbient && ast.GetSourceFileOfNode(decl) == file && decl.End() > callNode.Pos() {
				return false
			}
		case ast.KindFunctionDeclaration, ast.KindClassDeclaration, ast.KindEnumDeclaration:
			// Immutable declaration unless reassigned (already checked via mutatedSymbols).
		default:
			// Parameters, getters, properties, let/var, or unknown ambient declarations are not proven stable.
			return false
		}
	}
	return true
}

func (a *Analyzer) isSafePostSettlementFallback(file *ast.SourceFile, node *ast.Node, callNode *ast.Node) bool {
	node = unwrapExpression(node)
	if node == nil {
		return false
	}
	switch node.Kind {
	case ast.KindNumericLiteral, ast.KindStringLiteral, ast.KindBigIntLiteral,
		ast.KindTrueKeyword, ast.KindFalseKeyword, ast.KindNullKeyword,
		ast.KindNoSubstitutionTemplateLiteral:
		return true
	case ast.KindIdentifier:
		return a.isStableIdentifier(file, node, callNode)
	case ast.KindPrefixUnaryExpression:
		unary := node.AsPrefixUnaryExpression()
		switch unary.Operator {
		case ast.KindPlusToken, ast.KindMinusToken, ast.KindTildeToken, ast.KindExclamationToken:
			// Unary coercion (+date, -obj, ~obj) invokes valueOf/toPrimitive on objects,
			// which can observe mutable state later. Only allow on pure primitives/literals.
			operand := unwrapExpression(unary.Operand)
			if operand == nil {
				return false
			}
			if !a.isSafePostSettlementFallback(file, operand, callNode) {
				return false
			}
			opType := a.checker.GetTypeAtLocation(operand)
			if unary.Operator == ast.KindPlusToken && opType != nil && opType.Flags()&checker.TypeFlagsBigIntLike != 0 {
				return false
			}
			return isStrictlyPrimitiveType(opType)
		default:
			return false
		}
	default:
		return false
	}
}

func (a *Analyzer) isSafePostSettlementHandlerArg(file *ast.SourceFile, node *ast.Node, callNode *ast.Node) bool {
	node = unwrapExpression(node)
	if node == nil {
		return false
	}
	switch node.Kind {
	case ast.KindArrowFunction, ast.KindFunctionExpression:
		return true
	case ast.KindIdentifier:
		return a.isStableIdentifier(file, node, callNode)
	case ast.KindObjectLiteralExpression:
		for _, prop := range node.AsObjectLiteralExpression().Properties.Nodes {
			if propName := prop.Name(); propName != nil && propName.Kind == ast.KindComputedPropertyName {
				keyExpr := unwrapExpression(propName.AsComputedPropertyName().Expression)
				if !a.isSafePostSettlementFallback(file, keyExpr, callNode) {
					return false
				}
			}
			switch prop.Kind {
			case ast.KindMethodDeclaration:
				continue
			case ast.KindShorthandPropertyAssignment:
				if !a.isStableIdentifier(file, prop.Name(), callNode) {
					return false
				}
			case ast.KindPropertyAssignment:
				if !a.isSafePostSettlementHandlerArg(file, prop.AsPropertyAssignment().Initializer, callNode) {
					return false
				}
			default:
				return false
			}
		}
		return true
	default:
		return false
	}
}

func chooseSafeParamName(file *ast.SourceFile, args []*ast.Node) string {
	combined := joinNodesText(file, args)
	for _, candidate := range []string{"r", "_r", "_res", "_result"} {
		if !containsIdentifierWord(combined, candidate) {
			return candidate
		}
	}
	return "__result"
}

func containsIdentifierWord(text, word string) bool {
	idx := 0
	for {
		pos := strings.Index(text[idx:], word)
		if pos < 0 {
			return false
		}
		start := idx + pos
		end := start + len(word)
		leftOk := start == 0 || !isIdentChar(text[start-1])
		rightOk := end == len(text) || !isIdentChar(text[end])
		if leftOk && rightOk {
			return true
		}
		idx = start + 1
	}
}

func isIdentChar(ch byte) bool {
	return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '$'
}

func isAsyncGeneratorCallback(arg *ast.Node) bool {
	arg = unwrapExpression(arg)
	if arg == nil {
		return false
	}
	if arg.Kind == ast.KindFunctionExpression {
		return ast.HasSyntacticModifier(arg, ast.ModifierFlagsAsync) && arg.AsFunctionExpression().AsteriskToken != nil
	}
	if arg.Kind == ast.KindObjectLiteralExpression {
		for _, prop := range arg.AsObjectLiteralExpression().Properties.Nodes {
			key, ok := staticPropertyNameText(prop.Name())
			if !ok || key != "try" {
				continue
			}
			if prop.Kind == ast.KindMethodDeclaration {
				return ast.HasSyntacticModifier(prop, ast.ModifierFlagsAsync) && prop.AsMethodDeclaration().AsteriskToken != nil
			}
			if prop.Kind == ast.KindPropertyAssignment {
				return isAsyncGeneratorCallback(prop.AsPropertyAssignment().Initializer)
			}
		}
	}
	return false
}

func typeReturnsAsyncGenerator(c *checker.Checker, t *checker.Type) bool {
	if c == nil || t == nil {
		return false
	}
	if t.Flags()&checker.TypeFlagsUnionOrIntersection != 0 {
		for _, part := range t.Types() {
			if typeReturnsAsyncGenerator(c, part) {
				return true
			}
		}
	}
	for _, sig := range c.GetSignaturesOfType(t, checker.SignatureKindCall) {
		ret := c.GetReturnTypeOfSignature(sig)
		if ret == nil {
			continue
		}
		name := typeSymbolName(ret)
		if name == "AsyncGenerator" || name == "AsyncIterableIterator" {
			return true
		}
		if sym := ret.Symbol(); sym != nil && (sym.Name() == "AsyncGenerator" || sym.Name() == "AsyncIterableIterator") {
			return true
		}
	}
	return false
}

func (a *Analyzer) isAsyncResultGenOrFnCall(callNode *ast.Node, method string, firstArg *ast.Node) bool {
	if isAsyncGeneratorCallback(firstArg) {
		return true
	}
	if a.checker == nil || firstArg == nil {
		return false
	}
	argType := a.checker.GetTypeAtLocation(firstArg)
	if typeReturnsAsyncGenerator(a.checker, argType) {
		return true
	}
	if method == "gen" && argType != nil {
		if tryProp := a.checker.GetPropertyOfType(argType, "try"); tryProp != nil {
			tryType := a.checker.GetTypeOfSymbolAtLocation(tryProp, firstArg)
			if typeReturnsAsyncGenerator(a.checker, tryType) {
				return true
			}
		}
	}
	callType := a.checker.GetTypeAtLocation(callNode)
	if method == "gen" && isResultAsyncLikeType(callType) {
		return true
	}
	if method == "fn" && len(callNode.AsCallExpression().Arguments.Nodes) == 1 && callType != nil {
		for _, sig := range a.checker.GetSignaturesOfType(callType, checker.SignatureKindCall) {
			if ret := a.checker.GetReturnTypeOfSignature(sig); ret != nil && isResultAsyncLikeType(ret) {
				return true
			}
		}
	}
	return false
}

func (a *Analyzer) checkEagerRequestJsonCall(file *ast.SourceFile, callNode *ast.Node, args []*ast.Node) *MigrationItem {
	// If the resolved call already returns a ResultTask (v5 contract), do not emit an eager migration review.
	callType := a.checker.GetTypeAtLocation(callNode)
	if isResultTaskLikeType(callType) && !isResultAsyncLikeType(callType) {
		return nil
	}

	var reasons []string
	if len(args) == 0 {
		reasons = append(reasons, "options argument is missing or opaque and cannot be statically verified")
	} else {
		arg := unwrapExpression(args[0])
		if arg == nil || arg.Kind != ast.KindObjectLiteralExpression {
			reasons = append(reasons, "options are passed via a variable/expression whose `request` factory, `signal`, and `retry.signal` fields cannot be statically verified")
		} else {
			for _, prop := range arg.AsObjectLiteralExpression().Properties.Nodes {
				if prop.Kind == ast.KindSpreadAssignment {
					reasons = append(reasons, "spread options cannot be statically verified for eager `request`, `signal`, or `retry.signal`")
					continue
				}
				key, staticKey := staticPropertyNameText(prop.Name())
				if !staticKey {
					if prop.Name() != nil && prop.Name().Kind == ast.KindComputedPropertyName {
						reasons = append(reasons, "computed option keys cannot be statically verified for eager `request`, `signal`, or `retry.signal`")
					}
					continue
				}
				switch key {
				case "request":
					if prop.Kind == ast.KindPropertyAssignment {
						init := unwrapExpression(prop.AsPropertyAssignment().Initializer)
						if init != nil && init.Kind != ast.KindArrowFunction && init.Kind != ast.KindFunctionExpression {
							reasons = append(reasons, "`request` must be a lazy factory `(signal) => fetch(...)` instead of an eager Promise")
						}
					}
				case "signal":
					reasons = append(reasons, "`signal` moved from request options to `runResult({ signal })` / Task signal")
				case "retry":
					if prop.Kind == ast.KindPropertyAssignment {
						retryObj := unwrapExpression(prop.AsPropertyAssignment().Initializer)
						if retryObj != nil && retryObj.Kind == ast.KindObjectLiteralExpression {
							for _, rp := range retryObj.AsObjectLiteralExpression().Properties.Nodes {
								if rp.Kind == ast.KindSpreadAssignment {
									reasons = append(reasons, "spread `retry` options cannot be statically verified for `retry.signal`")
								} else if rk, rok := staticPropertyNameText(rp.Name()); rok && rk == "signal" {
									reasons = append(reasons, "`retry.signal` was removed; pass signal via `runResult({ signal })`")
								} else if rp.Name() != nil && rp.Name().Kind == ast.KindComputedPropertyName {
									reasons = append(reasons, "computed `retry` option keys cannot be statically verified for `retry.signal`")
								}
							}
						} else if retryObj != nil {
							reasons = append(reasons, "`retry` is passed via a variable/expression and may contain removed `retry.signal`")
						}
					}
				}
			}
		}
	}

	detail := "callers previously awaiting an eager `ResultAsync` will not execute the HTTP request until `.runResult()` or `yield*` is added"
	if len(reasons) > 0 {
		detail = strings.Join(reasons, "; ") + "; " + detail
	}
	item := makeMigrationItem(
		file, callNode, MigrationReview, "request-json-v5-contract",
		nodeSourceText(file, callNode), "",
		"In v5, `requestJson*` returns a lazy `ResultTask` instead of an eager `ResultAsync`: "+detail+". Review execution timing and cancellation (`AbortError` / `Cause.Interrupt`).",
		nil,
	)
	return &item
}

func (a *Analyzer) migrateLegacyMatchObject(file *ast.SourceFile, arg *ast.Node, isTask bool) []MigrationItem {
	arg = unwrapExpression(arg)
	if arg == nil {
		return nil
	}
	if arg.Kind != ast.KindObjectLiteralExpression {
		if a.classifyMatchHandlersType(a.checker.GetTypeAtLocation(arg)) == matchShapeLegacyCompat {
			return []MigrationItem{makeMigrationItem(
				file, arg, MigrationReview, "match-handler-key",
				nodeSourceText(file, arg), "",
				"This `.match(...)` handler object uses legacy `{ ok, error }` keys; v5 requires `{ ok, err }`.",
				nil,
			)}
		}
		return nil
	}
	existingKeys := make(map[string]bool)
	for _, prop := range arg.AsObjectLiteralExpression().Properties.Nodes {
		if key, _, _, known := a.resolvePropertyNameKey(prop.Name()); known {
			existingKeys[key] = true
		}
	}
	items := make([]MigrationItem, 0)
	for _, prop := range arg.AsObjectLiteralExpression().Properties.Nodes {
		if prop.Name() == nil {
			continue
		}
		key, isComputed, isDirectLiteral, known := a.resolvePropertyNameKey(prop.Name())
		if !known {
			if prop.Name().Kind == ast.KindComputedPropertyName {
				items = append(items, makeMigrationItem(
					file, prop.Name(), MigrationReview, "match-handler-key",
					nodeSourceText(file, prop.Name()), "",
					"Computed `.match(...)` handler key cannot be statically verified for legacy `error` / `onSuccess` / `onFailure` keys; v5 requires `{ ok, err }`.",
					nil,
				))
			}
			continue
		}
		newKey := ""
		switch {
		case key == "error":
			newKey = "err"
		case isTask && key == "onSuccess":
			newKey = "ok"
		case isTask && key == "onFailure":
			newKey = "err"
		}
		if newKey == "" {
			continue
		}
		if existingKeys[newKey] {
			items = append(items, makeMigrationItem(
				file, prop.Name(), MigrationReview, "match-handler-key",
				nodeSourceText(file, prop.Name()), "",
				fmt.Sprintf("Object literal defines both `%s` and legacy `%s`; v4 prefers `%s`. Remove the redundant `%s` property instead of renaming to avoid duplicate keys (TS1117).", newKey, key, newKey, key),
				nil,
			))
			continue
		}
		if isComputed && !isDirectLiteral {
			items = append(items, makeMigrationItem(
				file, prop.Name(), MigrationReview, "match-handler-key",
				nodeSourceText(file, prop.Name()), newKey,
				fmt.Sprintf("Computed `.match(...)` handler key resolves to legacy `%s`; replace with canonical `%s`.", key, newKey),
				nil,
			))
			continue
		}
		if prop.Kind == ast.KindShorthandPropertyAssignment {
			replacement := fmt.Sprintf("%s: %s", newKey, key)
			edit := replaceSpanFix(file, prop, prop, "Rename match handler key to "+newKey, replacement).Edits[0]
			items = append(items, makeMigrationItem(
				file, prop, MigrationEdit, "match-handler-key",
				key, replacement,
				fmt.Sprintf("Replace legacy `.match({ %s })` handler key with canonical `%s`.", key, newKey),
				[]TextEdit{edit},
			))
		} else {
			edit := renameFix(file, prop.Name(), "Rename match handler key to "+newKey, newKey).Edits[0]
			items = append(items, makeMigrationItem(
				file, prop.Name(), MigrationEdit, "match-handler-key",
				nodeSourceText(file, prop.Name()), newKey,
				fmt.Sprintf("Replace legacy `.match({ %s })` handler key with canonical `%s`.", key, newKey),
				[]TextEdit{edit},
			))
		}
	}
	return items
}

func joinNodesText(file *ast.SourceFile, nodes []*ast.Node) string {
	parts := make([]string, 0, len(nodes))
	for _, n := range nodes {
		parts = append(parts, strings.TrimSpace(nodeSourceText(file, n)))
	}
	return strings.Join(parts, ", ")
}
