// orm-fmt formats dbspec documents into their canonical form.
//
//	orm-fmt [--check|--write] <file.dbs>...
//	orm-fmt < file.dbs
//
// The named files form one document set, as orm-gen's --document files do: each
// file parses with the others as its set, and each is rewritten in the canonical
// emit (docs/dbspec.md "Canonical form"). A file whose parse has diagnostics is
// refused, naming them. With no file argument the standard input formats alone,
// as a set of one. --check exits 1 naming every file that is not formatted,
// --write rewrites it, and with neither the formatted text of each file goes to
// standard output.
package main

import (
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/polyspec/orm/engine/dbspec"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "orm-fmt:", err)
		os.Exit(exitCode(err))
	}
}

const (
	exitOK          = 0
	exitUnformatted = 1
	exitError       = 2
)

// unformattedError is the answer of --check: at least one named file is not in
// the canonical form.
type unformattedError struct{}

func (*unformattedError) Error() string { return "not formatted" }

// run reads the arguments and formats what they name.
func run(args []string) error {
	mode := ""
	var files []string
	for _, a := range args {
		switch a {
		case "--check", "--write":
			name := strings.TrimPrefix(a, "--")
			if mode != "" && mode != name {
				return fmt.Errorf("--%s and --%s do not go together", mode, name)
			}
			mode = name
		case "--":
			files = append(files, remaining(args)...)
			args = nil
		default:
			if strings.HasPrefix(a, "-") {
				return fmt.Errorf("unknown option %s", a)
			}
			files = append(files, a)
		}
	}
	sort.Strings(files)
	if len(files) == 0 {
		text, err := io.ReadAll(os.Stdin)
		if err != nil {
			return err
		}
		formatted, err := formatText(string(text), nil, "<stdin>")
		if err != nil {
			return err
		}
		_, err = os.Stdout.WriteString(formatted)
		return err
	}
	set, err := readSet(files)
	if err != nil {
		return err
	}
	unformatted := false
	for _, f := range files {
		text := set[f]
		formatted, err := formatText(text, setFor(set, f), f)
		if err != nil {
			return err
		}
		if formatted == text {
			continue
		}
		switch mode {
		case "check":
			fmt.Fprintf(os.Stderr, "orm-fmt: %s is not formatted\n", f)
			unformatted = true
		case "write":
			if err := os.WriteFile(f, []byte(formatted), 0o644); err != nil {
				return err
			}
		default:
			_, err := os.Stdout.WriteString(formatted)
			if err != nil {
				return err
			}
		}
	}
	if unformatted {
		return &unformattedError{}
	}
	return nil
}

// remaining returns the arguments after the first "--".
func remaining(args []string) []string {
	for i, a := range args {
		if a == "--" {
			return args[i+1:]
		}
	}
	return nil
}

// readSet reads every named file into a set keyed by its argument name.
func readSet(files []string) (map[string]string, error) {
	set := make(map[string]string, len(files))
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		set[f] = string(b)
	}
	return set, nil
}

// setFor returns the set of every other document, as Parse wants it.
func setFor(set map[string]string, self string) map[string]string {
	others := make(map[string]string, len(set)-1)
	for name, text := range set {
		if name != self {
			others[name] = text
		}
	}
	return others
}

// formatText parses text with its document set and returns its canonical emit.
// A parse with diagnostics is refused, naming the first ones.
func formatText(text string, set map[string]string, name string) (string, error) {
	document, diagnostics := dbspec.Parse(text, set)
	if document == nil {
		var b strings.Builder
		for i, d := range diagnostics {
			if i == 5 {
				fmt.Fprintf(&b, " and %d more", len(diagnostics)-i)
				break
			}
			if i > 0 {
				b.WriteString("; ")
			}
			fmt.Fprintf(&b, "%s:%d:%d %s: %s", name, d.Line, d.Column, d.Rule, d.Message)
		}
		return "", fmt.Errorf("%s", strings.TrimPrefix(b.String(), name+":"+""))
	}
	return dbspec.Emit(document), nil
}

// exitCode maps the error to the exit status: 1 for --check's finding, 2 else.
func exitCode(err error) int {
	if _, ok := err.(*unformattedError); ok {
		return exitUnformatted
	}
	return exitError
}
