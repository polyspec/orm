package ormgen

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/schema"
)

func namesManifest(t *testing.T, diagram string) *schema.Manifest {
	t.Helper()
	d, err := schema.Parse(diagram)
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

const namesDiagram = `erDiagram
  product {
    bigint        seq          PK "auto"
    bigint        brand_seq
    varchar(50)   name
    text          body            "?"
    int           price           "=0"
    datetime(6)   sale_start_dt   "?"
    point         location        "?"
  }
  brand {
    bigint        seq          PK "auto"
    int           min_price       "=0"
  }
  %% fulltext product (name, body)
`

func TestParseChain(t *testing.T) {
	m := namesManifest(t, namesDiagram)
	e := m.Entities["product"]
	cases := map[string][]chainKey{
		"BrandSeqAndLtSaleStartDt": {{column: "brand_seq"}, {conn: "and", op: "lt", column: "sale_start_dt"}},
		"NeNameOrLkName":           {{op: "ne", column: "name"}, {conn: "or", op: "lk", column: "name"}},
		"BetweenPrice":             {{op: "between", column: "price"}},
		"PriceGtMinPrice":          {{op: "gt", column: "price", compare: "min_price"}},
		"FulltextNameWithBody":     {{op: "fulltext", columns: []string{"name", "body"}}},
		"NeTupleSeqWithBrandSeq":   {{op: "ne_tuple", columns: []string{"seq", "brand_seq"}}},
		"EqLocation":               {{column: "location"}},
	}
	for name, want := range cases {
		got, err := parseChain(m, e, name)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: got %+v want %+v", name, got, want)
		}
	}
	for name, message := range map[string]string{
		"Missing":             "not a column",
		"LkPrice":             "does not accept",
		"PriceGtUnknown":      "no model has the column",
		"FulltextName":        "no full-text index",
		"TupleSeq":            "two or more columns",
		"BetweenName":         "does not accept",
		"NameAnd":             "empty",
		"GtLocationAndLtName": "",
	} {
		_, err := parseChain(m, e, name)
		if message == "" {
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), message) {
			t.Fatalf("%s: got %v, want %q", name, err, message)
		}
	}
}

func TestColumnNameRules(t *testing.T) {
	for column, message := range map[string]string{
		"price_gt_limit": "segment",
		"with_tax":       "segment",
		"order_by_x":     "start with",
		"get_name":       "start with",
		"random":         "reserved",
		"create":         "reserved",
	} {
		d, err := schema.Parse("erDiagram\n  thing {\n    bigint seq PK \"auto\"\n    int " + column + "\n  }\n")
		if err != nil {
			continue
		}
		m, err := schema.Build(d)
		if err != nil {
			continue
		}
		err = checkColumnNames(m)
		if err == nil || !strings.Contains(err.Error(), message) {
			t.Fatalf("%s: got %v, want %q", column, err, message)
		}
	}
	m := namesManifest(t, "erDiagram\n  thing {\n    bigint seq PK \"auto\"\n    int min_price\n  }\n")
	if err := checkColumnNames(m); err != nil {
		t.Fatal(err)
	}
	collision := namesManifest(t, "erDiagram\n  thing {\n    bigint seq PK \"auto\"\n    int amount\n    int sum_amount\n  }\n")
	if err := generateGo(collision, filepath.Join(t.TempDir(), "model"), "", nil); err == nil || !strings.Contains(err.Error(), "fixed method") {
		t.Fatalf("method collision: %v", err)
	}
}

func TestSplitPair(t *testing.T) {
	m := namesManifest(t, namesDiagram)
	left, right, err := splitPair(m, m.Entities["product"], m.Entities["brand"], "BrandSeqWithSeq")
	if err != nil || left != "brand_seq" || right != "seq" {
		t.Fatalf("%s %s %v", left, right, err)
	}
	if _, _, err := splitPair(m, m.Entities["product"], m.Entities["brand"], "NameWithMinPrice"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := splitPair(m, m.Entities["product"], m.Entities["brand"], "NameWithBody"); err == nil {
		t.Fatal("a child column that does not exist was accepted")
	}
}

// TestScanGeneratesUsedMethods generates models for a small consumer module
// and builds it.
func TestScanGeneratesUsedMethods(t *testing.T) {
	write := consumerModule(t)
	write("app/app.go", `package app

import (
	"github.com/polyspec/orm/clients/go/orm"

	"example.com/app/model"
)

func Query(db *orm.DB) (*orm.Collection[*model.ProductModel], error) {
	brand := model.Brand().On(func(b *model.BrandModel) { b.GtMinPrice(0) })
	return model.Product().Connect(db).
		BrandSeq([]int64{1, 2}).
		AndLtSaleStartDt(orm.DaysAgo(1)).
		And(func(q *model.ProductModel) { q.NeName("x").OrPriceGtMinPrice(brand) }).
		JoinBrandSeqWithSeq(brand).
		Relation(model.Brand().MatchBrandSeqWithSeq().AliasOwner()).
		NewScore(1).
		OrderByPriceDescAndSeqAsc().
		Gets()
}

func Owner(p *model.ProductModel) *model.BrandModel { return p.GetOwner() }
`)
	write("app/tagged_test.go", `//go:build integration && !short

package app

import "example.com/app/model"

func tagged() *model.ProductModel { return model.Product().LtPrice(1) }
`)
	write("app/only_windows.go", `//go:build windows

package app

import "example.com/app/model"

func platform() *model.ProductModel { return model.Product().GePrice(1) }
`)
	m := namesManifest(t, namesDiagram)
	if err := generateGo(m, "model", "", []string{"./..."}); err != nil {
		t.Fatal(err)
	}
	buildConsumer(t)
	tagged := exec.Command("go", "vet", "-tags", "integration", "./...")
	if out, err := tagged.CombinedOutput(); err != nil {
		t.Fatalf("build-tagged file: %v\n%s", err, out)
	}
	windows := exec.Command("go", "vet", "./...")
	windows.Env = append(os.Environ(), "GOOS=windows", "CGO_ENABLED=0")
	if out, err := windows.CombinedOutput(); err != nil {
		t.Fatalf("platform file: %v\n%s", err, out)
	}
	write("app/valid_after_error.go", `package app

import "example.com/app/model"

func ValidAfterUnrelatedError() *model.ProductModel { return model.Product().GePrice(1) }
`)
	write("app/unrelated_error.go", `package app

var _ = missingName
`)
	err := generateGo(m, "model", "", []string{"./..."})
	if err == nil || !strings.Contains(err.Error(), "missingName") {
		t.Fatalf("unrelated consumer error: %v", err)
	}
	product, err := os.ReadFile("model/product.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(product), "GePrice") {
		t.Fatal("a valid model method was not generated before reporting an unrelated consumer error")
	}
	write("app/bad.go", `package app

import "example.com/app/model"

func Bad() *model.ProductModel { return model.Product().LkPrice("x") }
`)
	err = generateGo(m, "model", "", []string{"./..."})
	if err == nil || !strings.Contains(err.Error(), "does not accept") {
		t.Fatalf("invalid call: %v", err)
	}
}
