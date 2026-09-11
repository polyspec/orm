package main

import (
	"reflect"
	"testing"
)

func TestValueOnlyTerminalTokens(t *testing.T) {
	v := &vocabulary{
		heads:     map[string]bool{"Battle": true},
		terminals: map[string]bool{"getCountByServiceSeq": true, "gets": true, "all": true},
		navs:      map[string]bool{},
		other:     map[string]bool{"bind": true, "serviceSeq": true},
	}
	want := []string{"query Battle", "bind", "getCountByServiceSeq", "query Battle", "bind", "serviceSeq", "gets"}
	sources := map[string]string{
		"example.go":  "package main\nfunc demo() { q := gen.Battle().Bind(ctx, db); q.GetCountByServiceSeq(7); rows, _ := gen.Battle().Bind(ctx, db).ServiceSeq(7).Gets(); for range rows.All() {} }",
		"example.php": "<?php $q = (new Battle)->bind($db); $q->getCountByServiceSeq(7); $rows = (new Battle)->bind($db)->serviceSeq(7)->gets(); foreach ($rows as $row) {}",
		"example.rs":  "let q = Battle::new().bind(&db); q.get_count_by_service_seq(7).await?; let rows = Battle::new().bind(&db).service_seq(7).gets().await?; for row in &rows {}",
	}
	for path, src := range sources {
		if got := tokenize(v, path, src); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: got %v, want %v", path, got, want)
		}
	}
	if got := tokenize(v, "query.go", "package main\nfunc f() { q.All() }"); !reflect.DeepEqual(got, []string{"all"}) {
		t.Fatalf("zero-argument query alias disappeared: %v", got)
	}
}
