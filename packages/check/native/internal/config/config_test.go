package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadJSONCPluginOptions(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "tsconfig.json")
	contents := []byte(`{
    // Resultar native pilot
    "compilerOptions": {
      "plugins": [{
        "name": "resultar-check",
		"noAwaitInSafeTry": "suggestion",
        "noDiscard": "warning",
        "noDiscardMode": "direct",
        "noPromiseInResultSuccess": "error",
		"noThrow": "warning",
		"noTaggedErrorConstructorOverride": "error",
		"noTryCatch": "message",
		"noTryCatchInSafeTry": "off",
		"noUnsafeAwait": "warning",
		"noUnsafeAwaitIgnoreCalls": ["startServer", "fastify.after"],
		"noUnsafeAwaitMode": "all",
        "noUnknownResultError": "off",
		"noUselessRecovery": "error",
		"preferAndThen": "error",
		"preferCatchReason": "error",
		"preferFirstSuccessOf": "suggestion",
		"preferMap": "message",
		"preferMapErr": "off",
		"preferResultForEach": "suggestion",
		"preferTaggedError": "message",
		"taggedErrorNameMatch": "error",
		"typedCatchMapper": "error",
		"unsafeResultTypeAssertion": "suggestion",
		"yieldStarInSafeTry": "off",
		"yieldStarInResultTaskGen": "suggestion",
        "ignoreFilePatterns": ["*.test.ts", "tests/**", "scripts/**/*.ts"],
      }],
    },
  }`)
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	options, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if options.NoDiscard != SeverityWarning || options.NoDiscardMode != "direct" {
		t.Fatalf("unexpected no-discard options: %#v", options)
	}
	if options.NoAwaitInSafeTry != SeveritySuggestion || options.NoTaggedErrorConstructorOverride != SeverityError || options.NoTryCatchInSafeTry != SeverityOff {
		t.Fatalf("unexpected safeTry options: %#v", options)
	}
	if options.NoUnsafeAwait != SeverityWarning || options.NoUnsafeAwaitMode != "all" || len(options.NoUnsafeAwaitIgnoreCalls) != 2 {
		t.Fatalf("unexpected unsafe await options: %#v", options)
	}
	if options.NoPromiseInResultSuccess != SeverityError || options.NoUnknownResultError != SeverityOff {
		t.Fatalf("unexpected pilot rule options: %#v", options)
	}
	if options.NoUselessRecovery != SeverityError || options.UnsafeResultTypeAssertion != SeveritySuggestion {
		t.Fatalf("unexpected error channel options: %#v", options)
	}
	if options.NoThrow != SeverityWarning || options.NoTryCatch != SeverityMessage {
		t.Fatalf("unexpected structural rule options: %#v", options)
	}
	if options.PreferAndThen != SeverityError || options.PreferFirstSuccessOf != SeveritySuggestion ||
		options.PreferMap != SeverityMessage || options.PreferMapErr != SeverityOff || options.TypedCatchMapper != SeverityError {
		t.Fatalf("unexpected composition rule options: %#v", options)
	}
	if options.PreferCatchReason != SeverityError || options.PreferResultForEach != SeveritySuggestion ||
		options.YieldStarInSafeTry != SeverityOff || options.YieldStarInResultTaskGen != SeveritySuggestion {
		t.Fatalf("unexpected structural composition options: %#v", options)
	}
	if options.PreferTaggedError != SeverityMessage || options.TaggedErrorNameMatch != SeverityError {
		t.Fatalf("unexpected tagged error options: %#v", options)
	}
	if !options.ShouldInspect(filepath.Join(directory, "src", "index.ts"), directory) {
		t.Fatal("expected src/index.ts to be inspected")
	}
	if options.ShouldInspect(filepath.Join(directory, "src", "index.test.ts"), directory) {
		t.Fatal("expected *.test.ts to be ignored")
	}
	if options.ShouldInspect(filepath.Join(directory, "tests", "index.ts"), directory) {
		t.Fatal("expected tests/** to be ignored")
	}
	if options.ShouldInspect(filepath.Join(directory, "scripts", "smoke.ts"), directory) {
		t.Fatal("expected scripts/**/*.ts to match a direct child")
	}
	if options.ShouldInspect(filepath.Join(directory, "scripts", "nested", "smoke.ts"), directory) {
		t.Fatal("expected scripts/**/*.ts to match a nested child")
	}
}

func TestLoadInheritedPluginOptions(t *testing.T) {
	directory := t.TempDir()
	basePath := filepath.Join(directory, "base.json")
	childPath := filepath.Join(directory, "tsconfig.json")
	if err := os.WriteFile(basePath, []byte(`{
  "compilerOptions": {
    "plugins": [{
      "name": "resultar-check",
      "noThrow": "error",
      "ignoreFilePatterns": "src/generated.ts"
    }]
  }
}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(childPath, []byte(`{
  "extends": "./base.json",
  "compilerOptions": { "target": "ES2022" }
}`), 0o600); err != nil {
		t.Fatal(err)
	}

	options, err := Load(childPath)
	if err != nil {
		t.Fatal(err)
	}
	if options.NoThrow != SeverityError {
		t.Fatalf("expected inherited noThrow severity, got %q", options.NoThrow)
	}
	if options.ShouldInspect(filepath.Join(directory, "src", "generated.ts"), directory) {
		t.Fatal("expected inherited string ignoreFilePatterns to match")
	}
}

func TestLoadRejectsInvalidPluginOptions(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "tsconfig.json")
	if err := os.WriteFile(path, []byte(`{
  "compilerOptions": {
    "plugins": [{
      "name": "resultar-check",
      "noThrow": "fatal",
      "noDiscardMode": "invalid",
      "noUnsafeAwaitMode": "invalid"
    }]
  }
}`), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := Load(path); err == nil {
		t.Fatal("expected invalid Resultar plugin options to fail")
	}
}

func TestLoadRejectsNullPluginOptions(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "tsconfig.json")
	if err := os.WriteFile(path, []byte(`{
  "compilerOptions": {
    "plugins": [{
      "name": "resultar-check",
      "ignoreFilePatterns": null,
      "noUnsafeAwaitIgnoreCalls": null
    }]
  }
}`), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := Load(path); err == nil {
		t.Fatal("expected null Resultar plugin options to fail")
	}
}

func TestLoadDiagnosticSeverityAndOverrides(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "tsconfig.json")
	contents := []byte(`{
  "compilerOptions": {
    "plugins": [{
      "name": "resultar-check",
      "failOn": "error",
      "diagnosticSeverity": {
        "resultar/no-throw": "error",
        "prefer-map": "off"
      },
      "overrides": [{
        "include": ["src/**/*.test.ts"],
        "options": {
          "diagnosticSeverity": {
            "no-throw": "warning",
            "prefer-map": "suggestion"
          }
        }
      }]
    }]
  }
}`)
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	options, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if options.NoThrow != SeverityError || options.PreferMap != SeverityOff {
		t.Fatalf("unexpected global diagnosticSeverity: %#v", options)
	}
	if options.FailOn != SeverityError {
		t.Fatalf("unexpected failOn: %q", options.FailOn)
	}
	testFile := filepath.Join(directory, "src", "feature.test.ts")
	effective := options.ForFile(testFile, directory)
	if effective.NoThrow != SeverityWarning || effective.PreferMap != SeveritySuggestion {
		t.Fatalf("unexpected override options: %#v", effective)
	}
	other := options.ForFile(filepath.Join(directory, "src", "feature.ts"), directory)
	if other.NoThrow != SeverityError || other.PreferMap != SeverityOff {
		t.Fatalf("unexpected non-matching options: %#v", other)
	}
}

func TestFailOnSeverity(t *testing.T) {
	if !Fails(SeverityError, SeverityError) || Fails(SeverityWarning, SeverityError) {
		t.Fatal("unexpected error failOn semantics")
	}
	if !Fails(SeverityWarning, SeverityMessage) || Fails(SeverityOff, SeverityMessage) {
		t.Fatal("unexpected default failOn semantics")
	}
	if Fails(SeverityError, SeverityOff) {
		t.Fatal("off should never fail")
	}
}

func TestLoadRejectsUnknownDiagnosticRule(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "tsconfig.json")
	if err := os.WriteFile(path, []byte(`{
  "compilerOptions": {"plugins": [{
    "name": "resultar-check",
    "diagnosticSeverity": {"missing-rule": "warning"}
  }]}
}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("expected unknown diagnostic rule to fail")
	}
}
