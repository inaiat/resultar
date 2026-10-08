package project

import (
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/microsoft/typescript-go/internal/tspath"
	"github.com/microsoft/typescript-go/internal/vfs"
	"github.com/microsoft/typescript-go/internal/vfs/wrapvfs"
)

// overlayFS copies the editor snapshot and leaves the underlying filesystem untouched.
func overlayFS(base vfs.FS, overlay map[string]string) vfs.FS {
	normalize := func(path string) string {
		absolute, err := filepath.Abs(path)
		if err == nil {
			path = absolute
		}
		path = tspath.NormalizePath(path)
		if !base.UseCaseSensitiveFileNames() {
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
		ReadFile: func(path string) (string, bool) {
			if text, ok := files[normalize(path)]; ok {
				return text, true
			}
			return base.ReadFile(path)
		},
		FileExists:      func(path string) bool { _, ok := files[normalize(path)]; return ok || base.FileExists(path) },
		DirectoryExists: func(path string) bool { _, ok := directories[normalize(path)]; return ok || base.DirectoryExists(path) },
		GetAccessibleEntries: func(path string) vfs.Entries {
			entry := base.GetAccessibleEntries(path)
			virtual := directories[normalize(path)]
			entry.Files = unique(append(append([]string{}, entry.Files...), virtual.Files...))
			entry.Directories = unique(append(append([]string{}, entry.Directories...), virtual.Directories...))
			return entry
		},
		Stat: func(path string) vfs.FileInfo {
			if text, ok := files[normalize(path)]; ok {
				return overlayInfo{name: filepath.Base(path), size: int64(len(text))}
			}
			if _, ok := directories[normalize(path)]; ok && !base.DirectoryExists(path) {
				return overlayInfo{name: filepath.Base(path), directory: true}
			}
			return base.Stat(path)
		},
		Realpath: func(path string) string {
			normalized := normalize(path)
			if _, ok := files[normalized]; ok {
				return names[normalized]
			}
			if _, ok := directories[normalized]; ok && !base.DirectoryExists(path) {
				return names[normalized]
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
