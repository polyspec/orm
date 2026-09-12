package ir

import (
	"testing"

	"github.com/polyspec/orm/engine/schema"
)

func FuzzDecodeRequest(f *testing.F) {
	f.Add([]byte(`{"ir_version":1,"schema_hash":"x","kind":"all","entity":"user","n_params":0}`))
	f.Add([]byte(`{"kind":"all","entity":"user","where":{"items":[]}}`))
	f.Fuzz(func(t *testing.T, input []byte) {
		manifest := &schema.Manifest{SchemaHash: "x", Entities: map[string]*schema.Entity{}}
		_, _ = Decode(manifest, input)
	})
}
