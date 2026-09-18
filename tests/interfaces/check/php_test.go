package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestPHPRelativeTypes(t *testing.T) {
	if _, err := exec.LookPath("php"); err != nil {
		t.Fatalf("php CLI is required; tool tests never skip")
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
		got, err := extract(dir, "php", []string{"."}, "", root)
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
