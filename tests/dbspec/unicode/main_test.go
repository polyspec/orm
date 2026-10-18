package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"unicode"

	"github.com/polyspec/orm/packages/go/testcase"
)

// repoRoot is the repository root from this test package (tests/dbspec/unicode).
const repoRoot = "../../.."

// goWord returns Go's classification of every code point as one byte each: '1' (word rune) or '0'.
func goWord() []byte {
	out := make([]byte, lastCodePoint+1)
	for r := rune(0); r <= lastCodePoint; r++ {
		out[r] = '0'
		if isWordRune(r) {
			out[r] = '1'
		}
	}
	return out
}

// TestCommittedTablesAreGenerated checks that the three generated files match the content produced from Go's current table.
func TestCommittedTablesAreGenerated(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	spans := wordSpans()
	for _, o := range outputs {
		got, err := os.ReadFile(filepath.Join(repoRoot, filepath.FromSlash(o.path)))
		if err != nil {
			t.Fatalf("%s: %v; run go run ./tests/dbspec/unicode -write", o.path, err)
		}
		if want := o.render(unicode.Version, spans); !bytes.Equal(got, want) {
			t.Errorf("%s differs from the table of Unicode %s; run go run ./tests/dbspec/unicode -write", o.path, unicode.Version)
		}
	}
}

// TestSpansMatchGoForEveryCodePoint checks that binary search over the ranges matches Go's classification at every code point.
func TestSpansMatchGoForEveryCodePoint(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	spans := wordSpans()
	for r := rune(0); r <= lastCodePoint; r++ {
		i := sort.Search(len(spans), func(i int) bool { return spans[i].hi >= r })
		inTable := i < len(spans) && spans[i].lo <= r
		if inTable != isWordRune(r) {
			t.Fatalf("code point %#U: table %v, Go %v", r, inTable, isWordRune(r))
		}
	}
}

// TestCTableAgreesWithGo compares the C extension's unicode_word_rune with Go at every code point. The C driver is
// built with cc and run in a temporary directory of this test.
func TestCTableAgreesWithGo(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	dir := t.TempDir()
	driver := filepath.Join(dir, "driver.c")
	src := "#include <stdio.h>\n#include \"unicode_word.h\"\n" +
		"int main(void)\n{\n    for (uint32_t cp = 0; cp <= 0x10FFFF; cp++) {\n" +
		"        putchar(unicode_word_rune(cp) ? '1' : '0');\n    }\n    return 0;\n}\n"
	if err := os.WriteFile(driver, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(dir, "driver")
	include := filepath.Join(repoRoot, "packages", "php-ext", "src")
	build := exec.Command("cc", "-std=c99", "-Wall", "-Wextra", "-Werror", "-I", include, driver, "-o", binary)
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("cc failed: %v\n%s; the C compiler cc must be installed", err, out)
	}
	got, err := exec.Command(binary).Output()
	if err != nil {
		t.Fatalf("driver failed: %v", err)
	}
	compareAll(t, "C unicode_word_rune", got, goWord())
}

// TestPythonTableAgreesWithGo compares the Python module's is_word_rune_code_point with Go at every code point.
// The Python interpreter is ORM_PYTHON if set, otherwise python3 from PATH.
func TestPythonTableAgreesWithGo(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	python := os.Getenv("ORM_PYTHON")
	if python == "" {
		python = "python3"
	}
	module := filepath.Join(repoRoot, "packages", "python", "src", "polyspec", "orm", "dbspec", "unicode_word.py")
	script := "import importlib.util, sys\n" +
		"spec = importlib.util.spec_from_file_location('unicode_word', sys.argv[1])\n" +
		"module = importlib.util.module_from_spec(spec)\n" +
		"spec.loader.exec_module(module)\n" +
		"sys.stdout.write(''.join('1' if module._is_word_rune_code_point(cp) else '0' for cp in range(0x110000)))\n"
	got, err := exec.Command(python, "-I", "-c", script, module).Output()
	if err != nil {
		t.Fatalf("%s failed: %v; set ORM_PYTHON to a Python 3 interpreter or run make install-python", python, err)
	}
	compareAll(t, "Python is_word_rune_code_point", got, goWord())
}

// compareAll checks whether two classification columns are equal, and if not, reports the first differing code point by name.
func compareAll(t *testing.T, name string, got, want []byte) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s wrote %d classes, want %d", name, len(got), len(want))
	}
	var differ []string
	for i := range want {
		if got[i] != want[i] {
			differ = append(differ, fmt.Sprintf("%04X", i))
			if len(differ) == 10 {
				break
			}
		}
	}
	if len(differ) > 0 {
		t.Fatalf("%s differs from Go at code points U+%s", name, strings.Join(differ, ", U+"))
	}
}
