package ormgen

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/runtimemodel"
)

// namesManifest는 dbspec document 하나의 runtime model이다.
func namesManifest(t *testing.T, document string) *runtimemodel.Model {
	t.Helper()
	m, diagnostics := runtimemodel.LoadDocuments([]string{document})
	if len(diagnostics) > 0 {
		t.Fatal(runtimemodel.DiagnosticsError(diagnostics))
	}
	return m
}

const namesDiagram = `dbspec 1 names

table product {
  seq i64 identity
  brand_seq i64
  name varchar(50)
  body text null
  price i32 default 0
  sale_start_dt datetime(6) null
  primary key (seq)
}

table brand {
  seq i64 identity
  min_price i32 default 0
  primary key (seq)
}
`

// thingDocument는 identity column과 column 하나인 table thing의 document다.
func thingDocument(columns ...string) string {
	text := "dbspec 1 thing\n\ntable thing {\n  seq i64 identity\n"
	for _, column := range columns {
		text += "  " + column + " i32\n"
	}
	return text + "  primary key (seq)\n}\n"
}

func TestParseChain(t *testing.T) {
	m := namesManifest(t, namesDiagram)
	e := m.Entities["product"]
	cases := map[string][]chainKey{
		"BrandSeqAndLtSaleStartDt": {{column: "brand_seq"}, {conn: "and", op: "lt", column: "sale_start_dt"}},
		"NeNameOrLkName":           {{op: "ne", column: "name"}, {conn: "or", op: "lk", column: "name"}},
		"BetweenPrice":             {{op: "between", column: "price"}},
		"PriceGtMinPrice":          {{op: "gt", column: "price", compare: "min_price"}},
		"NeTupleSeqWithBrandSeq":   {{op: "ne_tuple", columns: []string{"seq", "brand_seq"}}},
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
		"Missing":                "not a column",
		"LkPrice":                "does not accept",
		"PriceGtUnknown":         "no model has the column",
		"TupleSeq":               "two or more columns",
		"BetweenName":            "does not accept",
		"NameAnd":                "empty",
		"GtSaleStartDtAndLtName": "",
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
		err := checkNames(namesManifest(t, thingDocument(column)))
		if err == nil || !strings.Contains(err.Error(), message) {
			t.Fatalf("%s: got %v, want %q", column, err, message)
		}
	}
	m := namesManifest(t, thingDocument("min_price"))
	if err := checkNames(m); err != nil {
		t.Fatal(err)
	}
	collision := namesManifest(t, thingDocument("amount", "sum_amount"))
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

// TestScanGeneratesUsedMethods generates models for a small scanned module
// and builds it.
func TestScanGeneratesUsedMethods(t *testing.T) {
	write := scannedModule(t)
	write("example/example.go", `package example

import (
	"github.com/polyspec/orm/clients/go/orm"

	"example.com/ormexample/model"
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
	write("example/tagged_test.go", `//go:build integration && !short

package example

import "example.com/ormexample/model"

func tagged() *model.ProductModel { return model.Product().LtPrice(1) }
`)
	write("example/only_windows.go", `//go:build windows

package example

import "example.com/ormexample/model"

func platform() *model.ProductModel { return model.Product().GePrice(1) }
`)
	m := namesManifest(t, namesDiagram)
	if err := generateGo(m, "model", "", []string{"./..."}); err != nil {
		t.Fatal(err)
	}
	buildScannedModule(t)
	tagged := exec.Command("go", "vet", "-tags", "integration", "./...")
	if out, err := tagged.CombinedOutput(); err != nil {
		t.Fatalf("build-tagged file: %v\n%s", err, out)
	}
	windows := exec.Command("go", "vet", "./...")
	windows.Env = append(os.Environ(), "GOOS=windows", "CGO_ENABLED=0")
	if out, err := windows.CombinedOutput(); err != nil {
		t.Fatalf("platform file: %v\n%s", err, out)
	}
	write("example/valid_after_error.go", `package example

import "example.com/ormexample/model"

func ValidAfterUnrelatedError() *model.ProductModel { return model.Product().GePrice(1) }
`)
	write("example/unrelated_error.go", `package example

var _ = missingName
`)
	err := generateGo(m, "model", "", []string{"./..."})
	if err == nil || !strings.Contains(err.Error(), "missingName") {
		t.Fatalf("unrelated scanned-source error: %v", err)
	}
	product, err := os.ReadFile("model/product.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(product), "GePrice") {
		t.Fatal("a valid model method was not generated before reporting an unrelated scanned-source error")
	}
	write("example/bad.go", `package example

import "example.com/ormexample/model"

func Bad() *model.ProductModel { return model.Product().LkPrice("x") }
`)
	err = generateGo(m, "model", "", []string{"./..."})
	if err == nil || !strings.Contains(err.Error(), "does not accept") {
		t.Fatalf("invalid call: %v", err)
	}
}

// TestGeneratedFieldTypes는 dbspec type과 codec마다 generated field의 Go
// type이 docs/dbspec.md "Runtime model" 표를 따르는지 확인한다.
func TestGeneratedFieldTypes(t *testing.T) {
	m := namesManifest(t, `dbspec 1 typed

table typed {
  seq i64 identity
  small i16
  small_null i16 null
  ref uuid
  clock time(3)
  day date
  stamp datetime(6) null
  amount decimal(13,2)
  ratio f64
  flag bool
  blob bytes null
  address bytes null
  secret varchar(255)
  aes_key_version i32
  packed bytes null
  encoded text null
  doc text null
  primary key (seq)
  settings {
    codec address ip
    codec doc ordered_json
    codec encoded base64
    codec packed gz
    codec secret aes hex
    aes_version aes_key_version
  }
}
`)
	dir := filepath.Join(t.TempDir(), "model")
	if err := genGo(m, dir, nil); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(dir, "typed.go"))
	if err != nil {
		t.Fatal(err)
	}
	// gofmt 정렬과 무관하게 비교하려고 공백 연속을 하나로 줄인다.
	text := strings.Join(strings.Fields(string(body)), " ")
	for _, want := range []string{
		"fSmall int16", "fSmallNull *int16", "fRef string", "fClock string",
		"fDay time.Time", "fStamp *time.Time", "fAmount string", "fRatio float64",
		"fFlag bool", "fBlob []byte", "fAddress *string", "fSecret string",
		"fPacked orm.StyledValue", "fEncoded orm.StyledValue", "fDoc orm.StyledValue",
		"orm.AsInt16(v)", "orm.AsTimeText(v, 3)", `orm.NormalizeStyled([]string{"gz"}, true, v)`,
	} {
		if !strings.Contains(text, want) {
			t.Errorf("typed.go does not contain %q", want)
		}
	}
	orm, err := os.ReadFile(filepath.Join(dir, "orm.go"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"const ManifestHash = " + strconv.Quote(m.ManifestHash), `"dbspec 1 typed\n" +`, "func Connect(dsn string, cfg orm.Config) (*orm.DB, error)"} {
		if !strings.Contains(string(orm), want) {
			t.Errorf("orm.go does not contain %q", want)
		}
	}
}
