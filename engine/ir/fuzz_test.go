package ir

import (
	"testing"

	"github.com/polyspec/orm/engine/runtimemodel"
)

func FuzzDecodeRequest(f *testing.F) {
	f.Add([]byte(`{"ir_version":1,"manifest_hash":"x","kind":"all","entity":"user","n_params":0}`))
	f.Add([]byte(`{"kind":"all","entity":"user","where":{"items":[]}}`))
	f.Fuzz(func(t *testing.T, input []byte) {
		model := &runtimemodel.Model{ManifestHash: "x", Entities: map[string]*runtimemodel.Entity{}}
		_, _ = Decode(model, input)
	})
}
