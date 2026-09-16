package ormgen

import (
	"reflect"
	"testing"
)

func TestValueOnlyTerminalTokens(t *testing.T) {
	v := &vocabulary{
		heads:     map[string]bool{"Battle": true},
		terminals: map[string]bool{"getCountByServiceSeq": true, "gets": true, "all": true},
		navs:      map[string]bool{},
		other:     map[string]bool{"using": true, "serviceSeq": true},
	}
	want := []string{"query Battle", "using", "getCountByServiceSeq", "query Battle", "using", "serviceSeq", "gets"}
	sources := map[string]string{
		"example.go":  "package main\nfunc demo() { q := gen.Battle().Using(ctx, db); q.GetCountByServiceSeq(7); rows, _ := gen.Battle().Using(ctx, db).ServiceSeq(7).Gets(); for range rows.All() {} }",
		"example.php": "<?php $q = Battle::query()->using($db); $q->getCountByServiceSeq(7); $rows = Battle::query()->using($db)->serviceSeq(7)->gets(); foreach ($rows as $row) {}",
		"example.rs":  "let q = battle::query().using(&db); q.get_count_by_service_seq(7).await?; let rows = battle::query().using(&db).service_seq(7).gets().await?; for row in &rows {}",
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
