package project

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/bundled"
	"github.com/microsoft/typescript-go/internal/compiler"
	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/tsoptions"
	"github.com/microsoft/typescript-go/internal/tspath"
	"github.com/microsoft/typescript-go/internal/vfs/cachedvfs"
	"github.com/microsoft/typescript-go/internal/vfs/osvfs"
)

type Opened struct {
	ConfigPath string
	Directory  string
	Program    *compiler.Program
}

func Open(configPath string) (*Opened, []*ast.Diagnostic, error) {
	absolutePath, err := filepath.Abs(configPath)
	if err != nil {
		return nil, nil, err
	}
	absolutePath = tspath.NormalizePath(absolutePath)
	if info, err := os.Stat(absolutePath); err == nil && info.IsDir() {
		absolutePath = filepath.Join(absolutePath, "tsconfig.json")
	}
	directory := tspath.GetDirectoryPath(absolutePath)
	fs := bundled.WrapFS(cachedvfs.From(osvfs.FS()))
	host := compiler.NewCompilerHost(directory, fs, bundled.LibPath(), nil, nil)
	parsed, diagnostics := tsoptions.GetParsedCommandLineOfConfigFile(
		absolutePath,
		&core.CompilerOptions{},
		nil,
		host,
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
		Config:                      parsed,
		Host:                        host,
		SingleThreaded:              core.TSTrue,
		UseSourceOfProjectReference: true,
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
