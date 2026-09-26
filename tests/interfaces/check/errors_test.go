package main

import (
	"path/filepath"
	"testing"
)

func TestManifestErrorLabelsMatchCatalog(t *testing.T) {
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	codes, err := readErrorCatalog(root)
	if err != nil {
		t.Fatal(err)
	}
	var manifest Manifest
	readJSON(filepath.Join(root, "contracts/interfaces.json"), &manifest)
	rules := append(append([]Rule{}, manifest.Rules...), manifest.Storage...)
	if failures := checkErrorLabels(codes, rules, manifest.Sequences); len(failures) != 0 {
		t.Fatalf("interface error labels differ from catalog: %v", failures)
	}
}

func TestInterfaceErrorLabelsRejectContractMutations(t *testing.T) {
	codes := map[string]bool{"CONFIG": true, "DEADLOCK": true}
	rules := []Rule{{ID: "Db.transaction", Errors: []string{"CONFIG", "DEADLOCK"}}}
	sequences := []Sequence{{ID: "errors", Expected: []any{"CONFIG"}}}
	if failures := checkErrorLabels(codes, rules, sequences); len(failures) != 0 {
		t.Fatalf("valid labels failed: %v", failures)
	}
	for name, mutate := range map[string]func(){
		"unknown rule code":      func() { rules[0].Errors = []string{"CONFIG", "DEADLOK"} },
		"duplicate rule code":    func() { rules[0].Errors = []string{"CONFIG", "CONFIG"} },
		"unknown result code":    func() { sequences[0].Expected = []any{"TYPO"} },
		"non-string result code": func() { sequences[0].Expected = []any{7} },
	} {
		rules[0].Errors = []string{"CONFIG", "DEADLOCK"}
		sequences[0].Expected = []any{"CONFIG"}
		mutate()
		if failures := checkErrorLabels(codes, rules, sequences); len(failures) == 0 {
			t.Errorf("%s passed", name)
		}
	}
}
