package project

import (
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/microsoft/TypeScript/tsc/internal/tspath"
	"github.com/microsoft/TypeScript/tsc/internal/vfs"
	"github.com/microsoft/TypeScript/tsc/internal/vfs/wrapvfs"
)

// overlayFS copies the editor snapshot and leaves the underlying filesystem untouched.
func overlayFS(base vfs.FS, overlay map[string]string) vfs.FS {
	normalize := func(path string) string {
		absolute, err := filepath.Abs(path)
		if err == nil {
			path = absolute
		}
		path = tspath.NormalizePath(path)
		if !base.CaseSensitivity().IsCaseSensitive() {
			path = strings.ToLower(path)
		}
		return path
	}
	names := map[string]string{}
	files := map[string]string{}
	directories := map[string]vfs.Entries{}
	for path, text := range overlay {
		absolute, _ := filepath.Abs(path)
		path = tspath.NormalizePath(absolute)
		names[normalize(path)] = path
		files[normalize(path)] = text
		parent := tspath.GetDirectoryPath(path)
		entry := directories[normalize(parent)]
		entry.Files = append(entry.Files, filepath.Base(path))
		directories[normalize(parent)] = entry
		names[normalize(parent)] = parent
		for current := parent; ; {
			next := tspath.GetDirectoryPath(current)
			if next == current || next == "" {
				break
			}
			entry = directories[normalize(next)]
			entry.Directories = append(entry.Directories, filepath.Base(current))
			directories[normalize(next)] = entry
			names[normalize(next)] = next
			current = next
		}
	}
	unique := func(values []string) []string {
		set := map[string]bool{}
		for _, value := range values {
			set[value] = true
		}
		result := make([]string, 0, len(set))
		for value := range set {
			result = append(result, value)
		}
		sort.Strings(result)
		return result
	}
	return wrapvfs.Wrap(base, wrapvfs.Replacements{
		ReadFile: func(path tspath.RootedFilePath) (string, bool) {
			if text, ok := files[normalize(string(path))]; ok {
				return text, true
			}
			return base.ReadFile(path)
		},
		FileExists:      func(path tspath.RootedFilePath) bool { _, ok := files[normalize(string(path))]; return ok || base.FileExists(path) },
		DirectoryExists: func(path tspath.RootedDirectoryPath) bool { _, ok := directories[normalize(string(path))]; return ok || base.DirectoryExists(path) },
		GetAccessibleEntries: func(path tspath.RootedDirectoryPath) vfs.Entries {
			entry := base.GetAccessibleEntries(path)
			virtual := directories[normalize(string(path))]
			entry.Files = unique(append(append([]string{}, entry.Files...), virtual.Files...))
			entry.Directories = unique(append(append([]string{}, entry.Directories...), virtual.Directories...))
			return entry
		},
		Stat: func(path tspath.RootedPath) vfs.FileInfo {
			raw := string(path)
			if text, ok := files[normalize(raw)]; ok {
				return overlayInfo{name: filepath.Base(raw), size: int64(len(text))}
			}
			if _, ok := directories[normalize(raw)]; ok && !base.DirectoryExists(tspath.RootedDirectoryPathFromPath(path)) {
				return overlayInfo{name: filepath.Base(raw), directory: true}
			}
			return base.Stat(path)
		},
		Realpath: func(path tspath.RootedPath) tspath.RootedPath {
			normalized := normalize(string(path))
			if _, ok := files[normalized]; ok {
				return tspath.RootedPathFromNormalized(names[normalized])
			}
			if _, ok := directories[normalized]; ok && !base.DirectoryExists(tspath.RootedDirectoryPathFromPath(path)) {
				return tspath.RootedPathFromNormalized(names[normalized])
			}
			return base.Realpath(path)
		},
	})
}

type overlayInfo struct {
	name      string
	size      int64
	directory bool
}

func (i overlayInfo) Name() string { return i.name }
func (i overlayInfo) Size() int64  { return i.size }
func (i overlayInfo) Mode() fs.FileMode {
	if i.directory {
		return fs.ModeDir | 0755
	}
	return 0644
}
func (i overlayInfo) ModTime() time.Time { return time.Time{} }
func (i overlayInfo) IsDir() bool        { return i.directory }
func (i overlayInfo) Sys() any           { return nil }
