package generator

import (
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// Tests of the go/packages scan of the Go generator: hand-written files of the model package, pattern spelling, build tags and the generated relation getter text.

// TestGoGenerationScansHandWrittenFilesOfTheModelPackage checks that the
// hand-written files of the output package, such as its tests, are scanned
// like every other package named by the scan patterns.
func TestGoGenerationScansHandWrittenFilesOfTheModelPackage(t *testing.T) {
	testcase.Start(t)
	write := scannedModule(t)
	write("model/doc.go", "// Package model holds the generated models.\npackage model\n")
	write("model/price_test.go", `package model

import "testing"

func TestPrice(t *testing.T) { _ = Product().GtPrice(1) }
`)
	generateModel(t, namesManifest(t, namesDiagram))
	if out, err := exec.Command("go", "vet", "./...").CombinedOutput(); err != nil {
		t.Fatalf("go vet: %v\n%s", err, out)
	}
}

// TestGoRelationGetterReportsMismatch checks that a generated relation getter does not discard a type
// assertion failure but returns it together with an error through orm.RelatedAs.
func TestGoRelationGetterReportsMismatch(t *testing.T) {
	testcase.Start(t)
	write := scannedModule(t)
	write("example/example.go", scanLoadHeader+`		Relation(model.Brand().MatchBrandSeqWithSeq().AliasOwner()).
		Relations(model.Brand().MatchBrandSeqWithSeq())
}

func Owner(p *model.ProductModel) (*model.BrandModel, error) { return p.GetOwner() }

`+scanCountFunc)
	generateModel(t, namesManifest(t, namesDiagram))
	product := readModelFile(t, "product.go")
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
	testcase.Start(t)
	write := scannedModule(t)
	write("src/src.go", `package src

import "example.com/ormexample/model"

`+scanCheapFunc)
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
	testcase.Start(t)
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
	generateModel(t, m)
	product := readModelFile(t, "product.go")
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
