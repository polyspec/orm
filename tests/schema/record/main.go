// Records the schema tool results that every language's schema tools must
// reproduce: the manifest, the DDL of each dialect, the migration between
// manifests, and the migration plan file, for the Mermaid fixtures of the Go
// tests of the client, the engine, and the tools, and the bench schema.
//
//	go run ./tests/schema/record          # writes tests/schema/cases.json
//	go run ./tests/schema/record -check   # fails when the file is stale
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/polyspec/orm/engine/schema"
	"github.com/polyspec/orm/internal/ormgen"
)

const out = "tests/schema/cases.json"

// Result is a digest of the output text or the error message.
type Result struct {
	SHA256 string `json:"sha256,omitempty"`
	Error  string `json:"error,omitempty"`
}

type Case struct {
	Name     string            `json:"name"`
	Mermaid  string            `json:"mmd"`
	Manifest Result            `json:"manifest"`
	DDL      map[string]Result `json:"ddl,omitempty"`
}

type Diff struct {
	From             string `json:"from"`
	To               string `json:"to"`
	Dialect          string `json:"dialect"`
	AllowDestructive bool   `json:"allow_destructive"`
	Result
}

// Plan is the ormgen plan file for a pair of manifests, written with
// File.PlanID and File.PlanName.
type Plan struct {
	From    string `json:"from"`
	To      string `json:"to"`
	Dialect string `json:"dialect"`
	Result
}

type File struct {
	PlanID   string `json:"plan_id"`
	PlanName string `json:"plan_name"`
	Cases    []Case `json:"cases"`
	Diffs    []Diff `json:"diffs"`
	Plans    []Plan `json:"plans"`
}

const (
	planID   = "20260101-fixture"
	planName = "fixture"
)

var dialects = []string{"mysql", "postgres", "sqlite"}

func digest(text string, err error) Result {
	if err != nil {
		return Result{Error: err.Error()}
	}
	sum := sha256.Sum256([]byte(text))
	return Result{SHA256: hex.EncodeToString(sum[:])}
}

// fixtures lists the Mermaid strings of the Go test files: string literals
// and concatenations of string literals.
func fixtures(roots ...string) ([]Case, error) {
	var cases []Case
	for _, root := range roots {
		err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() || !strings.HasSuffix(path, "_test.go") {
				return err
			}
			f, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
			if err != nil {
				return err
			}
			consts := map[string]ast.Expr{}
			for _, decl := range f.Decls {
				if g, ok := decl.(*ast.GenDecl); ok && g.Tok == token.CONST {
					for _, spec := range g.Specs {
						v := spec.(*ast.ValueSpec)
						for i, name := range v.Names {
							if i < len(v.Values) {
								consts[name.Name] = v.Values[i]
							}
						}
					}
				}
			}
			n := 0
			ast.Inspect(f, func(node ast.Node) bool {
				if _, bare := node.(*ast.Ident); bare {
					return true
				}
				text, ok := stringConstant(node, consts)
				if !ok {
					return true
				}
				if strings.Contains(text, "erDiagram") {
					n++
					cases = append(cases, Case{Name: fmt.Sprintf("%s#%d", filepath.ToSlash(path), n), Mermaid: text})
				}
				return false
			})
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return cases, nil
}

// stringConstant folds a string literal or a + chain of string literals and
// constants declared in the same file.
func stringConstant(node ast.Node, consts map[string]ast.Expr) (string, bool) {
	switch x := node.(type) {
	case *ast.Ident:
		value, ok := consts[x.Name]
		if !ok {
			return "", false
		}
		return stringConstant(value, consts)
	case *ast.BasicLit:
		if x.Kind != token.STRING {
			return "", false
		}
		text, err := strconv.Unquote(x.Value)
		return text, err == nil
	case *ast.BinaryExpr:
		if x.Op != token.ADD {
			return "", false
		}
		left, ok := stringConstant(x.X, consts)
		if !ok {
			return "", false
		}
		right, ok := stringConstant(x.Y, consts)
		if !ok {
			return "", false
		}
		return left + right, true
	case *ast.ParenExpr:
		return stringConstant(x.X, consts)
	}
	return "", false
}

func main() {
	check := flag.Bool("check", false, "fail when the recorded file differs")
	flag.Parse()
	cases, err := fixtures("clients/go", "engine", "internal/ormgen")
	if err != nil {
		fail(err)
	}
	bench, err := os.ReadFile("schema/bench.mmd")
	if err != nil {
		fail(err)
	}
	cases = append(cases, Case{Name: "schema/bench.mmd", Mermaid: string(bench)})
	manifests := map[string]*schema.Manifest{}
	var built []string
	for i := range cases {
		c := &cases[i]
		d, err := schema.Parse(c.Mermaid)
		var m *schema.Manifest
		if err == nil {
			m, err = schema.Build(d)
		}
		if err != nil {
			c.Manifest = Result{Error: err.Error()}
			continue
		}
		text, err := m.MarshalIndent()
		c.Manifest = digest(string(text), err)
		c.DDL = map[string]Result{}
		for _, dialect := range dialects {
			c.DDL[dialect] = digest(ormgen.RenderDDL(m, dialect))
		}
		manifests[c.Name] = m
		built = append(built, c.Name)
	}
	var diffs []Diff
	var plans []Plan
	for _, from := range built {
		for _, to := range built {
			if !sharesEntity(manifests[from], manifests[to]) {
				continue
			}
			for _, dialect := range dialects {
				text, err := ormgen.RenderMigrationPlan(manifests[from], manifests[to], dialect, planID, planName)
				plans = append(plans, Plan{From: from, To: to, Dialect: dialect, Result: digest(string(text), err)})
				for _, allow := range []bool{true, false} {
					text, err := ormgen.RenderDiff(manifests[from], manifests[to], dialect, allow)
					diffs = append(diffs, Diff{From: from, To: to, Dialect: dialect, AllowDestructive: allow, Result: digest(text, err)})
				}
			}
		}
	}
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetIndent("", " ")
	if err := enc.Encode(File{PlanID: planID, PlanName: planName, Cases: cases, Diffs: diffs, Plans: plans}); err != nil {
		fail(err)
	}
	if *check {
		old, err := os.ReadFile(out)
		if err != nil || !bytes.Equal(old, b.Bytes()) {
			fail(fmt.Errorf("%s is stale; run go run ./tests/schema/record", out))
		}
		return
	}
	if err := os.WriteFile(out, b.Bytes(), 0o644); err != nil {
		fail(err)
	}
	fmt.Printf("record: %d cases, %d diffs, %d plans → %s\n", len(cases), len(diffs), len(plans), out)
}

func sharesEntity(a, b *schema.Manifest) bool {
	names := make([]string, 0, len(a.Entities))
	for name := range a.Entities {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if b.Entities[name] != nil {
			return true
		}
	}
	return false
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "record: %v\n", err)
	os.Exit(1)
}
