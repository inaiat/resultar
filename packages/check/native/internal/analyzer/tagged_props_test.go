package analyzer

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/config"
	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/project"
)

func TestTaggedErrorWithPropsRules(t *testing.T) {
	const declarations = `
interface ErrorConstructor {
  new (...args: readonly unknown[]): Error
  withProps<Props>(): ErrorConstructor
  unrelated(): ErrorConstructor
}
declare function createTaggedError(options: { readonly name: string; readonly message: string }): ErrorConstructor
declare function unrelatedFactory(options: { readonly name: string; readonly message: string }): ErrorConstructor
`
	cases := []struct {
		name   string
		source string
		want   []string
	}{
		{
			name: "typed metadata preserves both guards",
			source: `class Missing extends createTaggedError({ name: "Other", message: "Missing" }).withProps<{ id: string }>() {
  constructor() { super() }
}`,
			want: []string{"tagged-error-name-match", "no-tagged-error-constructor-override"},
		},
		{
			name:   "valid typed class",
			source: `class Missing extends createTaggedError({ name: "Missing", message: "Missing" }).withProps<{ id: string }>() {}`,
		},
		{
			name: "matching name still rejects a constructor override",
			source: `class Missing extends createTaggedError({ name: "Missing", message: "Missing" }).withProps<{ id: string }>() {
  constructor() { super() }
}`,
			want: []string{"no-tagged-error-constructor-override"},
		},
		{
			name:   "parenthesized factory receiver",
			source: `class Missing extends (createTaggedError({ name: "Other", message: "Missing" })).withProps<{ id: string }>() {}`,
			want:   []string{"tagged-error-name-match"},
		},
		{
			name:   "metadata chain retains factory options",
			source: `class Missing extends createTaggedError({ name: "Other", message: "Missing" }).withProps<{ id: string }>().withProps<{ retry: number }>() {}`,
			want:   []string{"tagged-error-name-match"},
		},
		{
			name: "unrelated withProps factory is ignored",
			source: `class Missing extends unrelatedFactory({ name: "Other", message: "Missing" }).withProps<{ id: string }>() {
  constructor() { super() }
}`,
		},
		{
			name: "unsupported transformation is ignored",
			source: `class Missing extends createTaggedError({ name: "Other", message: "Missing" }).unrelated().withProps<{ id: string }>() {
  constructor() { super() }
}`,
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			directory := writeFixture(t, declarations+test.source)
			opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
			if err != nil || len(diagnostics) != 0 {
				t.Fatalf("open: %v %v", err, diagnostics)
			}
			options := config.Defaults()
			options.NoDiscard = config.SeverityOff
			findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
			if err != nil {
				t.Fatal(err)
			}
			if len(findings) != len(test.want) {
				t.Fatalf("got %d findings, want %d: %#v", len(findings), len(test.want), findings)
			}
			for index, rule := range test.want {
				if findings[index].Rule != rule {
					t.Errorf("finding %d = %s, want %s", index, findings[index].Rule, rule)
				}
			}
		})
	}
}
