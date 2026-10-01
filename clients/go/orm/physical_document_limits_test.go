package orm

import (
	"bytes"
	"encoding/json"
	"errors"
	"github.com/polyspec/orm/engine/schema"
	"os"
	"reflect"
	"testing"
	"time"
)

func TestPhysicalDocumentLimits(t *testing.T) {
	raw, err := os.ReadFile("../../../contracts/fixtures/physical_graph_json.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct{ Empty map[string]any }
	if err = json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	graph, err := schema.PhysicalGraphFromValue(f.Empty)
	if err != nil {
		t.Fatal(err)
	}
	block, err := schema.EmitPhysicalDocument(graph, "", "", "\n")
	if err != nil {
		t.Fatal(err)
	}
	raw, err = os.ReadFile("../../../contracts/fixtures/physical_envelope.json")
	if err != nil {
		t.Fatal(err)
	}
	var resources struct{ Limits map[string]int }
	if err = json.Unmarshal(raw, &resources); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"bytes", "lines", "blocks"} {
		for extra := 0; extra < 2; extra++ {
			t.Run(kind+string(rune('0'+extra)), func(t *testing.T) {
				started := startCaseClock(t)
				t.Log("RUN", kind, extra)
				n := resources.Limits[kind] + extra
				var source []byte
				prefix := 0
				switch kind {
				case "bytes":
					source = bytes.Repeat([]byte("x"), n)
					copy(source, block)
				case "lines":
					prefix = n - bytes.Count(block, []byte("\n")) - 1
					source = append(bytes.Repeat([]byte("\n"), prefix), block...)
				case "blocks":
					before := bytes.Repeat([]byte("```text\n```\n"), n-1)
					prefix = len(before)
					source = append(before, block...)
				}
				doc, err := schema.ParsePhysicalDocument(source)
				if extra != 0 {
					var e *schema.PhysicalDocumentError
					if !errors.As(err, &e) || e.Line() != 0 || e.Path() != "" || e.Error() != "SCHEMA_INVALID" {
						t.Fatal("wrong diagnostic", err)
					}
				} else {
					if err != nil {
						t.Fatal(err)
					}
					if !reflect.DeepEqual(doc.Graph.Value(), graph.Value()) || !bytes.Equal([]byte(doc.Prefix), source[:prefix]) || !bytes.Equal([]byte(doc.Suffix), source[prefix+len(block):]) {
						t.Fatal("changed document")
					}
				}
				started.assertWithin(t, kind+string(rune('0'+extra)), 15*time.Second)
				t.Log("PASS", kind, extra, started.wallTime())
			})
		}
	}
}
