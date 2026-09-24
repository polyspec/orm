package ormgen

import (
	"errors"
	"testing"
)

const secondModelDiagram = `erDiagram
  note {
    bigint        seq          PK "auto"
    bigint        product_seq
  }
`

// TestGoGenerationOfTwoModelPackagesSettlesInOneRun generates the two model
// packages of one module from a clean state in sequence, as go generate does.
// A consumer passes a value computed with a method of the second package to a
// method of the first. The first generation runs while the second package lacks
// that method, and it still writes every method the scan finds: a second run
// of both generations changes no file and reports no error.
func TestGoGenerationOfTwoModelPackagesSettlesInOneRun(t *testing.T) {
	write := consumerModule(t)
	write("a/model/doc.go", "// Package model holds the generated models.\npackage model\n")
	write("b/model/doc.go", "// Package model holds the generated models.\npackage model\n")
	write("app/app.go", `package app

import (
	amodel "example.com/app/a/model"
	bmodel "example.com/app/b/model"
)

func Priced() (*amodel.ProductModel, error) {
	count, err := bmodel.Note().GetCountByProductSeq(1)
	if err != nil {
		return nil, err
	}
	return amodel.Product().GtPrice(count), nil
}
`)
	first, second := namesManifest(t, namesDiagram), namesManifest(t, secondModelDiagram)
	var consumer *ConsumerError
	if err := generateGo(first, "a/model", "", []string{"./..."}); err != nil && !errors.As(err, &consumer) {
		t.Fatalf("first package: %v", err)
	}
	if err := generateGo(second, "b/model", "", []string{"./..."}); err != nil {
		t.Fatalf("second package: %v", err)
	}
	a, b := snapshotDir(t, "a/model"), snapshotDir(t, "b/model")
	if err := generateGo(first, "a/model", "", []string{"./..."}); err != nil {
		t.Fatalf("first package, second run: %v", err)
	}
	if err := generateGo(second, "b/model", "", []string{"./..."}); err != nil {
		t.Fatalf("second package, second run: %v", err)
	}
	requireSameFiles(t, a, snapshotDir(t, "a/model"))
	requireSameFiles(t, b, snapshotDir(t, "b/model"))
}
