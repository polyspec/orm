package engine

import (
	"encoding/json"
	"strings"
	"testing"
)

const irList = `{"ir_version":1,"schema_hash":"s0-battle-v1","entity":"battle",
 "where":{"items":[
   {"pred":{"column":"service_seq","op":"eq","value":5}},
   {"pred":{"conn":"and","column":"is_close","op":"eq","value":0}},
   {"group":{"conn":"and","items":[
     {"pred":{"column":"is_display","op":"eq","value":1}},
     {"group":{"conn":"or","items":[
       {"pred":{"column":"is_display","op":"eq","value":2}},
       {"pred":{"conn":"and","column":"display_start_dt","op":"lt","value":"2026-09-11 00:00:00"}},
       {"pred":{"conn":"and","column":"display_end_dt","op":"gt","value":"2026-09-11 00:00:00"}}]}}]}},
   {"pred":{"conn":"and","column":"seq","op":"in","value":[1,2,3]}}]},
 "order":[{"column":"seq","dir":"desc"}],"limit":{"offset":0,"count":100}}`

const irPK = `{"ir_version":1,"schema_hash":"s0-battle-v1","entity":"battle",
 "where":{"items":[{"pred":{"column":"seq","op":"eq","value":42}}]},"limit":{"offset":0,"count":1}}`

func TestCompileList(t *testing.T) {
	out, err := Compile([]byte(irList))
	if err != nil {
		t.Fatal(err)
	}
	var p Plan
	if err := json.Unmarshal(out, &p); err != nil {
		t.Fatal(err)
	}
	want := "SELECT `a`.`seq`, `a`.`name`, `a`.`created_ts`, `a`.`updated_ts`, `a`.`is_close`, `a`.`is_display`, `a`.`display_start_dt`, `a`.`display_end_dt`, `a`.`is_allday`, `a`.`target_team_player_count`, `a`.`success_count`, `a`.`player_count`, `a`.`read_count`, `a`.`cover_url`, `a`.`user_seq`, `a`.`service_seq`, `a`.`service_module_seq`, `a`.`service_member_seq`, `a`.`start_dt`, `a`.`end_dt`, `a`.`uuid`, `a`.`is_single_play`, `a`.`like_count` FROM `battle` AS `a` WHERE `a`.`service_seq` = ? AND `a`.`is_close` = ? AND (`a`.`is_display` = ? OR (`a`.`is_display` = ? AND `a`.`display_start_dt` < ? AND `a`.`display_end_dt` > ?)) AND `a`.`seq` IN (?, ?, ?) ORDER BY `a`.`seq` DESC LIMIT 0, 100"
	if p.Steps[0].SQL != want {
		t.Fatalf("sql mismatch:\n got %s\nwant %s", p.Steps[0].SQL, want)
	}
	if n := len(p.Steps[0].BindSlots); n != 9 {
		t.Fatalf("binds = %d, want 9", n)
	}
	if len(p.Assemble.Columns) != 23 {
		t.Fatalf("assemble columns = %d", len(p.Assemble.Columns))
	}
}

func TestCompileErrors(t *testing.T) {
	cases := map[string]string{
		`{"ir_version":2,"schema_hash":"s0-battle-v1","entity":"battle"}`:                                                                               "VERSION_MISMATCH",
		`{"ir_version":1,"schema_hash":"nope","entity":"battle"}`:                                                                                       "SCHEMA_HASH_MISMATCH",
		`{"ir_version":1,"schema_hash":"s0-battle-v1","entity":"nope"}`:                                                                                 "ENTITY_UNKNOWN",
		`{"ir_version":1,"schema_hash":"s0-battle-v1","entity":"battle","columns":["nope"]}`:                                                            "COLUMN_UNKNOWN",
		`{"ir_version":1,"schema_hash":"s0-battle-v1","entity":"battle","where":{"items":[{"pred":{"conn":"or","column":"seq","op":"eq","value":1}}]}}`: "OR_AT_GROUP_START",
		`{"ir_version":1,"schema_hash":"s0-battle-v1","entity":"battle","where":{"items":[{"pred":{"column":"seq","op":"in","value":[]}}]}}`:            "EMPTY_IN",
		`{"ir_version":1,"schema_hash":"s0-battle-v1","entity":"battle","where":{"items":[{"pred":{"column":"seq","op":"gt","value":null}}]}}`:          "IR_INVALID",
	}
	for ir, code := range cases {
		_, err := Compile([]byte(ir))
		if err == nil || !strings.HasPrefix(err.Error(), code) {
			t.Errorf("ir %s: got %v, want %s", ir, err, code)
		}
	}
}

func BenchmarkCompileList(b *testing.B) {
	in := []byte(irList)
	b.ReportAllocs()
	b.SetBytes(int64(len(in)))
	for i := 0; i < b.N; i++ {
		if _, err := Compile(in); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkCompilePK(b *testing.B) {
	in := []byte(irPK)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := Compile(in); err != nil {
			b.Fatal(err)
		}
	}
}
