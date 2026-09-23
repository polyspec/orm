package ormgen

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// The Go generator writes every round into a temporary directory beside the
// output directory. The scan reads those files through a go/packages overlay
// of the output directory, and the output directory changes only after the
// scan converges.

// ConsumerError reports scanned packages that do not compile with the
// generated models. The output directory holds the complete generated models
// when generation returns it.
type ConsumerError struct {
	Errors []string
}

func (e *ConsumerError) Error() string {
	return "the scanned packages do not compile with the generated models:\n" + listErrors(e.Errors)
}

// listErrors joins sorted, distinct errors and names the number of errors
// beyond the first twenty.
func listErrors(errs []string) string {
	errs = slices.Compact(slices.Sorted(slices.Values(errs)))
	if len(errs) > 20 {
		errs = append(errs[:20:20], fmt.Sprintf("and %d more errors", len(errs)-20))
	}
	return strings.Join(errs, "\n")
}

// unchanged describes a failure that left the output directory unchanged.
func unchanged(out string, err error) error {
	return fmt.Errorf("model generation failed; %s is unchanged:\n%w", out, err)
}

// goFiles returns the names of the Go files of dir; with generated set, only
// the files that start with the generated header. A missing dir has no files.
func goFiles(dir string, generated bool) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var names []string
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".go" {
			continue
		}
		if generated {
			b, err := os.ReadFile(filepath.Join(dir, entry.Name()))
			if err != nil {
				return nil, err
			}
			if !bytes.HasPrefix(b, []byte(generatedHeader)) {
				continue
			}
		}
		names = append(names, entry.Name())
	}
	return names, nil
}

// overlay maps the Go files of the output directory to the files written in
// the temporary directory. A generated file of the output directory that the
// generation no longer writes maps to a file with only its package clause.
func (g *goGen) overlay() (map[string][]byte, error) {
	names, err := goFiles(g.tmp, false)
	if err != nil {
		return nil, err
	}
	files := map[string][]byte{}
	for _, name := range names {
		b, err := os.ReadFile(filepath.Join(g.tmp, name))
		if err != nil {
			return nil, err
		}
		files[filepath.Join(g.outDir, name)] = b
	}
	previous, err := goFiles(g.outDir, true)
	if err != nil {
		return nil, err
	}
	for _, name := range previous {
		if path := filepath.Join(g.outDir, name); files[path] == nil {
			files[path] = []byte(generatedHeader + "\npackage " + g.pkg + "\n")
		}
	}
	return files, nil
}

// replace moves the files of the temporary directory into the output
// directory. The previous generated files, and a hand-written file that a new
// file replaces, first move into the temporary directory and move back when a
// later move fails, so the output directory holds either the previous or the
// new generated files.
func (g *goGen) replace() error {
	names, err := goFiles(g.tmp, false)
	if err != nil {
		return unchanged(g.out, err)
	}
	previous, err := goFiles(g.outDir, true)
	if err != nil {
		return unchanged(g.out, err)
	}
	for _, name := range names {
		_, err := os.Lstat(filepath.Join(g.outDir, name))
		switch {
		case err == nil && !slices.Contains(previous, name):
			previous = append(previous, name)
		case err != nil && !errors.Is(err, os.ErrNotExist):
			return unchanged(g.out, err)
		}
	}
	backup := filepath.Join(g.tmp, "previous")
	if err := os.Mkdir(backup, 0o700); err != nil {
		return unchanged(g.out, err)
	}
	_, err = os.Stat(g.outDir)
	created := errors.Is(err, os.ErrNotExist)
	if err := os.MkdirAll(g.outDir, 0o755); err != nil {
		return unchanged(g.out, err)
	}
	var moved, placed []string
	restore := func(cause error) error {
		var errs []error
		for _, name := range placed {
			errs = append(errs, os.Remove(filepath.Join(g.outDir, name)))
		}
		for _, name := range moved {
			errs = append(errs, os.Rename(filepath.Join(backup, name), filepath.Join(g.outDir, name)))
		}
		if created {
			errs = append(errs, os.Remove(g.outDir))
		}
		if err := errors.Join(errs...); err != nil {
			return fmt.Errorf("replace the generated files of %s: %w\nrestoring the previous files failed: %v", g.out, cause, err)
		}
		return unchanged(g.out, cause)
	}
	for _, name := range previous {
		if err := os.Rename(filepath.Join(g.outDir, name), filepath.Join(backup, name)); err != nil {
			return restore(err)
		}
		moved = append(moved, name)
	}
	for _, name := range names {
		if err := os.Rename(filepath.Join(g.tmp, name), filepath.Join(g.outDir, name)); err != nil {
			return restore(err)
		}
		placed = append(placed, name)
	}
	return nil
}
