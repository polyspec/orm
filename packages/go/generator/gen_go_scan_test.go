package generator

import (
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
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

// TestGoGenerationIgnoresMethodsOfRelationResults checks that a method called
// on a relation getter result is not requested as a model method while the
// getter does not exist yet.
func TestGoGenerationIgnoresMethodsOfRelationResults(t *testing.T) {
	testcase.Start(t, testcase.Process)
	write := scannedModule(t)
	write("example/example.go", `package example

import "example.com/ormexample/model"

func Brands() *model.ProductModel {
	return model.Product().Relations(model.Brand().MatchBrandSeqWithSeq())
}

func Count(p *model.ProductModel) (int, error) {
	brands, err := p.GetBrandModels()
	if err != nil {
		return 0, err
	}
	return brands.Len(), nil
}
`)
	if err := generateGo(namesManifest(t, namesDiagram), "model", "", []string{"./..."}); err != nil {
		t.Fatal(err)
	}
	buildScannedModule(t)
}

// TestGoGenerationScansHandWrittenFilesOfTheModelPackage checks that the
// hand-written files of the output package, such as its tests, are scanned
// like every other package named by the scan patterns.
func TestGoGenerationScansHandWrittenFilesOfTheModelPackage(t *testing.T) {
	testcase.Start(t, testcase.Process)
	write := scannedModule(t)
	write("model/doc.go", "// Package model holds the generated models.\npackage model\n")
	write("model/price_test.go", `package model

import "testing"

func TestPrice(t *testing.T) { _ = Product().GtPrice(1) }
`)
	if err := generateGo(namesManifest(t, namesDiagram), "model", "", []string{"./..."}); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("go", "vet", "./...").CombinedOutput(); err != nil {
		t.Fatalf("go vet: %v\n%s", err, out)
	}
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

func Cheap() *model.ProductModel { return model.Product().LtPrice(1) }
`)
	if err := generateGo(namesManifest(t, namesDiagram), "model", "", []string{"./..."}); err != nil {
		t.Fatal(err)
	}
	product, err := os.ReadFile("model/product.go")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(product), "Title") {
		t.Fatal("a method of another package's Product result was generated on ProductModel")
	}
	buildScannedModule(t)
}

// TestGoRelationGetterReportsMismatch checks that a generated relation getter does not discard a type
// assertion failure but returns it together with an error through orm.RelatedAs.
func TestGoRelationGetterReportsMismatch(t *testing.T) {
	testcase.Start(t, testcase.Process)
	write := scannedModule(t)
	write("example/example.go", `package example

import "example.com/ormexample/model"

func Load() *model.ProductModel {
	return model.Product().
		Relation(model.Brand().MatchBrandSeqWithSeq().AliasOwner()).
		Relations(model.Brand().MatchBrandSeqWithSeq())
}

func Owner(p *model.ProductModel) (*model.BrandModel, error) { return p.GetOwner() }

func Count(p *model.ProductModel) (int, error) {
	brands, err := p.GetBrandModels()
	if err != nil {
		return 0, err
	}
	return brands.Len(), nil
}
`)
	if err := generateGo(namesManifest(t, namesDiagram), "model", "", []string{"./..."}); err != nil {
		t.Fatal(err)
	}
	product, err := os.ReadFile("model/product.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(product)
	for _, want := range []string{
		"func (x *ProductModel) GetOwner() (*BrandModel, error) {\n\treturn orm.RelatedAs[*BrandModel](x.m, \"owner\")\n}",
		"func (x *ProductModel) GetBrandModels() (*orm.Collection[*BrandModel], error) {\n\treturn orm.RelatedAs[*orm.Collection[*BrandModel]](x.m, \"brand_models\")\n}",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("generated product.go lacks\n%s", want)
		}
	}
	if strings.Contains(text, "v, _ :=") {
		t.Error("generated product.go drops a failed relation type assertion with v, _ :=")
	}
	buildScannedModule(t)
}

// TestGoGenerationScanPathSpelling checks that the same sources and schema
// give the same model files however the scan patterns and the output
// directory are written: relative, absolute, or with a trailing slash.
func TestGoGenerationScanPathSpelling(t *testing.T) {
	testcase.Start(t, testcase.Process)
	write := scannedModule(t)
	write("src/src.go", `package src

import "example.com/ormexample/model"

func Cheap() *model.ProductModel { return model.Product().LtPrice(1) }
`)
	write("tests/tests.go", `package tests

import "example.com/ormexample/model"

func Named() *model.BrandModel { return model.Brand().GtMinPrice(2) }
`)
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	spellings := []struct{ name, src, tests, out string }{
		{"relative", "./src", "./tests", "model"},
		{"absolute", filepath.Join(dir, "src"), filepath.Join(dir, "tests"), filepath.Join(dir, "model")},
		{"dot", "./src/.", "./tests/.", "./model"},
		{"trailing_slash", "./src/", "./tests/", "model/"},
	}
	var first map[string]string
	for _, s := range spellings {
		if err := os.RemoveAll("model"); err != nil {
			t.Fatal(err)
		}
		if err := generateGo(namesManifest(t, namesDiagram), s.out, "", []string{s.src, s.tests}); err != nil {
			t.Fatalf("%s: %v", s.name, err)
		}
		entries, err := os.ReadDir("model")
		if err != nil {
			t.Fatal(err)
		}
		files := map[string]string{}
		for _, entry := range entries {
			b, err := os.ReadFile(filepath.Join("model", entry.Name()))
			if err != nil {
				t.Fatal(err)
			}
			files[entry.Name()] = string(b)
		}
		if first == nil {
			first = files
			if !strings.Contains(files["product.go"], ") LtPrice[") || !strings.Contains(files["brand.go"], ") GtMinPrice[") {
				t.Fatal("the calls of src and tests are not generated")
			}
			continue
		}
		if !maps.Equal(files, first) {
			t.Errorf("the model files of the %s paths differ from the relative paths", s.name)
		}
	}
	buildScannedModule(t)
}

// TestScanLoadsTaggedConfigurationsOnlyForTheirPackages checks that the scan
// loads every scanned package once with the default configuration and loads
// a build-tag configuration only for the package whose ignored file needs it;
// the type information of the other packages comes from the default load.
func TestScanLoadsTaggedConfigurationsOnlyForTheirPackages(t *testing.T) {
	testcase.Start(t, testcase.Process)
	write := scannedModule(t)
	write("tagged/tagged.go", `package tagged

import "example.com/ormexample/model"

func Query() *model.ProductModel { return model.Product().GtPrice(1) }
`)
	write("tagged/tagged_test.go", `//go:build integration

package tagged

import "example.com/ormexample/model"

func tagged() *model.ProductModel { return model.Product().LtPrice(1) }
`)
	write("plain/plain.go", `package plain

import "example.com/ormexample/model"

func Query() *model.ProductModel { return model.Product().GePrice(1) }
`)
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	loads := map[string][]string{}
	scanLoads = func(config scanConfig, patterns []string) {
		key := config.tags + "/" + config.goos + "/" + config.goarch
		loads[key] = append(loads[key], patterns...)
	}
	t.Cleanup(func() { scanLoads = nil })
	m := namesManifest(t, namesDiagram)
	if err := generateGo(m, "model", "", []string{"./..."}); err != nil {
		t.Fatal(err)
	}
	product, err := os.ReadFile("model/product.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"GtPrice", "LtPrice", "GePrice"} {
		if !strings.Contains(string(product), method) {
			t.Fatalf("the scan did not generate %s", method)
		}
	}
	tagged := loads["integration//"]
	slices.Sort(tagged)
	tagged = slices.Compact(tagged)
	if want := []string{filepath.Join(dir, "tagged")}; !slices.Equal(tagged, want) {
		t.Fatalf("the integration configuration loads %q, want only %q", tagged, want)
	}
}

// TestGoRelationAliasWithChainPrefix checks that a relation alias that starts
// with a chain prefix (Match, Join) still gives the parent its getter.
// Requirements: DBS-118.
func TestGoRelationAliasWithChainPrefix(t *testing.T) {
	testcase.Start(t, testcase.Process)
	write := scannedModule(t)
	write("example/example.go", `package example

import "example.com/ormexample/model"

func Load() *model.ProductModel {
	return model.Product().
		Relation(model.Brand().MatchBrandSeqWithSeq().AliasMatch()).
		Relation(model.Brand().MatchBrandSeqWithSeq().AliasJoin())
}

func Match(p *model.ProductModel) (*model.BrandModel, error) { return p.GetMatch() }

func Join(p *model.ProductModel) (*model.BrandModel, error) { return p.GetJoin() }
`)
	if err := generateGo(namesManifest(t, namesDiagram), "model", "", []string{"./..."}); err != nil {
		t.Fatal(err)
	}
	product, err := os.ReadFile("model/product.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"func (x *ProductModel) GetMatch() (*BrandModel, error)", "func (x *ProductModel) GetJoin() (*BrandModel, error)"} {
		if !strings.Contains(string(product), want) {
			t.Errorf("generated product.go lacks %s", want)
		}
	}
	buildScannedModule(t)
}

// TestGoNestedRelationAliasAttachesToItsParent checks that the alias of a
// relation nested in a relation gives its getter to the model it aliases on,
// and that a call on the result of a getter resolves to that model.
// Requirements: DBS-118.
func TestGoNestedRelationAliasAttachesToItsParent(t *testing.T) {
	testcase.Start(t, testcase.Process)
	write := scannedModule(t)
	write("example/example.go", `package example

import "example.com/ormexample/model"

func Load() *model.ProductModel {
	return model.Product().
		Relation(model.Brand().MatchBrandSeqWithSeq().AliasStore().
			Relation(model.Product().MatchSeqWithBrandSeq().AliasMatch()))
}

func Match(p *model.ProductModel) (*model.ProductModel, error) {
	store, err := p.GetStore()
	if err != nil {
		return nil, err
	}
	return store.GetMatch()
}
`)
	if err := generateGo(namesManifest(t, namesDiagram), "model", "", []string{"./..."}); err != nil {
		t.Fatal(err)
	}
	brand, err := os.ReadFile("model/brand.go")
	if err != nil {
		t.Fatal(err)
	}
	if want := "func (x *BrandModel) GetMatch() (*ProductModel, error)"; !strings.Contains(string(brand), want) {
		t.Errorf("generated brand.go lacks %s", want)
	}
	buildScannedModule(t)
}

// TestGoUnattachedGetterStopsGeneration checks that a scanned getter call
// that no Alias, New or AddColumn call attaches stops generation, naming the
// model and the method.
func TestGoUnattachedGetterStopsGeneration(t *testing.T) {
	testcase.Start(t, testcase.Process)
	write := scannedModule(t)
	write("example/example.go", `package example

import "example.com/ormexample/model"

func Load() *model.ProductModel {
	return model.Product().Relation(model.Brand().MatchBrandSeqWithSeq().AliasStore())
}

func Ghost(p *model.ProductModel) (*model.BrandModel, error) { return p.GetGhost() }
`)
	err := generateGo(namesManifest(t, namesDiagram), "model", "", []string{"./..."})
	if err == nil {
		t.Fatal("generation accepted a getter call that nothing attaches")
	}
	if !strings.Contains(err.Error(), "ProductModel.GetGhost is called") {
		t.Errorf("the refusal does not name ProductModel.GetGhost: %v", err)
	}
}

// fixtureDocument reads a document of contracts/fixtures/external. It must run
// before scannedModule, which changes the working directory.
func fixtureDocument(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "fixtures", "external", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// TestGoRelationGetterOfExternalEntity checks that a relation to an entity of a
// used external document gives the owned model its getter, typed with the
// external model of its own package.
// A relation to an entity of a used external document is a relation to an entity of the set: the member package generates its
// model (ExtAudit), so the relation argument is that model and its getter is attached as the getter of any entity.
func TestGoRelationGetterOfExternalEntity(t *testing.T) {
	testcase.Start(t, testcase.Process)
	member := fixtureDocument(t, "member.dbs")
	core := fixtureDocument(t, "core.dbs")
	write := scannedModule(t)
	m, diagnostics := runtimemodel.LoadSet(member, core)
	if len(diagnostics) > 0 {
		t.Fatal(runtimemodel.DiagnosticsError(diagnostics))
	}
	write("example/example.go", `package example

import "example.com/ormexample/model"

func Load() *model.ExtPostModel {
	return model.ExtPost().Relation(model.ExtAudit().MatchAccountSeqWithSeq())
}

func Audit(row *model.ExtPostModel) (*model.ExtAuditModel, error) { return row.GetExtAuditModel() }
`)
	if err := generateGo(m, "model", "", []string{"./example"}); err != nil {
		t.Fatal(err)
	}
	post, err := os.ReadFile("model/ext_post.go")
	if err != nil {
		t.Fatal(err)
	}
	if want := `orm.RelatedAs[*ExtAuditModel]`; !strings.Contains(string(post), want) || !strings.Contains(string(post), `"ext_audit_model")`) {
		t.Errorf("generated ext_post.go lacks the getter of the external relation %s", want)
	}
	buildScannedModule(t)
}

// TestGoGetterOfNestedRebindingUsesItsOwnModel checks that a getter called on a
// variable that a nested scope rebinds to another model is attributed to the
// model of that inner binding, not to the model of the outer one.
func TestGoGetterOfNestedRebindingUsesItsOwnModel(t *testing.T) {
	testcase.Start(t, testcase.Process)
	write := scannedModule(t)
	write("example/example.go", `package example

import "example.com/ormexample/model"

func Scoped() (int, error) {
	row := model.Product().Relation(model.Brand().MatchBrandSeqWithSeq().AliasStore())
	if _, err := row.GetStore(); err != nil {
		return 0, err
	}
	count := func() (int, error) {
		row := model.Brand().Relations(model.Product().MatchSeqWithBrandSeq())
		products, err := row.GetProductModels()
		if err != nil {
			return 0, err
		}
		return products.Len(), nil
	}
	return count()
}
`)
	if err := generateGo(namesManifest(t, namesDiagram), "model", "", []string{"./..."}); err != nil {
		t.Fatal(err)
	}
	buildScannedModule(t)
}
