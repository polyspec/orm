package contracts

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestLogicalContractRejectsNativeDrift(t *testing.T) {
	base, err := load()
	if err != nil {
		t.Fatal(err)
	}
	for _, lang := range []string{"go", "php", "rust"} {
		t.Run(lang, func(t *testing.T) {
			var d document
			_ = json.Unmarshal(source, &d)
			for i := range d.Rules {
				if d.Rules[i].ID == "Query.gets" {
					n := d.Rules[i].Native[lang]
					old := map[string]string{"go": "*orm.Collection[{Entity}Row]", "php": "Orm\\Collection", "rust": "Collection<{Entity}Row>"}[lang]
					n.Signature = strings.Replace(n.Signature, old, map[string]string{"go": "int64", "php": "int", "rust": "i64"}[lang], 1)
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
