package ir

import (
	"errors"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/testcase"
)

func FuzzDecodeRequest(f *testing.F) {
	testcase.Start(f, testcase.Compute)
	f.Add([]byte(`{"ir_version":1,"manifest_hash":"x","kind":"all","entity":"user","n_params":0}`))
	f.Add([]byte(`{"kind":"all","entity":"user","where":{"items":[]}}`))
	f.Fuzz(func(t *testing.T, input []byte) {
		model := &runtimemodel.Model{ManifestHash: "x", Entities: map[string]*runtimemodel.Entity{}}
		if _, err := Decode(model, input); err != nil {
			var refusal *Error
			if !errors.As(err, &refusal) {
				t.Fatalf("Decode(%q) refused with %T, not with an *Error: %v", input, err, err)
			}
		}
	})
}
