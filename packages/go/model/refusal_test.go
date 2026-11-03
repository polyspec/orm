package model_test

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/tools/go/packages"

	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// refusalChain is one use of the errors vector of tests/conformance/vectors.json: its source for the type checker and
// the same chain for the run. The spec makes each of them a returned error (DSL-19, DSL-47, DSL-10, DSL-123, DSL-98,
// DSL-67, DSL-96, PRT-14), so the type checker accepts the chain and refuses only a use that drops that error.
type refusalChain struct {
	name   string
	source string
	run    func(author func() *model.AuthorModel, db *orm.DB) error
}

var refusalChains = []refusalChain{
	{"missing connector", `author().Name("a").IsClose(true).Gets()`, func(author func() *model.AuthorModel, _ *orm.DB) error {
		_, err := author().Name("a").IsClose(true).Gets()
		return err
	}},
	{"dangling connector", `author().Name("a").And().Gets()`, func(author func() *model.AuthorModel, _ *orm.DB) error {
		_, err := author().Name("a").And().Gets()
		return err
	}},
	{"empty list", `author().Seq([]int64{}).Gets()`, func(author func() *model.AuthorModel, _ *orm.DB) error {
		_, err := author().Seq([]int64{}).Gets()
		return err
	}},
	{"no connection", `model.Author().Name("a").Gets()`, func(func() *model.AuthorModel, *orm.DB) error {
		_, err := model.Author().Name("a").Gets()
		return err
	}},
	{"lock outside a transaction", `author().ForUpdate().Gets()`, func(author func() *model.AuthorModel, _ *orm.DB) error {
		_, err := author().ForUpdate().Gets()
		return err
	}},
	{"join child with connection", `author().JoinUserSeqWithSeq(model.User().Connect(db)).Gets()`, func(author func() *model.AuthorModel, db *orm.DB) error {
		_, err := author().JoinUserSeqWithSeq(model.User().Connect(db)).Gets()
		return err
	}},
	{"page with limit", `author().Limit(0, 1).GetsPage(1, 10)`, func(author func() *model.AuthorModel, _ *orm.DB) error {
		_, err := author().Limit(0, 1).GetsPage(1, 10)
		return err
	}},
	{"relation with limit", `author().Relation(model.User().MatchUserSeqWithSeq().Limit(0, 1)).GetsBySeq(42)`, func(author func() *model.AuthorModel, _ *orm.DB) error {
		_, err := author().Relation(model.User().MatchUserSeqWithSeq().Limit(0, 1)).GetsBySeq(42)
		return err
	}},
	{"unjoined model placement", `author().Name("a").Or(model.User()).Gets()`, func(author func() *model.AuthorModel, _ *orm.DB) error {
		_, err := author().Name("a").Or(model.User()).Gets()
		return err
	}},
}

// refusalCodes reads the expected codes of the errors vector: the SQLite vectors of the database this test connects to.
func refusalCodes(t *testing.T) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "tests", "conformance", "vectors.sqlite.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Vectors []struct {
			Name   string `json:"name"`
			Chain  string `json:"chain"`
			Expect struct {
				Result     json.RawMessage `json:"result"`
				Statements []any           `json:"statements"`
			} `json:"expect"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	for _, vector := range file.Vectors {
		if vector.Name != "errors" {
			continue
		}
		var names []string
		for _, chain := range refusalChains {
			names = append(names, chain.name)
		}
		if vector.Chain != strings.Join(names, ", ") {
			t.Fatalf("the errors vector names %q, this test %q", vector.Chain, strings.Join(names, ", "))
		}
		if len(vector.Expect.Statements) != 0 {
			t.Fatalf("the errors vector expects statements: %v", vector.Expect.Statements)
		}
		var codes []string
		if err := json.Unmarshal(vector.Expect.Result, &codes); err != nil {
			t.Fatal(err)
		}
		return codes
	}
	t.Fatal("tests/conformance/vectors.sqlite.json has no errors vector")
	return nil
}

// TestRefusalBeforeAnyRequest runs each chain of the errors vector on a SQLite file that has no table, with a statement
// subscriber: the expected code with no statement event, where a chain that reached the database would fail on the
// missing table with another code.
// Requirements: DSL-10, DSL-19, DSL-47, DSL-67, DSL-96, DSL-98, DSL-123, PRT-14.
func TestRefusalBeforeAnyRequest(t *testing.T) {
	testcase.Start(t, testcase.Database)
	codes := refusalCodes(t)
	db, err := model.Connect("sqlite://"+filepath.Join(t.TempDir(), "refusal.sqlite"), orm.Config{AESKey: "test-aes-key", BlindIndexKey: "test-blind-key"})
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, db)
	var statements []string
	if _, err := db.Subscribe(func(e orm.StatementEvent) error {
		statements = append(statements, e.SQL)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	author := func() *model.AuthorModel { return model.Author().Connect(db) }
	// A chain that the spec does not refuse reaches the database, so an empty statement list means no request.
	if _, err := author().Seq(42).Gets(); err == nil || len(statements) == 0 {
		t.Fatalf("a chain that is not refused gave error %v and statements %q; the table must be missing and the subscriber must see it", err, statements)
	}
	for i, chain := range refusalChains {
		t.Run(chain.name, func(t *testing.T) {
			statements = nil
			err := chain.run(author, db)
			if got := orm.ErrorCode(err); got != codes[i] {
				t.Fatalf("%s: code %q (%v), want %q", chain.source, got, err, codes[i])
			}
			if len(statements) != 0 {
				t.Fatalf("%s sent %q before its refusal", chain.source, statements)
			}
		})
	}
}

// TestRefusalIsATypedError is the build fixture of the errors vector: the type checker accepts each chain with its error
// and refuses the use that drops the error, so the refusal cannot be left unread.
// Requirements: DSL-10, DSL-19, DSL-47, DSL-67, DSL-96, DSL-98, DSL-123, PRT-14.
func TestRefusalIsATypedError(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	const modelPath = "github.com/polyspec/orm/packages/go/model"
	const ormPath = "github.com/polyspec/orm/packages/go/orm"
	loaded, err := packages.Load(&packages.Config{Mode: packages.NeedName | packages.NeedTypes | packages.NeedImports | packages.NeedDeps}, modelPath, ormPath)
	if err != nil {
		t.Fatal(err)
	}
	imported := map[string]*types.Package{}
	for _, p := range loaded {
		if len(p.Errors) > 0 {
			t.Fatalf("load %s: %v", p.PkgPath, p.Errors)
		}
		imported[p.PkgPath] = p.Types
	}
	check := func(body string) []string {
		src := "package snippet\n\nimport (\n\t\"" + modelPath + "\"\n\t\"" + ormPath + "\"\n)\n\nfunc use(db *orm.DB) {\n\tauthor := func() *model.AuthorModel { return model.Author().Connect(db) }\n\t_ = author\n\t" + body + "\n}\n"
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, "snippet.go", src, 0)
		if err != nil {
			t.Fatal(err)
		}
		var errs []string
		conf := types.Config{
			Importer: importerFunc(func(path string) (*types.Package, error) { return imported[path], nil }),
			Error:    func(err error) { errs = append(errs, err.Error()) },
		}
		// Check returns the first error that Error collects, so the list holds every error.
		_, _ = conf.Check("snippet", fset, []*ast.File{file}, nil)
		return errs
	}
	for _, chain := range refusalChains {
		t.Run(chain.name, func(t *testing.T) {
			if errs := check("rows, err := " + chain.source + "\n\t_, _ = rows, err"); len(errs) != 0 {
				t.Fatalf("%s does not compile with its error: %s", chain.source, strings.Join(errs, "; "))
			}
			errs := check("rows := " + chain.source + "\n\t_ = rows")
			if len(errs) != 1 || !strings.Contains(errs[0], "assignment mismatch") {
				t.Fatalf("a use of %s that drops its error must be refused as an assignment mismatch, got %q", chain.source, errs)
			}
		})
	}
}
