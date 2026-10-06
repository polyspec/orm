package contracts

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

func TestLogicalContractRejectsNativeDrift(t *testing.T) {
	testcase.Start(t, testcase.Compute)
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
			old := map[string]string{"go": "*orm.Collection[*{Entity}Model]", "php": "Polyspec\\Orm\\Collection", "rust": "orm::Collection<Self>", "typescript": "Collection<this>"}[lang]
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

func TestGroupedResultCannotBecomeModelCollection(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	var d document
	if err := json.Unmarshal(source, &d); err != nil {
		t.Fatal(err)
	}
	for i := range d.Rules {
		if d.Rules[i].ID != "Model.getsCount" {
			continue
		}
		r := &d.Rules[i]
		r.Output = "Collection<Model>"
		old := map[string]string{
			"go":         "(*orm.Collection[*{Entity}Model], error)",
			"php":        "Polyspec\\Orm\\Collection",
			"rust":       "orm::Result<orm::Collection<Self>>",
			"typescript": "Promise<Collection<this>>",
		}
		current := map[string]string{
			"go":         "(*orm.GroupRows, error)",
			"php":        "Polyspec\\Orm\\GroupRows",
			"rust":       "orm::Result<orm::GroupRows>",
			"typescript": "Promise<GroupRows>",
		}
		for _, lang := range languages {
			n := r.Native[lang]
			if !strings.Contains(n.Signature, current[lang]) {
				t.Fatalf("%s grouped signature has changed: %s", lang, n.Signature)
			}
			n.Signature = strings.Replace(n.Signature, current[lang], old[lang], 1)
			r.Native[lang] = n
		}
		if err := validateRules(d); err == nil {
			t.Fatal("grouped result was accepted as a model collection")
		}
		return
	}
	t.Fatal("Model.getsCount rule is missing")
}

func TestComponentDiagramsUseRequestedLanguage(t *testing.T) {
	testcase.Start(t, testcase.Compute)
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

// TestExtensionContractRejectsDrift는 extension(PHP 확장 php-extension)의 adapter가 공통 입력과 결과의
// extension 열과 다르거나, extension이 적은 rule과 adapter를 가진 rule이 다르면 manifest를 거부하는지 확인한다.
func TestExtensionContractRejectsDrift(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	find := func(d *document, id string) *rule {
		for i := range d.Rules {
			if d.Rules[i].ID == id {
				return &d.Rules[i]
			}
		}
		t.Fatalf("rule %s is missing", id)
		return nil
	}
	for name, mutate := range map[string]func(*document){
		"return type": func(d *document) {
			r := find(d, "Dbspec.parse")
			n := r.Native["php-extension"]
			n.Signature = strings.Replace(n.Signature, "Polyspec\\Orm\\Dbspec\\Native\\ParseResult", "Polyspec\\Orm\\Dbspec\\ParseResult", 1)
			r.Native["php-extension"] = n
		},
		"argument": func(d *document) {
			r := find(d, "Dbspec.emit")
			n := r.Native["php-extension"]
			n.Signature = strings.Replace(n.Signature, "Polyspec\\Orm\\Dbspec\\Native\\Document", "Polyspec\\Orm\\Dbspec\\Document", 1)
			r.Native["php-extension"] = n
		},
		"missing adapter": func(d *document) { delete(find(d, "Dbspec.render").Native, "php-extension") },
		"unlisted adapter": func(d *document) {
			r := find(d, "Model.gets")
			r.Native["php-extension"] = r.Native["php"]
		},
		"unknown rule": func(d *document) {
			e := d.Extensions["php-extension"]
			e.Rules = append(append([]string{}, e.Rules...), "Dbspec.missing")
			d.Extensions["php-extension"] = e
		},
	} {
		var d document
		if err := json.Unmarshal(source, &d); err != nil {
			t.Fatal(err)
		}
		mutate(&d)
		if validateRules(d) == nil {
			t.Errorf("%s: an extension adapter that differs from the contract was accepted", name)
		}
	}
}
