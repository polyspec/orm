package generator

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/testcase"
)

// scannedModule creates a module that requires the ORM of this repository,
// changes into it, and returns a function that writes a file of the module.
func scannedModule(t *testing.T) func(name, body string) {
	t.Helper()
	root, err := filepath.Abs("..")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	write := func(name, body string) {
		t.Helper()
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	gomod, err := os.ReadFile(filepath.Join(root, "go.mod"))
	if err != nil {
		t.Fatal(err)
	}
	requires := strings.SplitN(string(gomod), "\n", 2)[1]
	write("go.mod", "module example.com/ormexample\n"+strings.Replace(requires, "require (", "require (\n\tgithub.com/polyspec/orm/packages/go v0.0.0", 1)+"\nreplace github.com/polyspec/orm/packages/go => "+root+"\n")
	sum, err := os.ReadFile(filepath.Join(root, "go.sum"))
	if err != nil {
		t.Fatal(err)
	}
	write("go.sum", string(sum))
	t.Setenv("GOWORK", "off")
	t.Setenv("GOFLAGS", "-mod=mod")
	t.Chdir(dir)
	return write
}

// buildScannedModule builds every package of the current scanned module.
func buildScannedModule(t *testing.T) {
	t.Helper()
	if out, err := exec.Command("go", "build", "./...").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
}

// testScannedModule executes the tests of the generated consumer module.
func testScannedModule(t *testing.T) {
	t.Helper()
	if out, err := exec.Command("go", "test", "-count=1", "./...").CombinedOutput(); err != nil {
		t.Fatalf("go test: %v\n%s", err, out)
	}
}

// TestGoGenerationIgnoresMethodsOfRelationResults checks that a method called
// on a relation getter result is not requested as a model method while the
// getter does not exist yet.
// Requirements: DSL-9, DSL-39.
func TestGoGenerationIgnoresMethodsOfRelationResults(t *testing.T) {
	testcase.Start(t, testcase.Process)
	write := scannedModule(t)
	write("example/example.go", `package example

import "example.com/ormexample/model"

func Brands() *model.ProductModel {
	return model.Product().Relations(model.Brand().MatchBrandSeqWithSeq())
}

`+scanCountFunc)
	generateModel(t, namesManifest(t, namesDiagram))
	buildScannedModule(t)
}

// Requirements: DBS-112, DBS-114, INT-66.
// TestGoGeneratedScalarGetterRejectsUnselectedRead checks the generated getter at runtime through
// an external consumer that compiles against either the current or corrected getter signature.
func TestGoGeneratedScalarGetterRejectsUnselectedRead(t *testing.T) {
	testcase.Start(t, testcase.Process)
	write := scannedModule(t)
	write("example/getter_test.go", `package example

import (
	"reflect"
	"testing"

	"example.com/ormexample/model"
	"github.com/polyspec/orm/packages/go/orm"
)

func TestPriceGetterSelection(t *testing.T) {
	product := model.Product()
	field, ok := reflect.TypeOf(*product).FieldByName("fPrice")
	if !ok || field.IsExported() {
		t.Fatalf("generated fPrice field = %+v, exists=%t; want an unexported typed field", field, ok)
	}
	read := func() []reflect.Value { return reflect.ValueOf(product).MethodByName("GetPrice").Call(nil) }
	values := read()
	if len(values) != 2 {
		t.Fatalf("GetPrice returned %d values, want value and error", len(values))
	}
	if values[1].IsNil() || orm.ErrorCode(values[1].Interface().(error)) != orm.CodeColumnUnselected {
		t.Fatalf("unselected GetPrice error = %v, want COLUMN_UNSELECTED", values[1].Interface())
	}
	product.SetPrice(17)
	values = read()
	if got := values[0].Interface().(int32); got != 17 {
		t.Fatalf("assigned GetPrice = %d, want 17", got)
	}
	if !values[1].IsNil() {
		t.Fatalf("assigned GetPrice error = %v, want nil", values[1].Interface())
	}
}
`)
	generateModel(t, namesManifest(t, namesDiagram))
	testScannedModule(t)
}

// Requirements: COD-20, COD-25.
func TestGoGeneratedNonnullStyledSetterRejectsSqlNull(t *testing.T) {
	testcase.Start(t, testcase.Process)
	write := scannedModule(t)
	m := namesManifest(t, `dbspec 1 styled

table item {
  seq i64 identity
  payload text
  primary key (seq)
  settings {
    codec payload ordered_json
  }
}
`)
	if err := generateGo(m, "model", "", nil); err != nil {
		t.Fatal(err)
	}
	write("example/styled_test.go", `package example

import (
	"encoding/json"
	"testing"

	"example.com/ormexample/model"
	"github.com/polyspec/orm/packages/go/orm"
)

func TestGeneratedNonnullStyledSetterRejectsSqlNull(t *testing.T) {
	item := model.Item()
	if _, err := item.SetPayload(orm.SqlNull()); orm.ErrorCode(err) != orm.CodeCodecEncode {
		t.Fatalf("generated non-null setter error = %v; want CODEC_ENCODE", err)
	}
	if _, err := item.GetPayload(); orm.ErrorCode(err) != orm.CodeColumnUnselected {
		t.Fatalf("rejected setter changed the generated model: %v", err)
	}
	item, err := item.SetPayload(orm.Value(nil))
	if err != nil {
		t.Fatalf("encoded JSON null was rejected: %v", err)
	}
	value, err := item.GetPayload()
	if err != nil {
		t.Fatal(err)
	}
	if value.Kind() != "value" {
		t.Fatalf("generated getter kind = %q; want value", value.Kind())
	}
	got, ok := value.Data()
	if !ok {
		t.Fatal("generated getter has no encoded value")
	}
	encoded, err := json.Marshal(got)
	if err != nil || string(encoded) != "null" {
		t.Fatalf("generated getter data = %s, %v; want encoded JSON null", encoded, err)
	}
}
`)
	testScannedModule(t)
}

// TestGoGeneratedScalarGetterCompilesAtItsDeclaredType checks a typed getter through an external consumer.
func TestGoGeneratedScalarGetterCompilesAtItsDeclaredType(t *testing.T) {
	testcase.Start(t, testcase.Process)
	write := scannedModule(t)
	write("example/example.go", `package example

import "example.com/ormexample/model"

func Price(p *model.ProductModel) (int32, error) { return p.GetPrice() }
`)
	generateModel(t, namesManifest(t, namesDiagram))
	buildScannedModule(t)
}

// TestGoGenerationIgnoresConstructorNamesOfOtherPackages checks that a call
// whose name equals a model constructor but belongs to another package does not
// start a model chain.
func TestGoGenerationIgnoresConstructorNamesOfOtherPackages(t *testing.T) {
	testcase.Start(t, testcase.Process)
	write := scannedModule(t)
	write("other/other.go", `package other

type Item struct{}

func Product() Item { return Item{} }

func (Item) Title() string { return "" }
`)
	write("example/example.go", `package example

import (
	"example.com/ormexample/model"
	"example.com/ormexample/other"
)

func Title() string { return other.Product().Title() }

`+scanCheapFunc)
	generateModel(t, namesManifest(t, namesDiagram))
	product := readModelFile(t, "product.go")
	if strings.Contains(string(product), "Title") {
		t.Fatal("a method of another package's Product result was generated on ProductModel")
	}
	buildScannedModule(t)
}

// readModelFile reads the file name of the generated model package; a failure fails the test.
func readModelFile(t *testing.T, name string) string {
	t.Helper()
	raw, err := os.ReadFile("model/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// generateModel generates the model package from the manifest m into the
// working directory's model folder; a failure fails the test.
func generateModel(t *testing.T, m *runtimemodel.Model) {
	t.Helper()
	if err := generateGo(m, "model", "", []string{"./..."}); err != nil {
		t.Fatal(err)
	}
}

// scanCountFunc is the Count function of a scanned example package, which reads the brands of a product.
const scanCountFunc = "func Count(p *model.ProductModel) (int, error) {\n\tbrands, err := p.GetBrandModels()\n\tif err != nil {\n\t\treturn 0, err\n\t}\n\treturn brands.Len(), nil\n}\n"

// scanCheapFunc is the Cheap function of a scanned example package, which filters the products by price.
const scanCheapFunc = "func Cheap() *model.ProductModel { return model.Product().LtPrice(1) }\n"

// scanLoadHeader starts the example package of a scan case: a Load function that
// starts a product query, whose relations the case then writes.
const scanLoadHeader = "package example\n\nimport \"example.com/ormexample/model\"\n\nfunc Load() *model.ProductModel {\n\treturn model.Product().\n"
