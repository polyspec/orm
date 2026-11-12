package engine

import "testing"

// The benchmark of the compile path: a timing loop over the bench model, not a behaviour case.

func BenchmarkCompileList(b *testing.B) {
	e := testEngine(&testing.T{})
	in := []byte(`{"ir_version":1,"manifest_hash":"` + e.M.ManifestHash + `","kind":"all","entity":"author","n_params":8,
	 "where":{"items":[` + selectAllItems + `]},"order":[{"column":"seq","desc":true}],"limit":{"offset":0,"count":100}}`)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := e.Compile(in); err != nil {
			b.Fatal(err)
		}
	}
}
