package generator

import (
	"os"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// TestGenerateSetsGeneratesAProducerBeforeItsConsumerWhateverTheOrder checks that
// a set whose scanned package imports the output of another set is generated after
// that set, so the producer's operator methods exist when the consumer's scanned
// calls are type-checked. The consumer is listed first here.
func TestGenerateSetsGeneratesAProducerBeforeItsConsumerWhateverTheOrder(t *testing.T) {
	// Requirements: DSL-151, DSL-154.
	testcase.Start(t, testcase.Process)
	write := scannedModule(t)
	write("consumer/consumer.go", `package consumer

import (
	"example.com/ormexample/producer"
	"github.com/polyspec/orm/packages/go/orm"
)

func Search(db *orm.DB) error {
	_, err := producer.Product().Connect(db).LkName("a%").Gets()
	return err
}
`)
	m := namesManifest(t, namesDiagram)
	err := GenerateSets([]Options{
		{Model: m, OutputDir: "consumermodel", Scan: []string{"./consumer"}},
		{Model: m, OutputDir: "producer", Scan: []string{"./consumer"}},
	})
	if err != nil {
		t.Fatalf("the consumer set listed first is not generated after its producer: %v", err)
	}
	if !strings.Contains(string(readModelFileFrom(t, "producer", "product.go")), "func (x *ProductModel) LkName[") {
		t.Error("producer/product.go does not declare LkName, the operator method the consumer calls")
	}
	buildScannedModule(t)
}

// TestGenerateSetsRefusesACycleAndNamesBothSets checks that two sets whose scanned
// packages import each other's output have no generation order: the generation is
// refused and the error names both sets.
func TestGenerateSetsRefusesACycleAndNamesBothSets(t *testing.T) {
	// Requirements: DSL-151.
	testcase.Start(t, testcase.Process)
	write := scannedModule(t)
	// The set leftmodel scans ./right, which imports rightmodel; the set rightmodel
	// scans ./left, which imports leftmodel. Each set needs the other.
	write("left/left.go", `package left

import "example.com/ormexample/leftmodel"

var _ = leftmodel.Product
`)
	write("right/right.go", `package right

import "example.com/ormexample/rightmodel"

var _ = rightmodel.Product
`)
	m := namesManifest(t, namesDiagram)
	err := GenerateSets([]Options{
		{Model: m, OutputDir: "leftmodel", Scan: []string{"./right"}},
		{Model: m, OutputDir: "rightmodel", Scan: []string{"./left"}},
	})
	if err == nil {
		t.Fatal("two sets that scan each other's output are generated")
	}
	for _, name := range []string{"leftmodel", "rightmodel"} {
		if !strings.Contains(err.Error(), name) {
			t.Errorf("the cycle error does not name %s: %v", name, err)
		}
	}
}

// readModelFileFrom reads a generated file of the output directory dir.
func readModelFileFrom(t *testing.T, dir, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(dir + "/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
