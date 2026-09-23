package ormgen

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// consumerModule creates a module that requires the ORM of this repository,
// changes into it, and returns a function that writes a file of the module.
func consumerModule(t *testing.T) func(name, body string) {
	t.Helper()
	root, err := filepath.Abs("../..")
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
	write("go.mod", "module example.com/app\n"+strings.Replace(requires, "require (", "require (\n\tgithub.com/polyspec/orm v0.0.0", 1)+"\nreplace github.com/polyspec/orm => "+root+"\n")
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

// buildConsumer builds every package of the current consumer module.
func buildConsumer(t *testing.T) {
	t.Helper()
	if out, err := exec.Command("go", "build", "./...").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
}

// TestGoGenerationIgnoresMethodsOfRelationResults checks that a method called
// on a relation getter result is not requested as a model method while the
// getter does not exist yet.
func TestGoGenerationIgnoresMethodsOfRelationResults(t *testing.T) {
	write := consumerModule(t)
	write("app/app.go", `package app

import "example.com/app/model"

func Brands() *model.ProductModel {
	return model.Product().Relations(model.Brand().MatchBrandSeqWithSeq())
}

func Count(p *model.ProductModel) int { return p.GetBrandModels().Len() }
`)
	if err := generateGo(namesManifest(t, namesDiagram), "model", "", []string{"./..."}); err != nil {
		t.Fatal(err)
	}
	buildConsumer(t)
}

// TestGoGenerationScansHandWrittenFilesOfTheModelPackage checks that the
// hand-written files of the output package, such as its tests, are scanned
// like every other package named by the scan patterns.
func TestGoGenerationScansHandWrittenFilesOfTheModelPackage(t *testing.T) {
	write := consumerModule(t)
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
	write := consumerModule(t)
	write("other/other.go", `package other

type Item struct{}

func Product() Item { return Item{} }

func (Item) Title() string { return "" }
`)
	write("app/app.go", `package app

import (
	"example.com/app/model"
	"example.com/app/other"
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
	buildConsumer(t)
}
