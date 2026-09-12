package schema

import "testing"

func FuzzParseMermaid(f *testing.F) {
	f.Add("erDiagram\n  user {\n    int seq PK\n  }\n")
	f.Add("%% check user (seq > 0)\n")
	f.Fuzz(func(t *testing.T, input string) {
		_, _ = Parse(input)
	})
}

func FuzzLoadManifest(f *testing.F) {
	f.Add([]byte(`{"schema_hash":"x","order":[],"entities":{}}`))
	f.Add([]byte{0, 1, 2, 255})
	f.Fuzz(func(t *testing.T, input []byte) {
		_, _ = Load(input)
	})
}
