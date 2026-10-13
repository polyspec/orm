package main

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

// componentManifest is the smallest manifest that validateManifest accepts apart from its components and rules.
func componentManifest(t *testing.T, components []string, rules ...string) Manifest {
	t.Helper()
	m := Manifest{
		Version:           1,
		Languages:         map[string]Language{"go": {}, "php": {}, "rust": {}, "typescript": {}, "python": {}},
		SymbolHashes:      map[string]string{"go": "", "php": "", "rust": "", "typescript": "", "python": ""},
		ProhibitedSymbols: []string{"multi_statement"},
		Sequences:         []Sequence{{ID: "s"}},
	}
	for _, c := range components {
		m.Components = append(m.Components, json.RawMessage(c))
	}
	for _, id := range rules {
		m.Rules = append(m.Rules, Rule{ID: id})
	}
	return m
}

func TestManifestRefusesComponentMethodWithoutRule(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	component := `{"id":"Dbspec","methods":["readFile","readSet"]}`
	if err := validateManifest(componentManifest(t, []string{component}, "Dbspec.readFile", "Dbspec.readSet")); err != nil {
		t.Fatalf("a component whose every method has a rule was refused: %v", err)
	}
	err := validateManifest(componentManifest(t, []string{component}, "Dbspec.readFile"))
	if err == nil {
		t.Fatal("the manifest check accepted the component method Dbspec.readSet that no rule declares")
	}
	if !strings.Contains(err.Error(), "Dbspec.readSet") {
		t.Fatalf("the refusal does not name the method Dbspec.readSet: %v", err)
	}
}

func TestManifestComponentMethodsHaveRules(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	var m Manifest
	readJSON(filepath.Join(root, "contracts/interfaces.json"), &m)
	if err := validateManifest(m); err != nil {
		t.Fatal(err)
	}
}

func TestManifestRefusesRuleWithoutComponentMethod(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	component := `{"id":"SchemaUtils","methods":["register"]}`
	for _, id := range []string{"SchemaUtils.addTablesAndColumns", "Missing.register"} {
		err := validateManifest(componentManifest(t, []string{component}, "SchemaUtils.register", id))
		if err == nil {
			t.Fatalf("the manifest check accepted the rule %s whose method no component lists", id)
		}
		if !strings.Contains(err.Error(), id) {
			t.Fatalf("the refusal does not name the rule %s: %v", id, err)
		}
	}
}

// An internal component (its "internal" field states why) is an operation each client implements privately with no
// common signature: its methods have no rule, and a rule may not name one of them.
func TestManifestInternalComponentMethodsHaveNoRule(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	internal := `{"id":"Planner","methods":["plan"],"internal":"Each client plans privately.","internal_ko":"각 client가 비공개로 plan한다."}`
	if err := validateManifest(componentManifest(t, []string{internal})); err != nil {
		t.Fatalf("the method of an internal component was refused for having no rule: %v", err)
	}
	err := validateManifest(componentManifest(t, []string{internal}, "Planner.plan"))
	if err == nil || !strings.Contains(err.Error(), "Planner.plan") {
		t.Fatalf("the manifest check accepted the rule Planner.plan of an internal component: %v", err)
	}
	for _, half := range []string{`{"id":"Planner","methods":["plan"],"internal":"Each client plans privately."}`, `{"id":"Planner","methods":["plan"],"internal_ko":"각 client가 비공개로 plan한다."}`} {
		if err := validateManifest(componentManifest(t, []string{half})); err == nil || !strings.Contains(err.Error(), "Planner") {
			t.Fatalf("the manifest check accepted an internal component without its grounding in both languages: %v", err)
		}
	}
}
