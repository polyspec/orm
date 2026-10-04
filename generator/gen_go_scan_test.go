package generator

import (
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
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
	write("go.mod", "module example.com/ormexample\n"+strings.Replace(requires, "require (", "require (\n\tgithub.com/polyspec/orm v0.0.0", 1)+"\nreplace github.com/polyspec/orm => "+root+"\n")
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

// TestGoRelationGetterReportsMismatch는 generated relation getter가 type
// assertion 실패를 버리지 않고 orm.RelatedAs로 error와 함께 돌려주는지 확인한다.
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
