package contracts

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/schema"
)

func TestPointColumnTypeMappings(t *testing.T) {
	c := &schema.Col{Type: "point"}
	for lang, want := range map[string]string{"go": "orm.Point", "php": "array", "rust": "orm::Point", "typescript": "Point"} {
		if got := colType(c, lang); got != want {
			t.Errorf("%s point type=%q want %q", lang, got, want)
		}
	}
}

func TestLogicalContractRejectsNativeDrift(t *testing.T) {
	base, err := load()
	if err != nil {
		t.Fatal(err)
	}
	for _, lang := range []string{"go", "php", "rust", "typescript"} {
		t.Run(lang, func(t *testing.T) {
			var d document
			_ = json.Unmarshal(source, &d)
			for i := range d.Rules {
				if d.Rules[i].ID == "Query.gets" {
					n := d.Rules[i].Native[lang]
					old := map[string]string{"go": "*orm.Collection[{Entity}Row]", "php": "Orm\\Collection", "rust": "Collection<{Entity}Row>", "typescript": "Collection<{Entity}Row>"}[lang]
					n.Signature = strings.Replace(n.Signature, old, map[string]string{"go": "int64", "php": "int", "rust": "i64", "typescript": "number"}[lang], 1)
					d.Rules[i].Native[lang] = n
				}
			}
			if validateRules(d) == nil {
				t.Fatal("a matching native snapshot could silently change Collection to scalar")
			}
		})
	}
	for _, mutate := range []func(*document){
		func(d *document) { d.Rules[0].Inputs = []string{"ColumnValue"} },
		func(d *document) { d.Rules[0].Output = "Collection<Row>" },
		func(d *document) {
			n := d.Rules[0].Native["rust"]
			n.Signature = strings.Replace(n.Signature, "&mut self", "self", 1)
			d.Rules[0].Native["rust"] = n
		},
		func(d *document) {
			n := d.Rules[0].Native["rust"]
			n.Signature = strings.Replace(n.Signature, "async ", "", 1)
			d.Rules[0].Native["rust"] = n
		},
	} {
		var d document
		_ = json.Unmarshal(source, &d)
		mutate(&d)
		if validateRules(d) == nil {
			t.Fatal("inconsistent logical/native contract accepted")
		}
	}
	if len(base.Rules) < 26 {
		t.Fatal("core Query/Where/Row rules missing")
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
