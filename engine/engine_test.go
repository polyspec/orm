package engine

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/maxkwon/orm/engine/plan"
	"github.com/maxkwon/orm/engine/schema"
)

func testEngine(t *testing.T) *Engine {
	t.Helper()
	src, err := os.ReadFile("../schema/bench.mmd")
	if err != nil {
		t.Fatal(err)
	}
	d, err := schema.Parse(string(src))
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	e, err := New(m, "mysql")
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func compile(t *testing.T, e *Engine, irBody string) *plan.Plan {
	t.Helper()
	full := `{"ir_version":1,"schema_hash":"` + e.M.SchemaHash + `","n_params":64,` + irBody + `}`
	out, err := e.Compile([]byte(full))
	if err != nil {
		t.Fatalf("compile %s: %v", irBody, err)
	}
	var p plan.Plan
	if err := json.Unmarshal(out, &p); err != nil {
		t.Fatal(err)
	}
	return &p
}

func TestSelectAll(t *testing.T) {
	e := testEngine(t)
	p := compile(t, e, `"kind":"all","entity":"battle",
	 "where":{"items":[
	   {"pred":{"column":"service_seq","op":"eq","p":0}},
	   {"pred":{"conn":"and","column":"is_close","op":"eq","p":1}},
	   {"group":{"conn":"and","items":[
	     {"pred":{"column":"is_display","op":"eq","p":2}},
	     {"group":{"conn":"or","items":[
	       {"pred":{"column":"is_display","op":"eq","p":3}},
	       {"pred":{"conn":"and","column":"display_start_dt","op":"lt","p":4}}]}}]}},
	   {"pred":{"conn":"and","column":"seq","op":"in","ps":[5,6,7]}},
	   {"pred":{"conn":"and","column":"aes_hex_email","op":"eq","p":8}},
	   {"pred":{"conn":"and","column":"name","op":"contains","p":9}}]},
	 "order":[{"column":"seq","desc":true}],"limit":{"offset":0,"count":100}`)
	sql := p.Steps[0].SQL
	wantParts := []string{
		"SELECT `a`.`seq` AS `a__seq`, `a`.`name` AS `a__name`, ",
		"AES_DECRYPT(UNHEX(`a`.`aes_hex_email`), ?) AS `a__aes_hex_email`",
		" FROM `battle` AS `a` WHERE `a`.`service_seq` = ? AND `a`.`is_close` = ? AND (`a`.`is_display` = ? OR (`a`.`is_display` = ? AND `a`.`display_start_dt` < ?)) AND `a`.`seq` IN (?, ?, ?) AND `a`.`aes_hex_email` = HEX(AES_ENCRYPT(?, ?)) AND `a`.`name` LIKE ? ORDER BY `a`.`seq` DESC LIMIT 0, 100",
	}
	for _, w := range wantParts {
		if !strings.Contains(sql, w) {
			t.Errorf("sql missing %q\n got: %s", w, sql)
		}
	}
	if strings.Contains(sql, "`a`.`description`") {
		t.Error("lazy column selected by default")
	}
	// binds: 2 secrets for the two aes_hex reads, then params in order (the aes_hex eq adds a secret), contains gets a transform.
	var kinds []string
	for _, b := range p.Steps[0].BindSlots {
		k := b.From
		if b.From == "param" {
			k = fmt.Sprintf("p%d", b.Param)
		}
		if b.Transform != "" {
			k += ":" + b.Transform
		}
		kinds = append(kinds, k)
	}
	if got := strings.Join(kinds, " "); got != "secret secret p0 p1 p2 p3 p4 p5 p6 p7 p8 secret p9:like_contains" {
		t.Errorf("bind kinds: %s", got)
	}
	asm := p.Steps[0].Assemble
	if asm == nil || asm.Columns[0].Name != "seq" || asm.Columns[0].Index != 0 || len(asm.Columns) != 25 {
		t.Errorf("assemble: %+v", asm)
	}
}

func TestJoinAndNav(t *testing.T) {
	e := testEngine(t)
	p := compile(t, e, `"kind":"count","entity":"battle",
	 "joins":[{"rel":"service_module","kind":"left","query":{"entity":"service_module",
	    "on":{"items":[{"pred":{"column":"name","op":"eq","p":0}}]},
	    "where":{"items":[{"pred":{"column":"service_seq","op":"eq","p":1}}]},
	    "joins":[{"rel":"service","kind":"inner","query":{"entity":"service"}}]}}],
	 "where":{"items":[
	   {"pred":{"column":"user_seq","op":"eq","p":2}},
	   {"group":{"conn":"and","items":[
	     {"pred":{"column":"is_close","op":"eq","p":1}},
	     {"nav":{"conn":"or","rel":"service_module","group":{"items":[
	        {"pred":{"column":"seq","op":"gt","p":3}},
	        {"nav":{"conn":"and","rel":"service","group":{"items":[{"pred":{"column":"name","op":"eq","p":4}}]}}}]}}}]}}]}`)
	want := "SELECT COUNT(*) FROM `battle` AS `a` LEFT JOIN `service_module` AS `service_module` ON `a`.`service_module_seq` = `service_module`.`seq` AND `service_module`.`name` = ? INNER JOIN `service` AS `service_module__service` ON `service_module`.`service_seq` = `service_module__service`.`seq` WHERE `a`.`user_seq` = ? AND (`a`.`is_close` = ? OR (`service_module`.`seq` > ? AND (`service_module__service`.`name` = ?))) AND (`service_module`.`service_seq` = ?)"
	if p.Steps[0].SQL != want {
		t.Errorf("sql:\n got  %s\n want %s", p.Steps[0].SQL, want)
	}
}

func TestWrites(t *testing.T) {
	e := testEngine(t)
	p := compile(t, e, `"kind":"insert","entity":"battle","set":[
	  {"column":"name","p":0},{"column":"aes_hex_email","p":1},{"column":"user_seq","p":2},
	  {"column":"service_seq","p":3},{"column":"service_module_seq","p":4},{"column":"service_member_seq","p":5},
	  {"column":"start_dt","p":6},{"column":"end_dt","p":7}]`)
	if want := "INSERT INTO `battle` (`name`, `aes_hex_email`, `user_seq`, `service_seq`, `service_module_seq`, `service_member_seq`, `start_dt`, `end_dt`) VALUES (?, HEX(AES_ENCRYPT(?, ?)), ?, ?, ?, ?, ?, ?)"; p.Steps[0].SQL != want {
		t.Errorf("insert: %s", p.Steps[0].SQL)
	}
	p = compile(t, e, `"kind":"update","entity":"battle","set":[{"column":"name","p":0},{"column":"like_count","plus_p":1},{"column":"read_count","minus_p":2}],
	  "where":{"items":[{"pred":{"column":"seq","op":"eq","p":3}}]},"optimistic":{"column":"updated_ts","p":4}`)
	if want := "UPDATE `battle` SET `name` = ?, `like_count` = `like_count` + ?, `read_count` = CASE WHEN `read_count` > ? THEN `read_count` - ? ELSE 0 END WHERE `battle`.`seq` = ? AND `battle`.`updated_ts` = ?"; p.Steps[0].SQL != want {
		t.Errorf("update: %s", p.Steps[0].SQL)
	}
	p = compile(t, e, `"kind":"delete","entity":"battle","where":{"items":[{"pred":{"column":"seq","op":"in","ps":[0,1]}}]}`)
	if want := "DELETE FROM `battle` WHERE `battle`.`seq` IN (?, ?)"; p.Steps[0].SQL != want {
		t.Errorf("delete: %s", p.Steps[0].SQL)
	}
	p = compile(t, e, `"kind":"paginate","entity":"battle","where":{"items":[{"pred":{"column":"service_seq","op":"eq","p":2}}]},"order":[{"column":"seq","desc":true}],"limit":{"offset":20,"count":20}`)
	if len(p.Steps) != 2 || p.Steps[1].Role != "count" || !strings.HasPrefix(p.Steps[1].SQL, "SELECT COUNT(*)") || !strings.HasSuffix(p.Steps[0].SQL, "LIMIT 20, 20") {
		t.Errorf("paginate: %+v", p.Steps)
	}
}

func TestCompileErrors(t *testing.T) {
	e := testEngine(t)
	h := e.M.SchemaHash
	cases := map[string]string{
		`{"ir_version":2,"schema_hash":"` + h + `","kind":"all","entity":"battle"}`:                                                                                                             "VERSION_MISMATCH",
		`{"ir_version":1,"schema_hash":"nope","kind":"all","entity":"battle"}`:                                                                                                                  "SCHEMA_HASH_MISMATCH",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"nope"}`:                                                                                                               "ENTITY_UNKNOWN",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","n_params":8,"where":{"items":[{"pred":{"column":"nope","op":"eq","p":2}}]}}`:                                              "COLUMN_UNKNOWN",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","n_params":8,"where":{"items":[{"pred":{"column":"name","op":"gt","p":0}}]}}`:                                              "OPERATOR_NOT_ALLOWED",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","n_params":8,"where":{"items":[{"pred":{"column":"aes_hex_email","op":"contains","p":0}}]}}`:                               "OPERATOR_NOT_ALLOWED",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","where":{"items":[{"pred":{"conn":"or","column":"seq","op":"eq","p":2}}]}}`:                                   "OR_AT_GROUP_START",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","where":{"items":[{"pred":{"column":"seq","op":"in","ps":[]}}]}}`:                                             "EMPTY_IN",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","where":{"items":[{"pred":{"column":"seq","op":"gt"}}]}}`:                                                     "IR_INVALID",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","n_params":1,"where":{"items":[{"pred":{"column":"seq","op":"eq","p":7}}]}}`:                                  "IR_INVALID: param index 7 out of range",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","where":{"items":[{"nav":{"rel":"service","group":{"items":[{"pred":{"column":"seq","op":"eq","p":2}}]}}}]}}`: "ENTITY_NOT_JOINED",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","joins":[{"rel":"nope","kind":"inner","query":{"entity":"service"}}]}`:                                        "RELATION_UNKNOWN",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"update","entity":"battle","n_params":1,"set":[{"column":"name","p":0}]}`:                                                             "IR_INVALID: update without where",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","force_index":"nope"}`:                                                                                        "INDEX_UNKNOWN",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","order":[{"expr":"DATE(` + "`nope`" + `)"}]}`:                                                                 "COLUMN_UNKNOWN",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","relations":[{"rel":"service","query":{"entity":"service","limit":{"offset":0,"count":1}}}]}`:                 "LIMIT_IN_RELATION",
	}
	for irs, code := range cases {
		_, err := e.Compile([]byte(irs))
		if err == nil || !strings.HasPrefix(err.Error(), code) {
			t.Errorf("%s\n got %v\n want %s", irs, err, code)
		}
	}
}

func BenchmarkCompileList(b *testing.B) {
	e := testEngine(&testing.T{})
	in := []byte(`{"ir_version":1,"schema_hash":"` + e.M.SchemaHash + `","kind":"all","entity":"battle","n_params":8,
	 "where":{"items":[{"pred":{"column":"service_seq","op":"eq","p":0}},{"pred":{"conn":"and","column":"is_close","op":"eq","p":1}},
	 {"group":{"conn":"and","items":[{"pred":{"column":"is_display","op":"eq","p":2}},{"group":{"conn":"or","items":[{"pred":{"column":"is_display","op":"eq","p":3}},{"pred":{"conn":"and","column":"display_start_dt","op":"lt","p":4}}]}}]}},
	 {"pred":{"conn":"and","column":"seq","op":"in","ps":[5,6,7]}}]},"order":[{"column":"seq","desc":true}],"limit":{"offset":0,"count":100}}`)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := e.Compile(in); err != nil {
			b.Fatal(err)
		}
	}
}
