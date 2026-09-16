package ormgen

import "testing"

func FuzzSplitSQL(f *testing.F) {
	for _, seed := range []string{
		"SELECT 1; SELECT 2;",
		"INSERT INTO t VALUES ('a;b'); SELECT `c;d`;",
		"DO $$ BEGIN PERFORM 'x;y'; END $$;",
		"/* ; */ -- comment ;\nSELECT 1",
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, input string) {
		for _, statement := range splitSQL(input) {
			if statement == "" {
				t.Fatal("splitSQL returned an empty statement")
			}
		}
	})
}
