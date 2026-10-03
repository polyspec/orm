package ir

import (
	"testing"

	"github.com/polyspec/orm/engine/runtimemodel"
	"github.com/polyspec/orm/internal/testcase"
)

func FuzzDecodeRequest(f *testing.F) {
	testcase.Start(f, testcase.Compute)
	f.Add([]byte(`{"ir_version":1,"manifest_hash":"x","kind":"all","entity":"user","n_params":0}`))
	f.Add([]byte(`{"kind":"all","entity":"user","where":{"items":[]}}`))
	f.Fuzz(func(t *testing.T, input []byte) {
		model := &runtimemodel.Model{ManifestHash: "x", Entities: map[string]*runtimemodel.Entity{}}
		_, _ = Decode(model, input)
	})
}
