package contracts

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestLogicalContractRejectsNativeDrift(t *testing.T) {
	if _, err := load(); err != nil {
		t.Fatal(err)
	}
	find := func(d *document, id string) *rule {
		for i := range d.Rules {
			if d.Rules[i].ID == id {
				return &d.Rules[i]
			}
		}
		t.Fatalf("rule %s is missing", id)
		return nil
	}
	for _, lang := range languages {
		t.Run(lang, func(t *testing.T) {
			var d document
			_ = json.Unmarshal(source, &d)
			r := find(&d, "Model.gets")
			n := r.Native[lang]
			old := map[string]string{"go": "*orm.Collection[*{Entity}Model]", "php": "Orm\\Collection", "rust": "orm::Collection<Self>", "typescript": "Collection<this>"}[lang]
			n.Signature = strings.Replace(n.Signature, old, map[string]string{"go": "int64", "php": "int", "rust": "i64", "typescript": "number"}[lang], 1)
			r.Native[lang] = n
			if validateRules(d) == nil {
				t.Fatal("a matching native snapshot could silently change Collection to scalar")
			}
		})
	}
	for name, mutate := range map[string]func(*document){
		"inputs": func(d *document) { find(d, "Model.get").Inputs = []string{"Rows"} },
		"output": func(d *document) { find(d, "Model.get").Output = "Collection<Model>" },
		"rust receiver": func(d *document) {
			r := find(d, "Model.create")
			n := r.Native["rust"]
			n.Signature = strings.Replace(n.Signature, "&mut self", "&self", 1)
			r.Native["rust"] = n
		},
		"rust async": func(d *document) {
			r := find(d, "Model.get")
			n := r.Native["rust"]
			n.Signature = strings.Replace(n.Signature, "async ", "", 1)
			r.Native["rust"] = n
		},
	} {
		var d document
		_ = json.Unmarshal(source, &d)
		mutate(&d)
		if validateRules(d) == nil {
			t.Fatalf("%s: inconsistent logical/native contract accepted", name)
		}
	}
}

func TestComponentDiagramsUseRequestedLanguage(t *testing.T) {
	english, err := Diagram()
	if err != nil {
		t.Fatal(err)
	}
	korean, err := DiagramKO()
	if err != nil {
		t.Fatal(err)
	}
	en, ko := string(english), string(korean)
	if !strings.Contains(en, "| Component | Behavior and state |") || strings.Contains(en, "| 구성요소 |") {
		t.Fatal("English diagram contains an invalid table heading")
	}
	if !strings.Contains(ko, "| 구성요소 | 동작 및 상태 |") || strings.Contains(ko, "| Component |") {
		t.Fatal("Korean diagram contains an invalid table heading")
	}
	if strings.Count(en, "    class ") != strings.Count(ko, "    class ") || strings.Count(en, "\n| ") != strings.Count(ko, "\n| ") {
		t.Fatal("localized diagrams contain different structures")
	}
}
