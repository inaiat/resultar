package project

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/microsoft/TypeScript/tsc/internal/ast"
	"github.com/microsoft/TypeScript/tsc/internal/bundled"
	"github.com/microsoft/TypeScript/tsc/internal/compiler"
	"github.com/microsoft/TypeScript/tsc/internal/core"
	"github.com/microsoft/TypeScript/tsc/internal/tsoptions"
	"github.com/microsoft/TypeScript/tsc/internal/tspath"
	"github.com/microsoft/TypeScript/tsc/internal/vfs/cachedvfs"
	"github.com/microsoft/TypeScript/tsc/internal/vfs/osvfs"
)

type Opened struct {
	ConfigPath string
	Directory  string
	Program    *compiler.Program
}

func Open(configPath string) (*Opened, []*ast.Diagnostic, error) {
	return OpenWithOverlay(configPath, nil)
}

// OpenWithOverlay binds a fresh program against an immutable editor snapshot.
func OpenWithOverlay(configPath string, overlay map[string]string) (*Opened, []*ast.Diagnostic, error) {
	absolutePath, err := filepath.Abs(configPath)
	if err != nil {
		return nil, nil, err
	}
	absolutePath = tspath.NormalizePath(absolutePath)
	if info, err := os.Stat(absolutePath); err == nil && info.IsDir() {
		absolutePath = filepath.Join(absolutePath, "tsconfig.json")
	}
	directory := tspath.GetDirectoryPath(absolutePath)
	fs := bundled.WrapFS(cachedvfs.From(overlayFS(osvfs.FS(), overlay)))
	host := compiler.NewCompilerHost(fs, bundled.LibPath(), nil, nil, nil)
	parsed, diagnostics := tsoptions.GetParsedCommandLineOfConfigFile(
		tspath.RootedFilePathFromNormalized(tspath.NormalizePath(absolutePath)),
		&core.CompilerOptions{},
		nil,
		fs,
		nil,
	)
	if len(diagnostics) > 0 {
		return nil, diagnostics, nil
	}
	if parsed == nil {
		return nil, nil, fmt.Errorf("unable to parse TypeScript project %s", absolutePath)
	}
	if len(parsed.Errors) > 0 {
		return nil, parsed.Errors, nil
	}

	program := compiler.NewProgram(compiler.ProgramOptions{
		ProgramConfig: compiler.ProgramConfig{
			Config:                      parsed,
			SingleThreaded:              core.TSTrue,
			UseSourceOfProjectReference: true,
		},
		ProgramHosts: compiler.ProgramHosts{
			Host: host,
		},
	})
	if program == nil {
		return nil, nil, fmt.Errorf("unable to create TypeScript program %s", absolutePath)
	}
	if diagnostics := program.GetProgramDiagnostics(); len(diagnostics) > 0 {
		return nil, diagnostics, nil
	}
	program.BindSourceFiles()

	return &Opened{ConfigPath: absolutePath, Directory: directory, Program: program}, nil, nil
}
