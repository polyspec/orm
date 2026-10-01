package orm

import (
	"encoding/json"
	"errors"
	"github.com/polyspec/orm/engine/schema"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestPhysicalDocument(t *testing.T) {
	start := startCaseClock(t)
	t.Log("RUN physical-document")
	defer func() {
		t.Logf("DONE physical-document %s", start.wallTime())
		start.assertWithin(t, "physical-document", 15*time.Second)
	}()
	var f struct {
		TableName, ColumnName, TypeSql, ColumnComment, Prefix, Suffix, Newline string
		DisplayStrings                                                         []string
		Mutations                                                              []struct {
			ID, From, To, Path string
			Line               int
		}
	}
	raw, err := os.ReadFile("../../../contracts/fixtures/physical_document.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Mutations) != 7 {
		t.Fatal("missing document vectors")
	}
	raw, err = os.ReadFile("../../../contracts/fixtures/physical_graph_records.json")
	if err != nil {
		t.Fatal(err)
	}
	var records struct{ Base map[string]any }
	if err = json.Unmarshal(raw, &records); err != nil {
		t.Fatal(err)
	}
	v := records.Base
	table := v["tables"].([]any)[0].(map[string]any)
	table["identity"].([]any)[2] = f.TableName
	column := table["columns"].([]any)[0].(map[string]any)
	column["name"] = f.ColumnName
	column["typeSql"] = f.TypeSql
	column["comment"] = f.ColumnComment
	original := v["foreignKeys"].([]any)[0].(map[string]any)
	fk := map[string]any{}
	for k, x := range original {
		fk[k] = x
	}
	fk["id"] = "fk-2"
	fk["name"] = "FK.Second"
	v["foreignKeys"] = append(v["foreignKeys"].([]any), fk)
	graph, err := schema.PhysicalGraphFromValue(v)
	if err != nil {
		t.Fatal(err)
	}
	text, err := schema.EmitPhysicalDocument(graph, f.Prefix, f.Suffix, f.Newline)
	if err != nil {
		t.Fatal(err)
	}
	doc, err := schema.ParsePhysicalDocument(text)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(doc.Graph.Value(), graph.Value()) || doc.Prefix != f.Prefix || doc.Suffix != f.Suffix {
		t.Fatal("changed document")
	}
	again, err := schema.EmitPhysicalDocument(doc.Graph, doc.Prefix, doc.Suffix, doc.Newline)
	if err != nil || string(again) != string(text) {
		t.Fatal("non-idempotent emission", err)
	}
	if strings.Count(doc.Diagram, " : ") != 2 {
		t.Fatal("lost parallel FK")
	}
	for _, s := range f.DisplayStrings {
		if schema.RestorePhysicalDisplay(schema.PhysicalDisplay(s)) != s {
			t.Fatal("display changed")
		}
	}
	for _, c := range f.Mutations {
		t.Run(c.ID, func(t *testing.T) {
			bad := strings.Replace(string(text), c.From, c.To, 1)
			if bad == string(text) {
				t.Fatal("missing mutation target")
			}
			_, err := schema.ParsePhysicalDocument([]byte(bad))
			var diagnostic *schema.PhysicalDocumentError
			if !errors.As(err, &diagnostic) || diagnostic.Line() != c.Line || diagnostic.Path() != c.Path || err.Error() != "SCHEMA_INVALID" {
				t.Fatal("wrong diagnostic", err)
			}
		})
	}
	if _, err := schema.ParsePhysicalDocument(append(append([]byte{}, text...), text...)); err == nil {
		t.Fatal("duplicate accepted")
	}
	for _, prefix := range []string{"No newline", "<!--\n"} {
		if _, err := schema.EmitPhysicalDocument(graph, prefix, "", "\n"); err == nil {
			t.Fatal("invalid prose accepted")
		}
	}
	for _, field := range []string{"tables", "foreignKeys", "indices", "keys", "checks"} {
		v[field] = []any{}
	}
	empty, err := schema.PhysicalGraphFromValue(v)
	if err != nil {
		t.Fatal(err)
	}
	text, err = schema.EmitPhysicalDocument(empty, "", "", "\n")
	if err != nil {
		t.Fatal(err)
	}
	doc, err = schema.ParsePhysicalDocument(text)
	if err != nil || !reflect.DeepEqual(doc.Graph.Value(), empty.Value()) {
		t.Fatal("empty graph changed", err)
	}
}
