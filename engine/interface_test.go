package engine

import (
	"testing"
)

func TestRequestRejectsUnspecifiedStructure(t *testing.T) {
	e := testEngine(t)
	for _, body := range []string{
		`"controller_data":{},"entity":"battle"`,
		`"entity":"battle","where":{"items":[],"extra":true}`,
		`"entity":"battle","joins":[{"rel":"user","kind":"inner","query":{"entity":"user","params":[1]}}]`,
		`"entity":"battle","where":{"items":[{"pred":{"column":"seq","op":"eq","p":"0"}}]}`,
	} {
		source := []byte(`{"ir_version":1,"schema_hash":"` + e.M.SchemaHash + `","kind":"all","n_params":1,` + body + `}`)
		if _, err := e.Compile(source); err == nil {
			t.Errorf("accepted undeclared/wrongly typed request: %s", body)
		}
	}
}
