package engine

import (
	"testing"
)

func TestRequestRejectsUnspecifiedStructure(t *testing.T) {
	e := testEngine(t)
	for _, body := range []string{
		`"controller_data":{},"entity":"author"`,
		`"entity":"author","where":{"items":[],"extra":true}`,
		`"entity":"author","joins":[{"rel":"user","kind":"inner","query":{"entity":"user","params":[1]}}]`,
		`"entity":"author","where":{"items":[{"pred":{"column":"seq","op":"eq","p":"0"}}]}`,
	} {
		source := []byte(`{"ir_version":1,"manifest_hash":"` + e.M.ManifestHash + `","kind":"all","n_params":1,` + body + `}`)
		if _, err := e.Compile(source); err == nil {
			t.Errorf("accepted undeclared/wrongly typed request: %s", body)
		}
	}
}
