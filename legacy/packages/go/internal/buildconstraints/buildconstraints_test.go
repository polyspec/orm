// Package buildconstraints holds the rule that no build tag leaves a written Go test out of the normal go test.
package buildconstraints

import (
	"bufio"
	"errors"
	"fmt"
	"go/build/constraint"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// platformTags are the operating systems and architectures that Go knows (go tool dist list), with unix and cgo.
var platformTags = []string{
	"aix", "android", "darwin", "dragonfly", "freebsd", "hurd", "illumos", "ios", "js", "linux", "nacl", "netbsd",
	"openbsd", "plan9", "solaris", "wasip1", "windows", "zos",
	"386", "amd64", "arm", "arm64", "loong64", "mips", "mips64", "mips64le", "mipsle", "ppc64", "ppc64le", "riscv64",
	"s390x", "sparc64", "wasm",
	"unix", "cgo",
}

// repositoryRoot is the root of the checkout: go test runs in this package's directory.
func repositoryRoot(t *testing.T) string {
	t.Helper()
	directory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Clean(filepath.Join(directory, "..", "..", "..", ".."))
}

// moduleDirectories reads the modules of go.work, so that a new module of the repository falls under the rule.
func moduleDirectories(t *testing.T, root string) []string {
	t.Helper()
	text, err := os.ReadFile(filepath.Join(root, "go.work"))
	if err != nil {
		t.Fatal(err)
	}
	var directories []string
	for _, used := range regexp.MustCompile(`(?m)^\s*(?:use\s+)?(\./\S*)\s*$`).FindAllSubmatch(text, -1) {
		directories = append(directories, filepath.Clean(string(used[1])))
	}
	if len(directories) == 0 {
		t.Fatal("go.work names no module")
	}
	return directories
}

// goTestTags reads GO_TEST_TAGS of tests/go-test.mts, the one place that holds them.
func goTestTags(t *testing.T, root string) []string {
	t.Helper()
	text, err := os.ReadFile(filepath.Join(root, "tests", "go-test.mts"))
	if err != nil {
		t.Fatal(err)
	}
	found := regexp.MustCompile(`export const GO_TEST_TAGS = \[([^\]]*)\]`).FindSubmatch(text)
	if found == nil {
		t.Fatal("tests/go-test.mts declares no GO_TEST_TAGS")
	}
	var tags []string
	for _, quoted := range regexp.MustCompile(`'([^']+)'`).FindAllSubmatch(found[1], -1) {
		tags = append(tags, string(quoted[1]))
	}
	return tags
}

// tagsOf adds the tags that an expression names to the set.
func tagsOf(expression constraint.Expr, set map[string]bool) {
	switch node := expression.(type) {
	case *constraint.TagExpr:
		set[node.Tag] = true
	case *constraint.NotExpr:
		tagsOf(node.X, set)
	case *constraint.AndExpr:
		tagsOf(node.X, set)
		tagsOf(node.Y, set)
	case *constraint.OrExpr:
		tagsOf(node.X, set)
		tagsOf(node.Y, set)
	}
}

// fileTags are the sorted tags of the build constraints of a Go file: the comment lines before its package clause.
func fileTags(path string) (_ []string, err error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, file.Close()) }()
	set := map[string]bool{}
	lines := bufio.NewScanner(file)
	lines.Buffer(nil, 1<<24)
	for lines.Scan() {
		line := strings.TrimSpace(lines.Text())
		if line != "" && !strings.HasPrefix(line, "//") {
			break
		}
		if constraint.IsGoBuild(line) || constraint.IsPlusBuild(line) {
			expression, err := constraint.Parse(line)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", path, err)
			}
			tagsOf(expression, set)
		}
	}
	if err := lines.Err(); err != nil {
		return nil, err
	}
	tags := make([]string, 0, len(set))
	for tag := range set {
		tags = append(tags, tag)
	}
	slices.Sort(tags)
	return tags, nil
}

// offending lists, one line per file, the tags under the directories that are neither a platform nor in allowed.
func offending(base string, directories, allowed []string) ([]string, error) {
	var found []string
	for _, directory := range directories {
		err := filepath.WalkDir(filepath.Join(base, directory), func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() && entry.Name() == "node_modules" {
				return filepath.SkipDir
			}
			if entry.IsDir() || filepath.Ext(path) != ".go" {
				return nil
			}
			tags, err := fileTags(path)
			if err != nil {
				return err
			}
			var bad []string
			for _, tag := range tags {
				if !slices.Contains(platformTags, tag) && !slices.Contains(allowed, tag) {
					bad = append(bad, tag)
				}
			}
			if len(bad) > 0 {
				relative, err := filepath.Rel(base, path)
				if err != nil {
					return err
				}
				found = append(found, filepath.ToSlash(relative)+": "+strings.Join(bad, " "))
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return found, nil
}

// TestOffendingFindsATagThatLeavesATestOut holds the rule on fixtures: a tag is accepted only as a platform
// constraint or a tag of every go test run, in any position of the expression and in either comment form.
func TestOffendingFindsATagThatLeavesATestOut(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, test := range []struct {
		name, source string
		want         string
	}{
		{"no constraint", "package a\n", ""},
		{"a platform", "//go:build linux\n\npackage a\n", ""},
		{"platforms with not", "//go:build unix && !windows && amd64\n\npackage a\n", ""},
		{"cgo", "//go:build cgo\n\npackage a\n", ""},
		{"the tag of every run", "//go:build ormtest\n\npackage a\n", ""},
		{"the tag of every run negated", "//go:build !ormtest\n\npackage a\n", ""},
		{"a tag after the package clause is no constraint", "package a\n\n//go:build physical\n", ""},
		{"a tag after a comment", "// A file.\n\n//go:build physical\n\npackage a\n", "a.go: physical"},
		{"a test tag", "//go:build physical\n\npackage a\n", "a.go: physical"},
		{"a test tag with a platform", "//go:build physical && unix\n\npackage a\n", "a.go: physical"},
		{"a negated test tag", "//go:build !physical\n\npackage a\n", "a.go: physical"},
		{"a test tag in an or", "//go:build linux || bench\n\npackage a\n", "a.go: bench"},
		{"two test tags", "//go:build markdown && examples\n\npackage a\n", "a.go: examples markdown"},
		{"the old comment form", "// +build perfgate\n\npackage a\n", "a.go: perfgate"},
		{"a release tag", "//go:build go1.21\n\npackage a\n", "a.go: go1.21"},
	} {
		t.Run(test.name, func(t *testing.T) {
			base := t.TempDir()
			if err := os.WriteFile(filepath.Join(base, "a.go"), []byte(test.source), 0o600); err != nil {
				t.Fatal(err)
			}
			found, err := offending(base, []string{"."}, []string{"ormtest"})
			if err != nil {
				t.Fatal(err)
			}
			if got := strings.Join(found, "\n"); got != test.want {
				t.Fatalf("offending = %q, want %q", got, test.want)
			}
		})
	}
}

// TestGoTestTagsAreReadFromTheRunner holds that the allowed tags come from tests/go-test.mts.
func TestGoTestTagsAreReadFromTheRunner(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	if tags := goTestTags(t, repositoryRoot(t)); !slices.Contains(tags, "ormtest") {
		t.Fatalf("GO_TEST_TAGS = %v, want it to hold the entry-point tag ormtest", tags)
	}
}

// TestNoBuildTagLeavesATestOut reads every Go file of the modules of go.work.
func TestNoBuildTagLeavesATestOut(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	root := repositoryRoot(t)
	found, err := offending(root, moduleDirectories(t, root), goTestTags(t, root))
	if err != nil {
		t.Fatal(err)
	}
	if len(found) > 0 {
		t.Fatalf("%d files carry a build tag that leaves a test out of the normal go test:\n%s", len(found), strings.Join(found, "\n"))
	}
}
