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

type Channels struct {
	Success      string `json:"success,omitempty"`
	Error        string `json:"error,omitempty"`
	Requirements string `json:"requirements,omitempty"`
}
type DeclarationLocation struct {
	File   string `json:"file"`
	Line   int    `json:"line"`
	Column int    `json:"column"`
}
type OverviewEntry struct {
	Kind         string              `json:"kind"`
	Name         string              `json:"name"`
	ExportedFrom string              `json:"exportedFrom"`
	Declaration  DeclarationLocation `json:"declaration"`
	Channels     Channels            `json:"channels"`
	Tag          string              `json:"tag,omitempty"`
	Identifier   string              `json:"identifier,omitempty"`
	Contract     string              `json:"contract,omitempty"`
}
type Overview struct {
	SchemaVersion int             `json:"schemaVersion"`
	Entries       []OverviewEntry `json:"entries"`
}

func typeChannels(c *checker.Checker, t *checker.Type, node *ast.Node) (Channels, bool) {
	if t == nil {
		return Channels{}, false
	}
	if t.Flags()&checker.TypeFlagsUnionOrIntersection != 0 {
		result := Channels{}
		matched := false
		for _, part := range t.Types() {
			channels, ok := typeChannels(c, part, node)
			if ok {
				matched = true
				result = mergeChannels(result, channels)
			}
		}
		return result, matched
	}
	if !isResultLikeType(t) {
		return Channels{}, false
	}
	args := typeArguments(c, t)
	if len(args) < 2 {
		return Channels{}, false
	}
	render := func(t *checker.Type) string {
		return c.TypeToStringEx(t, node, checker.TypeFormatFlagsNoTruncation, nil)
	}
	result := Channels{Success: render(args[0]), Error: render(args[1])}
	if isResultTaskLikeType(t) && len(args) > 2 {
		result.Requirements = render(args[2])
	}
	return result, true
}
func mergeChannels(a, b Channels) Channels {
	merge := func(a, b string) string {
		if a == "" {
			return b
		}
		if b == "" || a == b {
			return a
		}
		return a + " | " + b
	}
	return Channels{Success: merge(a.Success, b.Success), Error: merge(a.Error, b.Error), Requirements: merge(a.Requirements, b.Requirements)}
}
func propertyType(c *checker.Checker, t *checker.Type, name string, node *ast.Node) *checker.Type {
	property := c.GetPropertyOfType(t, name)
	if property == nil {
		return nil
	}
	return c.GetTypeOfSymbolAtLocation(property, node)
}
func serviceDetails(c *checker.Checker, t *checker.Type, node *ast.Node) (string, string, bool) {
	if t == nil {
		return "", "", false
	}
	if typeSymbolName(t) != "ServiceTag" && (t.Symbol() == nil || t.Symbol().Name() != "ServiceTag") {
		return "", "", false
	}
	args := typeArguments(c, t)
	if len(args) < 2 {
		return "", "", false
	}
	return c.TypeToStringEx(args[0], node, checker.TypeFormatFlagsNoTruncation, nil), c.TypeToStringEx(args[1], node, checker.TypeFormatFlagsNoTruncation, nil), true
}

func BuildOverview(ctx context.Context, program *compiler.Program, projectDir string, options config.Options) (Overview, error) {
	c, done := program.GetTypeChecker(ctx)
	defer done()
	if c == nil {
		return Overview{}, fmt.Errorf("unable to acquire TypeScript checker")
	}
	result := Overview{SchemaVersion: 1, Entries: []OverviewEntry{}}
	for _, file := range program.SourceFiles() {
		fileName := string(file.FileName())
		if !options.ShouldInspect(fileName, projectDir) {
			continue
		}
		module := c.GetSymbolAtLocation(file.AsNode())
		if module == nil {
			continue
		}
		for _, export := range c.GetExportsOfModule(module) {
			symbol := export
			if symbol.Flags()&ast.SymbolFlagsAlias != 0 {
				symbol = c.GetAliasedSymbol(symbol)
			}
			if symbol == nil {
				continue
			}
			decl := symbol.ValueDeclaration()
			if decl == nil {
				continue
			}
			origin := ast.GetSourceFileOfNode(decl)
			if origin == nil || !options.ShouldInspect(string(origin.FileName()), projectDir) {
				continue
			}
			line, column := scanner.GetECMALineAndUTF16CharacterOfPosition(origin, scanner.GetRangeOfTokenAtPosition(origin, decl.Pos()).Pos())
			entry := OverviewEntry{Name: export.Name(), ExportedFrom: fileName, Declaration: DeclarationLocation{File: string(origin.FileName()), Line: line + 1, Column: int(column) + 1}}
			t := c.GetTypeOfSymbolAtLocation(symbol, decl)
			if channels, ok := typeChannels(c, t, decl); ok {
				entry.Kind = "value"
				entry.Channels = channels
			}
			for _, signature := range c.GetCallSignatures(t) {
				if channels, ok := typeChannels(c, c.GetReturnTypeOfSignature(signature), decl); ok {
					entry.Kind = "function"
					entry.Channels = mergeChannels(entry.Channels, channels)
				}
			}
			if id, contract, ok := serviceDetails(c, t, decl); ok {
				entry.Kind = "service"
				entry.Identifier = id
				entry.Contract = contract
			}
			for _, signature := range c.GetConstructSignatures(t) {
				instance := c.GetReturnTypeOfSignature(signature)
				tag := propertyType(c, instance, "_tag", decl)
				if tag != nil && propertyType(c, instance, "message", decl) != nil {
					entry.Kind = "error"
					entry.Tag = c.TypeToStringEx(tag, decl, checker.TypeFormatFlagsNoTruncation, nil)
				}
			}
			if entry.Kind != "" {
				result.Entries = append(result.Entries, entry)
			}
		}
	}
	sort.SliceStable(result.Entries, func(i, j int) bool {
		a, b := result.Entries[i], result.Entries[j]
		if a.Declaration.File != b.Declaration.File {
			return a.Declaration.File < b.Declaration.File
		}
		if a.Declaration.Line != b.Declaration.Line {
			return a.Declaration.Line < b.Declaration.Line
		}
		if a.Declaration.Column != b.Declaration.Column {
			return a.Declaration.Column < b.Declaration.Column
		}
		if a.Name != b.Name {
			return a.Name < b.Name
		}
		return a.ExportedFrom < b.ExportedFrom
	})
	return result, nil
}

// HoverAt uses the same bound program as diagnostics, including editor overlays.
func HoverAt(ctx context.Context, program *compiler.Program, path string, offset int) (string, error) {
	c, done := program.GetTypeChecker(ctx)
	defer done()
	if c == nil {
		return "", fmt.Errorf("unable to acquire TypeScript checker")
	}
	for _, file := range program.SourceFiles() {
		if filepath.Clean(string(file.FileName())) != filepath.Clean(path) {
			continue
		}
		var selected *ast.Node
		visit(file.AsNode(), func(node *ast.Node) {
			if node.Pos() <= offset && offset < node.End() {
				selected = node
			}
		})
		if selected == nil {
			return "", nil
		}
		if selected.Kind == ast.KindAsteriskToken && selected.Parent != nil && selected.Parent.Kind == ast.KindYieldExpression {
			selected = selected.Parent
		}
		if selected.Kind == ast.KindYieldExpression {
			selected = selected.Expression()
		}
		if selected == nil {
			return "", nil
		}
		t := c.GetTypeAtLocation(selected)
		if id, contract, ok := serviceDetails(c, t, selected); ok {
			return fmt.Sprintf("**Service** `%s`\n\nContract: `%s`", id, contract), nil
		}
		if typeSymbolName(t) == "MatchMatcher" || (t.Symbol() != nil && t.Symbol().Name() == "MatchMatcher") {
			arguments := typeArguments(c, t)
			if len(arguments) >= 3 {
				render := func(channel *checker.Type) string {
					return c.TypeToStringEx(channel, selected, checker.TypeFormatFlagsNoTruncation, nil)
				}
				return fmt.Sprintf("**Match input**\n```ts\n%s\n```\n**Remaining cases**\n```ts\n%s\n```\n**Matched output**\n```ts\n%s\n```", render(arguments[0]), render(arguments[1]), render(arguments[2])), nil
			}
		}
		channels, ok := typeChannels(c, t, selected)
		if !ok {
			for _, signature := range c.GetCallSignatures(t) {
				next, matched := typeChannels(c, c.GetReturnTypeOfSignature(signature), selected)
				if matched {
					ok = true
					channels = mergeChannels(channels, next)
				}
			}
		}
		if !ok {
			return "", nil
		}
		text := fmt.Sprintf("**Success T**\n```ts\n%s\n```\n**Errors E**\n```ts\n%s\n```", channels.Success, channels.Error)
		if channels.Requirements != "" {
			text += fmt.Sprintf("\n**Requirements R**\n```ts\n%s\n```", channels.Requirements)
		}
		return text, nil
	}
	return "", nil
}

func Refactors(ctx context.Context, program *compiler.Program, path string) ([]Fix, error) {
	c, done := program.GetTypeChecker(ctx)
	defer done()
	if c == nil {
		return nil, fmt.Errorf("unable to acquire TypeScript checker")
	}
	a := Analyzer{checker: c}
	result := []Fix{}
	for _, file := range program.SourceFiles() {
		if filepath.Clean(string(file.FileName())) != filepath.Clean(path) {
			continue
		}
		source := func(node *ast.Node) string {
			start := scanner.GetRangeOfTokenAtPosition(file, node.Pos()).Pos()
			return file.Text()[start:node.End()]
		}
		stable := func(node *ast.Node) bool {
			if node == nil || node.Kind != ast.KindIdentifier {
				return false
			}
			symbol := c.GetSymbolAtLocation(node)
			if symbol == nil || symbol.ValueDeclaration() == nil {
				return false
			}
			decl := symbol.ValueDeclaration()
			return decl.Kind == ast.KindVariableDeclaration && decl.Parent != nil && decl.Parent.Kind == ast.KindVariableDeclarationList && decl.Parent.Flags&ast.NodeFlagsConst != 0
		}
		comments := sourceComments(file)
		add := func(node *ast.Node, title, text string) {
			start := scanner.GetRangeOfTokenAtPosition(file, node.Pos()).Pos()
			// Refuse edits that would drop comments from the replaced expression.
			for _, comment := range comments {
				if comment.Pos() >= start && comment.End() <= node.End() {
					return
				}
			}
			fix := Fix{Title: title, Kind: FixCorrection, Edits: []TextEdit{{Start: start, Length: node.End() - start, NewText: text}}}
			fix.Description = "Preserves task execution order and cleanup."
			result = append(result, fix)
		}
		pipeIdent := ""
		visit(file.AsNode(), func(node *ast.Node) {
			if pipeIdent != "" {
				return
			}
			switch node.Kind {
			case ast.KindImportSpecifier:
				if node.Name() != nil && a.canonicalExpressionName(node.Name()) == "pipe" {
					pipeIdent = node.Name().Text()
				}
			case ast.KindFunctionDeclaration, ast.KindVariableDeclaration:
				if node.Name() != nil && node.Name().Kind == ast.KindIdentifier && node.Name().Text() == "pipe" {
					pipeIdent = "pipe"
				}
			}
		})
		visit(file.AsNode(), func(node *ast.Node) {
			if (node.Kind == ast.KindArrowFunction || node.Kind == ast.KindFunctionExpression) && node.Body() != nil {
				outerText := strings.TrimSpace(source(node))
				if strings.HasPrefix(outerText, "async ") || strings.HasPrefix(outerText, "async(") {
					return
				}
				if node.Kind == ast.KindFunctionExpression && node.AsFunctionExpression().AsteriskToken != nil {
					return
				}
				var genCall *ast.Node
				if node.Body().Kind == ast.KindCallExpression {
					genCall = node.Body()
				} else if node.Body().Kind == ast.KindBlock {
					stmts := node.Body().AsBlock().Statements.Nodes
					if len(stmts) == 1 && stmts[0].Kind == ast.KindReturnStatement && stmts[0].Expression() != nil {
						expr := unwrapExpression(stmts[0].Expression())
						if expr != nil && expr.Kind == ast.KindCallExpression {
							genCall = expr
						}
					}
				}
				if genCall != nil {
					call := genCall.AsCallExpression()
					namespace := a.staticNamespace(call.Expression, "gen")
					if (namespace == "ResultTask" || namespace == "Result") && len(call.Arguments.Nodes) == 1 && call.Expression.Kind == ast.KindPropertyAccessExpression {
						nsReceiver := call.Expression.AsPropertyAccessExpression().Expression
						if c.GetPropertyOfType(c.GetTypeAtLocation(nsReceiver), "fn") != nil {
							innerGen := unwrapExpression(call.Arguments.Nodes[0])
							if innerGen != nil && innerGen.Kind == ast.KindFunctionExpression && innerGen.AsFunctionExpression().AsteriskToken != nil && len(innerGen.Parameters()) == 0 && innerGen.Body() != nil && innerGen.Body().Kind == ast.KindBlock {
								innerText := strings.TrimSpace(source(innerGen))
								prefix := "function*"
								if strings.HasPrefix(innerText, "async") {
									prefix = "async function*"
								}
								typeParamsText := ""
								if tps := node.TypeParameters(); len(tps) > 0 {
									parts := make([]string, 0, len(tps))
									for _, tp := range tps {
										parts = append(parts, source(tp))
									}
									typeParamsText = "<" + strings.Join(parts, ", ") + ">"
								}
								params := make([]string, 0, len(node.Parameters()))
								for _, param := range node.Parameters() {
									params = append(params, source(param))
								}
								replacement := fmt.Sprintf("%s.fn(%s%s(%s) %s)", source(nsReceiver), prefix, typeParamsText, strings.Join(params, ", "), source(innerGen.Body()))
								add(node, fmt.Sprintf("Convert to %s.fn", namespace), replacement)
							}
						}
					}
				}
				return
			}
			if node.Kind != ast.KindCallExpression {
				return
			}
			call := node.AsCallExpression()
			if call.Expression.Kind != ast.KindPropertyAccessExpression && a.canonicalExpressionName(call.Expression) == "pipe" && len(call.Arguments.Nodes) >= 2 {
				firstArg := call.Arguments.Nodes[0]
				firstType := c.GetTypeAtLocation(firstArg)
				if isResultLikeType(firstType) && c.GetPropertyOfType(firstType, "pipe") != nil {
					steps := make([]string, 0, len(call.Arguments.Nodes)-1)
					for _, step := range call.Arguments.Nodes[1:] {
						steps = append(steps, source(step))
					}
					recvText := source(firstArg)
					switch firstArg.Kind {
					case ast.KindIdentifier, ast.KindCallExpression, ast.KindPropertyAccessExpression, ast.KindElementAccessExpression, ast.KindParenthesizedExpression:
					default:
						recvText = "(" + recvText + ")"
					}
					add(node, "Convert to method .pipe()", fmt.Sprintf("%s.pipe(%s)", recvText, strings.Join(steps, ", ")))
				}
				return
			}
			if a.isResultTaskStaticCall(call.Expression, "gen") && len(call.Arguments.Nodes) == 1 {
				body := a.resultTaskGenBody(node)
				if body == nil || body.Body() == nil || body.Body().Kind != ast.KindBlock {
					return
				}
				statements := body.Body().AsBlock().Statements.Nodes
				if len(statements) != 1 || statements[0].Kind != ast.KindReturnStatement {
					return
				}
				yield := unwrapExpression(statements[0].Expression())
				if yield == nil || yield.Kind != ast.KindYieldExpression || yield.AsYieldExpression().AsteriskToken == nil {
					return
				}
				task := unwrapExpression(yield.Expression())
				// A generator can capture a const that is initialized later; replacing it
				// with an eager reference would access the binding before initialization.
				if stable(task) && c.GetSymbolAtLocation(task).ValueDeclaration().End() < node.Pos() && isResultTaskLikeType(c.GetTypeAtLocation(task)) {
					add(node, "Simplify delegating task generator", source(task))
				}
				return
			}
			method, receiver, _ := methodCall(node)
			if method == "pipe" && len(call.Arguments.Nodes) >= 1 && receiver != nil && pipeIdent != "" && isResultLikeType(c.GetTypeAtLocation(receiver)) {
				args := make([]string, 0, len(call.Arguments.Nodes)+1)
				args = append(args, source(receiver))
				for _, step := range call.Arguments.Nodes {
					args = append(args, source(step))
				}
				add(node, "Convert to pipe(...)", fmt.Sprintf("%s(%s)", pipeIdent, strings.Join(args, ", ")))
				return
			}
			if receiver == nil || !isResultTaskLikeType(c.GetTypeAtLocation(receiver)) {
				return
			}
			if (method == "catchAll" || method == "orElse") && len(call.Arguments.Nodes) == 1 {
				callback := unwrapExpression(call.Arguments.Nodes[0])
				if callback == nil || callback.Kind != ast.KindArrowFunction {
					return
				}
				parameters := callback.AsArrowFunction().Parameters.Nodes
				if len(parameters) != 1 || parameters[0].Name().Kind != ast.KindIdentifier || parameters[0].Initializer() != nil {
					return
				}
				name := parameters[0].Name().Text()
				expression := callback.Body()
				if expression.Kind == ast.KindBlock {
					statements := expression.AsBlock().Statements.Nodes
					if len(statements) != 1 || statements[0].Kind != ast.KindReturnStatement {
						return
					}
					expression = statements[0].Expression()
				}
				handlers := []string{}
				tags := map[string]bool{}
				for expression != nil && expression.Kind == ast.KindConditionalExpression {
					conditional := expression.AsConditionalExpression()
					condition := conditional.Condition
					if condition.Kind != ast.KindBinaryExpression {
						return
					}
					binary := condition.AsBinaryExpression()
					if binary.OperatorToken.Kind != ast.KindEqualsEqualsEqualsToken || binary.Left.Kind != ast.KindPropertyAccessExpression || binary.Right.Kind != ast.KindStringLiteral {
						return
					}
					property := binary.Left.AsPropertyAccessExpression()
					if property.Name().Text() != "_tag" || property.Expression.Kind != ast.KindIdentifier || property.Expression.Text() != name {
						return
					}
					if tags[binary.Right.Text()] {
						return
					}
					tags[binary.Right.Text()] = true
					// Let catchTags contextually narrow the parameter to the selected tag.
					handlers = append(handlers, source(binary.Right)+": ("+name+") => "+source(conditional.WhenTrue))
					expression = conditional.WhenFalse
				}
				if len(handlers) == 0 || expression == nil || expression.Kind != ast.KindCallExpression {
					return
				}
				fallback := expression.AsCallExpression()
				if (!a.isResultTaskStaticCall(fallback.Expression, "err") && !a.isResultTaskStaticCall(fallback.Expression, "fail")) || len(fallback.Arguments.Nodes) != 1 || fallback.Arguments.Nodes[0].Kind != ast.KindIdentifier || fallback.Arguments.Nodes[0].Text() != name {
					return
				}
				add(node, "Recover task failures by tag", source(receiver)+".catchTags({ "+strings.Join(handlers, ", ")+" })")
				return
			}
			if method == "catchTag" && len(call.Arguments.Nodes) == 2 && receiver.Kind == ast.KindCallExpression {
				previous, base, _ := methodCall(receiver)
				if previous != "catchTag" {
					return
				}
				args := receiver.AsCallExpression().Arguments.Nodes
				if len(args) != 2 || args[0].Kind != ast.KindStringLiteral || call.Arguments.Nodes[0].Kind != ast.KindStringLiteral || args[0].Text() == call.Arguments.Nodes[0].Text() || !stable(args[1]) || !stable(call.Arguments.Nodes[1]) {
					return
				}
				// A previous handler may fail with the next tag; combining would skip that recovery.
				safe := true
				for _, signature := range c.GetCallSignatures(c.GetTypeAtLocation(args[1])) {
					for _, errorType := range resultErrorTypes(c, c.GetReturnTypeOfSignature(signature)) {
						var check func(*checker.Type)
						check = func(t *checker.Type) {
							if t.Flags()&checker.TypeFlagsUnionOrIntersection != 0 {
								for _, part := range t.Types() {
									check(part)
								}
								return
							}
							if isUnknownOrAnyType(t) {
								safe = false
								return
							}
							tag := propertyType(c, t, "_tag", node)
							if tag != nil {
								if c.IsTypeAssignableTo(c.GetTypeAtLocation(call.Arguments.Nodes[0]), tag) || tag.Flags()&checker.TypeFlagsStringLiteral == 0 {
									safe = false
								}
							} else if t.Flags()&checker.TypeFlagsNever == 0 {
								// Broad object/error types can hide a tagged subclass.
								safe = false
							}
						}
						check(errorType)
					}
				}
				if safe {
					add(node, "Combine tagged task recovery", source(base)+".catchTags({ "+source(args[0])+": "+source(args[1])+", "+source(call.Arguments.Nodes[0])+": "+source(call.Arguments.Nodes[1])+" })")
				}
			}
		})
	}
	return result, nil
}
