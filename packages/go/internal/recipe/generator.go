package recipe

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"unicode"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/generator"
)

// generatorOptions is the options object of a generator.generate step (FCV-4): the other document sets it uses, and the scanned
// sources of each language, each a tree of path to text.
type generatorOptions struct {
	Used    []string                     `json:"used"`
	Sources map[string]map[string]string `json:"sources"`
}

// generatorExpect is the expect of a generator.generate step: the names of the generated methods that must be present and
// absent, or the error with its code and the source position of a file that does not parse.
type generatorExpect struct {
	Value *struct {
		Includes []string `json:"includes"`
		Excludes []string `json:"excludes"`
	} `json:"value"`
	Error    string `json:"error"`
	Position *struct {
		Line   int `json:"line"`
		Column int `json:"column"`
	} `json:"position"`
}

// checkGenerator runs one generator.generate step of the Go runtime and checks it against the expect of database.
func checkGenerator(t *testing.T, dir string, s step, database string) error {
	raw, ok := s.Expect[database]
	if !ok {
		return fmt.Errorf("generator.generate has no expect for %s", database)
	}
	var want generatorExpect
	if err := json.Unmarshal(raw, &want); err != nil {
		return fmt.Errorf("generator.generate expect: %w", err)
	}
	var o generatorOptions
	if len(s.Options) > 0 {
		if err := json.Unmarshal(s.Options, &o); err != nil {
			return fmt.Errorf("generator.generate options: %w", err)
		}
	}
	names, err := generateScanned(t, dir, s.Schema, o)
	if want.Error != "" {
		if err == nil {
			return fmt.Errorf("generation succeeded, want error %s", want.Error)
		}
		if code := generatorErrorCode(err); code != want.Error {
			return fmt.Errorf("error code %q, want %s: %w", code, want.Error, err)
		}
		if want.Position != nil {
			m := parsePosition.FindStringSubmatch(err.Error())
			if m == nil || m[1] != fmt.Sprint(want.Position.Line) {
				return fmt.Errorf("error position does not name line %d: %w", want.Position.Line, err)
			}
		}
		return nil
	}
	if err != nil {
		return err
	}
	if want.Value == nil {
		return fmt.Errorf("generator.generate expect has no value")
	}
	for _, name := range want.Value.Includes {
		if !names[name] {
			return fmt.Errorf("generated code lacks %s", name)
		}
	}
	for _, name := range want.Value.Excludes {
		if names[name] {
			return fmt.Errorf("generated code declares %s", name)
		}
	}
	return nil
}

// parsePosition finds the file and line of the first error the scan reports for a file that does not parse.
var parsePosition = regexp.MustCompile(`\.go:(\d+):(\d+)`)

// generatorErrorCode maps a generation error to its code of docs/spec/errors.yaml. No code of errors.yaml names a generator
// refusal yet (the pending row T334-3-22-1), so a generator error has no code, and the case fails with its message.
func generatorErrorCode(err error) string {
	return ""
}

// generateScanned writes the scanned Go sources of the case under a temporary module that requires this ORM, generates the
// models of the schema into its model directory with the public generator.Generate, and returns the method names of the
// generated models as table.name (the snake_case identifier without its language prefix, FCV-4).
func generateScanned(t *testing.T, dir, schema string, o generatorOptions) (map[string]bool, error) {
	t.Helper()
	root := t.TempDir()
	t.Setenv("GOWORK", "off")
	t.Setenv("GOFLAGS", "-mod=mod")
	_, self, _, _ := runtime.Caller(0)
	pkgGo := filepath.Join(filepath.Dir(self), "..", "..")
	gomod, err := os.ReadFile(filepath.Join(pkgGo, "go.mod"))
	if err != nil {
		return nil, err
	}
	requires := strings.SplitN(string(gomod), "\n", 2)[1]
	module := "module example.com/ormexample\n" + strings.Replace(requires, "require (", "require (\n\tgithub.com/polyspec/orm/packages/go v0.0.0", 1) + "\nreplace github.com/polyspec/orm/packages/go => " + pkgGo + "\n"
	sum, err := os.ReadFile(filepath.Join(pkgGo, "go.sum"))
	if err != nil {
		return nil, err
	}
	if err := writeTree(root, map[string]string{"go.mod": module, "go.sum": string(sum)}); err != nil {
		return nil, err
	}
	if err := writeTree(root, o.Sources["go"]); err != nil {
		return nil, err
	}
	owned, err := documentTexts(dir, []string{schema})
	if err != nil {
		return nil, err
	}
	external, err := documentTexts(dir, o.Used)
	if err != nil {
		return nil, err
	}
	m, diagnostics := runtimemodel.LoadDocumentSet(owned, external)
	if len(diagnostics) > 0 {
		return nil, fmt.Errorf("SCHEMA_INVALID: %s", runtimemodel.DiagnosticsError(diagnostics))
	}
	t.Chdir(root)
	// A source that imports the output of another set takes that output from the same manifest, as the Go native does.
	for _, text := range o.Sources["go"] {
		if strings.Contains(text, "example.com/ormexample/othermodel") {
			if err := generator.Generate(generator.Options{Model: m, OutputDir: filepath.Join(root, "othermodel")}); err != nil {
				return nil, err
			}
			break
		}
	}
	out := filepath.Join(root, "model")
	if err := generator.Generate(generator.Options{Model: m, OutputDir: out, Scan: []string{"./..."}}); err != nil {
		return nil, err
	}
	return generatedMethods(out)
}

// documentTexts reads the .dbs documents named relative to the recipe directory dir.
func documentTexts(dir string, paths []string) ([]string, error) {
	texts := make([]string, 0, len(paths))
	for _, path := range paths {
		text, diagnostics, err := dbspec.ReadFile(filepath.Join(dir, path))
		if err != nil {
			return nil, err
		}
		if len(diagnostics) > 0 {
			return nil, fmt.Errorf("SCHEMA_INVALID: %s", runtimemodel.DiagnosticsError(diagnostics))
		}
		texts = append(texts, text)
	}
	return texts, nil
}

// writeTree writes each file of files under root at its slash path.
func writeTree(root string, files map[string]string) error {
	for path, text := range files {
		full := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(full, []byte(text), 0o644); err != nil {
			return err
		}
	}
	return nil
}

// generatedMethods parses the generated files of out with go/parser and returns the methods of each model as table.name. A
// file holds the model of one table, named by the table, and its methods have the receiver of that model's type.
func generatedMethods(out string) (map[string]bool, error) {
	entries, err := os.ReadDir(out)
	if err != nil {
		return nil, err
	}
	names := map[string]bool{}
	fset := token.NewFileSet()
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		table := strings.TrimSuffix(name, ".go")
		file, err := parser.ParseFile(fset, filepath.Join(out, name), nil, parser.SkipObjectResolution)
		if err != nil {
			return nil, err
		}
		model := camel(table) + "Model"
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Recv == nil || len(fn.Recv.List) != 1 {
				continue
			}
			if receiverName(fn.Recv.List[0].Type) != model {
				continue
			}
			names[table+"."+methodName(fn.Name.Name)] = true
		}
	}
	return names, nil
}

// receiverName is the type name of a method receiver, without its pointer.
func receiverName(expr ast.Expr) string {
	if star, ok := expr.(*ast.StarExpr); ok {
		expr = star.X
	}
	if ident, ok := expr.(*ast.Ident); ok {
		return ident.Name
	}
	return ""
}

// methodName is the snake_case identifier of a generated method without its language prefix (Get, New, Alias).
func methodName(name string) string {
	for _, prefix := range []string{"Get", "New", "Alias"} {
		if rest, ok := strings.CutPrefix(name, prefix); ok && rest != "" && unicode.IsUpper(rune(rest[0])) {
			return snake(rest)
		}
	}
	return snake(name)
}

// snake converts a CamelCase identifier to snake_case.
func snake(s string) string {
	var b strings.Builder
	for i, r := range s {
		if unicode.IsUpper(r) {
			if i > 0 {
				b.WriteByte('_')
			}
			r = unicode.ToLower(r)
		}
		b.WriteRune(r)
	}
	return b.String()
}

// camel converts a snake_case table name to the CamelCase name of its entity.
func camel(table string) string {
	var b strings.Builder
	for _, part := range strings.Split(table, "_") {
		if part == "" {
			continue
		}
		runes := []rune(part)
		runes[0] = unicode.ToUpper(runes[0])
		b.WriteString(string(runes))
	}
	return b.String()
}
