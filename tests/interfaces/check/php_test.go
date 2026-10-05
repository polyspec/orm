package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

func TestPHPRelativeTypes(t *testing.T) {
	testcase.Start(t, testcase.Process)
	if _, err := exec.LookPath("php"); err != nil {
		t.Fatalf("php CLI is required; tool tests never skip; install the PHP of .php-version")
	}
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	source := `<?php
namespace Fixture;
class Base {}
interface Left {}
interface Right {}
class Row extends Base {
    private ?self $current;
    public function same(self $row): self {}
    public function optional(?self $row): ?self {}
    public function base(parent $row): parent {}
    public function late(): static {}
    public function union(self|int $row): self|int {}
    public function intersection(Left&Right $row): Left&Right {}
    public function dnf((Left&Right)|self $row): (Left&Right)|self {}
}
`
	read := func(s string) Symbols {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, "fixture.php"), []byte(s), 0600); err != nil {
			t.Fatal(err)
		}
		got, err := extract(t.Context(), dir, "php", []string{"."}, "", root)
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	got := read(source)
	prefix := `fixture.php::Fixture\Row::`
	for name, want := range map[string]string{
		"$current": `private ?Fixture\Row`,
		"same":     `public function same(Fixture\Row $row): Fixture\Row`,
		"optional": `public function optional(?Fixture\Row $row): ?Fixture\Row`,
		"base":     `public function base(Fixture\Base $row): Fixture\Base`,
		"late":     `public function late(): static`,
	} {
		if got[prefix+name] != want {
			t.Errorf("%s: got %q, want %q", name, got[prefix+name], want)
		}
	}
	qualified := strings.ReplaceAll(strings.ReplaceAll(source, "self", `\Fixture\Row`), "parent", `\Fixture\Base`)
	if other := read(qualified); !reflect.DeepEqual(got, other) {
		t.Fatalf("relative and qualified types differ: %v", differences(got, other))
	}
	for _, replacement := range []string{"static", `\Fixture\Base`} {
		other := read(strings.Replace(source, "same(self $row): self", "same(self $row): "+replacement, 1))
		if got[prefix+"same"] == other[prefix+"same"] {
			t.Fatalf("normalization hid a change from self to %s", replacement)
		}
	}
}

func TestPHPRecordSourceMutationChangesExtractedWire(t *testing.T) {
	testcase.Start(t, testcase.Process)
	if _, err := exec.LookPath("php"); err != nil {
		t.Fatalf("php CLI is required: %v; install the PHP of .php-version", err)
	}
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "fixture.php")
	read := func(kindType, itemsType string, extra bool) Symbols {
		t.Helper()
		records := "'Request' => ['kind' => '" + kindType + "', 'items' => '" + itemsType + "']"
		if extra {
			records += ", 'Extra' => ['kind' => 'string']"
		}
		source := "<?php\nnamespace Orm;\nfinal class Validator { private const RECORDS = [" + records + "]; }\n"
		if err := os.WriteFile(path, []byte(source), 0600); err != nil {
			t.Fatal(err)
		}
		got, err := extract(t.Context(), dir, "php", []string{"."}, "", root)
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	key := `fixture.php::Orm\Validator::Request#wire`
	before := read("string", "list<int>", false)
	if before[key] != `{"kind":"text","items":"list<integer>"}` {
		t.Fatalf("PHP record declaration was not extracted: %q", before[key])
	}
	contract := []Record{{ID: "IRRequest", Native: map[string]string{"php": `fixture.php::Orm\Validator::Request`}, Fields: map[string]string{"kind": "text", "items": "list<integer>"}}}
	if failures := checkRecords("php", before, contract); len(failures) != 0 {
		t.Fatalf("unaltered PHP record failed: %v", failures)
	}
	after := read("int", "list<int>", false)
	if after[key] != `{"kind":"integer","items":"list<integer>"}` || len(differences(before, after)) == 0 {
		t.Fatalf("PHP record type mutation was not detected: %q", after[key])
	}
	if failures := checkRecords("php", after, contract); len(failures) == 0 {
		t.Fatal("PHP record type mutation passed the common record contract")
	}
	nested := read("string", "list<string>", false)
	if failures := checkRecords("php", nested, contract); len(failures) == 0 {
		t.Fatal("PHP nested record type mutation passed the common record contract")
	}
	additional := read("string", "list<int>", true)
	if failures := checkRecords("php", additional, contract); len(failures) == 0 {
		t.Fatal("undeclared PHP record passed the common record contract")
	}
}

func TestPHPRecordsMatchCommonContract(t *testing.T) {
	testcase.Start(t, testcase.Process)
	if _, err := exec.LookPath("php"); err != nil {
		t.Fatalf("php CLI is required: %v; install the PHP of .php-version", err)
	}
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	var manifest Manifest
	readJSON(filepath.Join(root, "contracts/interfaces.json"), &manifest)
	got, err := extract(t.Context(), root, "php", manifest.Languages["php"].Roots, "", root)
	if err != nil {
		t.Fatal(err)
	}
	if failures := checkRecords("php", got, manifest.Records); len(failures) != 0 {
		t.Fatalf("PHP record contract differs: %v", failures)
	}
}
