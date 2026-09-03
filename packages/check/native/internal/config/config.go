package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type Severity string

const (
	SeverityError      Severity = "error"
	SeverityMessage    Severity = "message"
	SeverityOff        Severity = "off"
	SeveritySuggestion Severity = "suggestion"
	SeverityWarning    Severity = "warning"
)

type Options struct {
	IgnoreFilePatterns               []string
	Overrides                        []FileOverride
	FailOn                           Severity
	NoDiscard                        Severity
	NoDiscardMode                    string
	NoAwaitInSafeTry                 Severity
	NoPromiseInResultSuccess         Severity
	NoTaggedErrorConstructorOverride Severity
	NoThrow                          Severity
	NoTryCatch                       Severity
	NoTryCatchInSafeTry              Severity
	NoUnsafeAwait                    Severity
	NoUnsafeAwaitIgnoreCalls         []string
	NoUnsafeAwaitMode                string
	NoUnknownResultError             Severity
	NoUselessRecovery                Severity
	PreferAndThen                    Severity
	PreferCatchReason                Severity
	PreferFirstSuccessOf             Severity
	PreferMap                        Severity
	PreferMapErr                     Severity
	PreferResultForEach              Severity
	PreferTaggedError                Severity
	TaggedErrorNameMatch             Severity
	TypedCatchMapper                 Severity
	UnsafeResultTypeAssertion        Severity
	YieldStarInSafeTry               Severity
	YieldStarInResultTaskGen         Severity
}

// FileOverride applies diagnostic severities to files matching one of its
// include patterns. Patterns use the same glob syntax as ignoreFilePatterns.
type FileOverride struct {
	Include            []string
	DiagnosticSeverity map[string]Severity
}

type tsconfig struct {
	Extends         any              `json:"extends"`
	CompilerOptions *compilerOptions `json:"compilerOptions"`
}

type compilerOptions struct {
	Plugins *[]map[string]any `json:"plugins"`
}

func Defaults() Options {
	return Options{
		NoAwaitInSafeTry:                 SeverityError,
		NoDiscard:                        SeverityError,
		NoDiscardMode:                    "must-use",
		NoPromiseInResultSuccess:         SeverityWarning,
		NoTaggedErrorConstructorOverride: SeverityWarning,
		NoThrow:                          SeverityOff,
		NoTryCatch:                       SeverityOff,
		NoTryCatchInSafeTry:              SeverityWarning,
		NoUnsafeAwait:                    SeverityOff,
		NoUnsafeAwaitMode:                "resultar-context",
		NoUnknownResultError:             SeveritySuggestion,
		NoUselessRecovery:                SeverityWarning,
		PreferAndThen:                    SeverityWarning,
		PreferCatchReason:                SeverityWarning,
		PreferFirstSuccessOf:             SeverityWarning,
		PreferMap:                        SeverityWarning,
		PreferMapErr:                     SeverityWarning,
		PreferResultForEach:              SeverityWarning,
		PreferTaggedError:                SeverityWarning,
		TaggedErrorNameMatch:             SeverityWarning,
		TypedCatchMapper:                 SeverityWarning,
		UnsafeResultTypeAssertion:        SeverityWarning,
		YieldStarInSafeTry:               SeverityWarning,
		YieldStarInResultTaskGen:         SeverityWarning,
		FailOn:                           SeverityMessage,
	}
}

func Load(path string) (Options, error) {
	plugins, err := loadPlugins(path, make(map[string]bool))
	if err != nil {
		return Defaults(), err
	}

	options := Defaults()
	for _, plugin := range plugins {
		if plugin["name"] != "resultar-check" {
			continue
		}
		if err := applyPlugin(&options, plugin); err != nil {
			return Defaults(), err
		}
		break
	}

	return options, nil
}

func loadPlugins(path string, stack map[string]bool) ([]map[string]any, error) {
	absolutePath, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	absolutePath = filepath.Clean(absolutePath)
	if stack[absolutePath] {
		return nil, fmt.Errorf("circular tsconfig extends chain at %s", absolutePath)
	}
	stack[absolutePath] = true
	defer delete(stack, absolutePath)

	contents, err := os.ReadFile(absolutePath)
	if err != nil {
		return nil, err
	}

	var raw tsconfig
	if err := json.Unmarshal(normalizeJSONC(contents), &raw); err != nil {
		return nil, fmt.Errorf("parse %s: %w", absolutePath, err)
	}

	var plugins []map[string]any
	parents, err := extendsPaths(raw.Extends)
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", absolutePath, err)
	}
	for _, parent := range parents {
		parentPath, err := resolveExtendsPath(absolutePath, parent)
		if err != nil {
			return nil, err
		}
		plugins, err = loadPlugins(parentPath, stack)
		if err != nil {
			return nil, err
		}
	}
	if raw.CompilerOptions != nil && raw.CompilerOptions.Plugins != nil {
		plugins = *raw.CompilerOptions.Plugins
	}
	return plugins, nil
}

func extendsPaths(value any) ([]string, error) {
	switch value := value.(type) {
	case nil:
		return nil, nil
	case string:
		if value == "" {
			return nil, fmt.Errorf("extends must not be empty")
		}
		return []string{value}, nil
	case []any:
		paths := make([]string, 0, len(value))
		for _, item := range value {
			path, ok := item.(string)
			if !ok || path == "" {
				return nil, fmt.Errorf("extends entries must be non-empty strings")
			}
			paths = append(paths, path)
		}
		return paths, nil
	default:
		return nil, fmt.Errorf("extends must be a string or an array of strings")
	}
}

func resolveExtendsPath(configPath, extension string) (string, error) {
	candidates := make([]string, 0, 6)
	appendCandidates := func(base string) {
		candidates = append(candidates, base)
		if filepath.Ext(base) != ".json" {
			candidates = append(candidates, base+".json")
		}
		candidates = append(candidates, filepath.Join(base, "tsconfig.json"))
	}

	if filepath.IsAbs(extension) || strings.HasPrefix(extension, ".") {
		appendCandidates(filepath.Join(filepath.Dir(configPath), extension))
	} else {
		for directory := filepath.Dir(configPath); ; directory = filepath.Dir(directory) {
			appendCandidates(filepath.Join(directory, "node_modules", extension))
			parent := filepath.Dir(directory)
			if parent == directory {
				break
			}
		}
	}

	for _, candidate := range candidates {
		info, err := os.Stat(candidate)
		if err == nil && !info.IsDir() {
			absolute, err := filepath.Abs(candidate)
			if err != nil {
				return "", err
			}
			return filepath.Clean(absolute), nil
		}
	}
	return "", fmt.Errorf("cannot resolve tsconfig extends %q from %s", extension, configPath)
}

func applyPlugin(options *Options, plugin map[string]any) error {
	var err error
	if value, ok := plugin["ignoreFilePatterns"]; ok {
		if options.IgnoreFilePatterns, err = filePatterns(value); err != nil {
			return fmt.Errorf("ignoreFilePatterns: %w", err)
		}
	}
	if err := setSeverity(plugin, "failOn", &options.FailOn); err != nil {
		return err
	}
	if value, ok := plugin["diagnosticSeverity"]; ok {
		if err := applyDiagnosticSeverity(options, value, "diagnosticSeverity"); err != nil {
			return err
		}
	}
	if value, ok := plugin["overrides"]; ok {
		if err := applyOverrides(options, value); err != nil {
			return fmt.Errorf("overrides: %w", err)
		}
	}
	if err := setSeverity(plugin, "noAwaitInSafeTry", &options.NoAwaitInSafeTry); err != nil {
		return err
	}
	if err := setSeverity(plugin, "noDiscard", &options.NoDiscard); err != nil {
		return err
	}
	if err := setSeverity(plugin, "noPromiseInResultSuccess", &options.NoPromiseInResultSuccess); err != nil {
		return err
	}
	if err := setSeverity(plugin, "noTaggedErrorConstructorOverride", &options.NoTaggedErrorConstructorOverride); err != nil {
		return err
	}
	if err := setSeverity(plugin, "noThrow", &options.NoThrow); err != nil {
		return err
	}
	if err := setSeverity(plugin, "noTryCatch", &options.NoTryCatch); err != nil {
		return err
	}
	if err := setSeverity(plugin, "noTryCatchInSafeTry", &options.NoTryCatchInSafeTry); err != nil {
		return err
	}
	if err := setSeverity(plugin, "noUnsafeAwait", &options.NoUnsafeAwait); err != nil {
		return err
	}
	if value, ok := plugin["noUnsafeAwaitIgnoreCalls"]; ok {
		if options.NoUnsafeAwaitIgnoreCalls, err = callPaths(value); err != nil {
			return fmt.Errorf("noUnsafeAwaitIgnoreCalls: %w", err)
		}
	}
	if value, ok := plugin["noUnsafeAwaitMode"]; ok {
		mode, ok := value.(string)
		if !ok || (mode != "resultar-context" && mode != "all") {
			return fmt.Errorf("noUnsafeAwaitMode must be \"resultar-context\" or \"all\"")
		}
		options.NoUnsafeAwaitMode = mode
	}
	if err := setSeverity(plugin, "noUnknownResultError", &options.NoUnknownResultError); err != nil {
		return err
	}
	if err := setSeverity(plugin, "noUselessRecovery", &options.NoUselessRecovery); err != nil {
		return err
	}
	if err := setSeverity(plugin, "preferAndThen", &options.PreferAndThen); err != nil {
		return err
	}
	if err := setSeverity(plugin, "preferCatchReason", &options.PreferCatchReason); err != nil {
		return err
	}
	if err := setSeverity(plugin, "preferFirstSuccessOf", &options.PreferFirstSuccessOf); err != nil {
		return err
	}
	if err := setSeverity(plugin, "preferMap", &options.PreferMap); err != nil {
		return err
	}
	if err := setSeverity(plugin, "preferMapErr", &options.PreferMapErr); err != nil {
		return err
	}
	if err := setSeverity(plugin, "preferResultForEach", &options.PreferResultForEach); err != nil {
		return err
	}
	if err := setSeverity(plugin, "preferTaggedError", &options.PreferTaggedError); err != nil {
		return err
	}
	if err := setSeverity(plugin, "taggedErrorNameMatch", &options.TaggedErrorNameMatch); err != nil {
		return err
	}
	if err := setSeverity(plugin, "typedCatchMapper", &options.TypedCatchMapper); err != nil {
		return err
	}
	if err := setSeverity(plugin, "unsafeResultTypeAssertion", &options.UnsafeResultTypeAssertion); err != nil {
		return err
	}
	if err := setSeverity(plugin, "yieldStarInSafeTry", &options.YieldStarInSafeTry); err != nil {
		return err
	}
	if err := setSeverity(plugin, "yieldStarInResultTaskGen", &options.YieldStarInResultTaskGen); err != nil {
		return err
	}
	if value, ok := plugin["noDiscardMode"]; ok {
		mode, ok := value.(string)
		if !ok || (mode != "must-use" && mode != "direct") {
			return fmt.Errorf("noDiscardMode must be \"must-use\" or \"direct\"")
		}
		options.NoDiscardMode = mode
	}
	return nil
}

func applyDiagnosticSeverity(options *Options, value any, name string) error {
	values, ok := value.(map[string]any)
	if !ok || value == nil {
		return fmt.Errorf("%s must be an object mapping rule names to severities", name)
	}
	for rule, rawSeverity := range values {
		parsed, err := severity(rawSeverity, SeverityOff, name+"."+rule)
		if err != nil {
			return err
		}
		if err := setRuleSeverity(options, rule, parsed); err != nil {
			return err
		}
	}
	return nil
}

func applyOverrides(options *Options, value any) error {
	items, ok := value.([]any)
	if !ok || value == nil {
		return fmt.Errorf("must be an array of objects")
	}
	for index, item := range items {
		object, ok := item.(map[string]any)
		if !ok || item == nil {
			return fmt.Errorf("entry %d must be an object", index)
		}
		include, ok := object["include"]
		if !ok {
			return fmt.Errorf("entry %d must define include", index)
		}
		patterns, err := filePatterns(include)
		if err != nil {
			return fmt.Errorf("entry %d include: %w", index, err)
		}
		rawOptions, ok := object["options"]
		if !ok {
			return fmt.Errorf("entry %d must define options", index)
		}
		optionsObject, ok := rawOptions.(map[string]any)
		if !ok || rawOptions == nil {
			return fmt.Errorf("entry %d options must be an object", index)
		}
		rawSeverity, ok := optionsObject["diagnosticSeverity"]
		if !ok {
			return fmt.Errorf("entry %d options must define diagnosticSeverity", index)
		}
		severityMap, ok := rawSeverity.(map[string]any)
		if !ok || rawSeverity == nil {
			return fmt.Errorf("entry %d options.diagnosticSeverity must be an object", index)
		}
		parsed := make(map[string]Severity, len(severityMap))
		for rule, raw := range severityMap {
			severityValue, err := severity(raw, SeverityOff, fmt.Sprintf("overrides[%d].options.diagnosticSeverity.%s", index, rule))
			if err != nil {
				return err
			}
			if !knownRule(rule) {
				return fmt.Errorf("unknown diagnostic rule %q", rule)
			}
			parsed[canonicalRule(rule)] = severityValue
		}
		options.Overrides = append(options.Overrides, FileOverride{Include: patterns, DiagnosticSeverity: parsed})
	}
	return nil
}

func knownRule(name string) bool {
	_, ok := ruleNames[canonicalRule(name)]
	return ok
}

func canonicalRule(name string) string {
	name = strings.TrimSpace(name)
	if strings.Contains(name, "/") {
		name = strings.TrimPrefix(name, "resultar/")
	}
	var result strings.Builder
	for _, character := range name {
		if character == '-' || character == '_' || character == ' ' {
			continue
		}
		result.WriteRune(character)
	}
	return strings.ToLower(result.String())
}

var ruleNames = map[string]struct{}{
	"noawaitinsafetry": {}, "nodiscard": {}, "nopromiseinresultsuccess": {},
	"notaggederrorconstructoroverride": {}, "nothrow": {}, "notrycatch": {},
	"notrycatchinsafetry": {}, "nounknownresulterror": {}, "nouselessrecovery": {},
	"nounsafeawait": {}, "preferandthen": {}, "prefercatchreason": {},
	"preferfirstsuccessof": {}, "prefermap": {}, "prefermaperr": {},
	"preferresultforeach": {}, "prefertaggederror": {}, "taggederrornamematch": {},
	"typedcatchmapper": {}, "unsaferesulttypeassertion": {}, "yieldstarinsafetry": {},
	"yieldstarinresulttaskgen": {},
}

func setRuleSeverity(options *Options, name string, value Severity) error {
	switch canonicalRule(name) {
	case "noawaitinsafetry":
		options.NoAwaitInSafeTry = value
	case "nodiscard":
		options.NoDiscard = value
	case "nopromiseinresultsuccess":
		options.NoPromiseInResultSuccess = value
	case "notaggederrorconstructoroverride":
		options.NoTaggedErrorConstructorOverride = value
	case "nothrow":
		options.NoThrow = value
	case "notrycatch":
		options.NoTryCatch = value
	case "notrycatchinsafetry":
		options.NoTryCatchInSafeTry = value
	case "nounsafeawait":
		options.NoUnsafeAwait = value
	case "nounknownresulterror":
		options.NoUnknownResultError = value
	case "nouselessrecovery":
		options.NoUselessRecovery = value
	case "preferandthen":
		options.PreferAndThen = value
	case "prefercatchreason":
		options.PreferCatchReason = value
	case "preferfirstsuccessof":
		options.PreferFirstSuccessOf = value
	case "prefermap":
		options.PreferMap = value
	case "prefermaperr":
		options.PreferMapErr = value
	case "preferresultforeach":
		options.PreferResultForEach = value
	case "prefertaggederror":
		options.PreferTaggedError = value
	case "taggederrornamematch":
		options.TaggedErrorNameMatch = value
	case "typedcatchmapper":
		options.TypedCatchMapper = value
	case "unsaferesulttypeassertion":
		options.UnsafeResultTypeAssertion = value
	case "yieldstarinsafetry":
		options.YieldStarInSafeTry = value
	case "yieldstarinresulttaskgen":
		options.YieldStarInResultTaskGen = value
	default:
		return fmt.Errorf("unknown diagnostic rule %q", name)
	}
	return nil
}

func setSeverity(plugin map[string]any, name string, target *Severity) error {
	value, ok := plugin[name]
	if !ok {
		return nil
	}
	parsed, err := severity(value, *target, name)
	if err != nil {
		return err
	}
	*target = parsed
	return nil
}

func (o Options) ShouldInspect(fileName, projectDir string) bool {
	normalized := filepath.ToSlash(fileName)
	if strings.Contains(normalized, "/node_modules/") || strings.HasSuffix(normalized, ".d.ts") {
		return false
	}

	relative, err := filepath.Rel(projectDir, fileName)
	if err != nil {
		relative = fileName
	}
	relative = filepath.ToSlash(relative)
	base := filepath.Base(relative)
	for _, pattern := range o.IgnoreFilePatterns {
		if globMatch(pattern, relative) || globMatch(pattern, base) {
			return false
		}
	}
	return true
}

// ForFile returns the effective options for a specific source file. Overrides
// are applied in declaration order, so later matching entries win.
func (o Options) ForFile(fileName, projectDir string) Options {
	result := o
	result.IgnoreFilePatterns = append([]string(nil), o.IgnoreFilePatterns...)
	result.NoUnsafeAwaitIgnoreCalls = append([]string(nil), o.NoUnsafeAwaitIgnoreCalls...)
	result.Overrides = nil
	relative, err := filepath.Rel(projectDir, fileName)
	if err != nil {
		relative = fileName
	}
	relative = filepath.ToSlash(relative)
	base := filepath.Base(relative)
	for _, override := range o.Overrides {
		matched := false
		for _, pattern := range override.Include {
			if globMatch(pattern, relative) || globMatch(pattern, base) {
				matched = true
				break
			}
		}
		if !matched {
			continue
		}
		for rule, severity := range override.DiagnosticSeverity {
			_ = setRuleSeverity(&result, rule, severity)
		}
	}
	return result
}

// Fails reports whether a diagnostic at severity should make the process fail.
// The default failOn value is message, preserving the historical behaviour of
// failing for every enabled Resultar diagnostic.
func Fails(severity, failOn Severity) bool {
	return severityRank(failOn) > 0 && severityRank(severity) >= severityRank(failOn)
}

func severityRank(value Severity) int {
	switch value {
	case SeverityError:
		return 4
	case SeverityWarning:
		return 3
	case SeveritySuggestion:
		return 2
	case SeverityMessage:
		return 1
	default:
		return 0
	}
}

func severity(value any, fallback Severity, name string) (Severity, error) {
	if value == nil {
		return fallback, fmt.Errorf("%s must be a severity string", name)
	}
	text, ok := value.(string)
	if !ok {
		return fallback, fmt.Errorf("%s must be a severity string", name)
	}
	switch Severity(text) {
	case SeverityError, SeverityMessage, SeverityOff, SeveritySuggestion, SeverityWarning:
		return Severity(text), nil
	default:
		return fallback, fmt.Errorf("%s has invalid severity %q", name, text)
	}
}

func filePatterns(value any) ([]string, error) {
	if value == nil {
		return nil, fmt.Errorf("must be a string or an array of strings")
	}
	if text, ok := value.(string); ok {
		if text == "" {
			return nil, fmt.Errorf("must not contain an empty pattern")
		}
		return []string{text}, nil
	}
	return stringArray(value, "must be a string or an array of strings")
}

func callPaths(value any) ([]string, error) {
	paths, err := stringArray(value, "must be an array of strings")
	if err != nil {
		return nil, err
	}
	for _, path := range paths {
		if !regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$`).MatchString(path) {
			return nil, fmt.Errorf("invalid call path %q", path)
		}
	}
	return paths, nil
}

func stringArray(value any, typeError string) ([]string, error) {
	if value == nil {
		return nil, fmt.Errorf("%s", typeError)
	}
	values, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("%s", typeError)
	}
	result := make([]string, 0, len(values))
	for _, value := range values {
		text, ok := value.(string)
		if !ok || text == "" {
			return nil, fmt.Errorf("must contain only non-empty strings")
		}
		result = append(result, text)
	}
	return result, nil
}

func globMatch(pattern, value string) bool {
	pattern = filepath.ToSlash(pattern)
	var expression strings.Builder
	expression.WriteByte('^')
	for index := 0; index < len(pattern); index++ {
		switch pattern[index] {
		case '*':
			if index+1 < len(pattern) && pattern[index+1] == '*' {
				if index+2 < len(pattern) && pattern[index+2] == '/' {
					expression.WriteString("(?:.*/)?")
					index += 2
				} else {
					expression.WriteString(".*")
					index++
				}
			} else {
				expression.WriteString("[^/]*")
			}
		case '?':
			expression.WriteString("[^/]")
		default:
			expression.WriteString(regexp.QuoteMeta(string(pattern[index])))
		}
	}
	expression.WriteByte('$')
	matched, err := regexp.MatchString(expression.String(), filepath.ToSlash(value))
	return err == nil && matched
}

func normalizeJSONC(contents []byte) []byte {
	text := string(contents)
	var result strings.Builder
	result.Grow(len(text))
	inString := false
	escaped := false
	for index := 0; index < len(text); index++ {
		char := text[index]
		if inString {
			result.WriteByte(char)
			if escaped {
				escaped = false
			} else if char == '\\' {
				escaped = true
			} else if char == '"' {
				inString = false
			}
			continue
		}
		if char == '"' {
			inString = true
			result.WriteByte(char)
			continue
		}
		if char == '/' && index+1 < len(text) && text[index+1] == '/' {
			for index < len(text) && text[index] != '\n' {
				index++
			}
			result.WriteByte('\n')
			continue
		}
		if char == '/' && index+1 < len(text) && text[index+1] == '*' {
			index += 2
			for index+1 < len(text) && !(text[index] == '*' && text[index+1] == '/') {
				if text[index] == '\n' {
					result.WriteByte('\n')
				}
				index++
			}
			index++
			continue
		}
		result.WriteByte(char)
	}

	withoutTrailingCommas := regexp.MustCompile(`,\s*([}\]])`).ReplaceAllString(result.String(), "$1")
	return []byte(withoutTrailingCommas)
}
