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

func TestRelations(t *testing.T) {
	e := testEngine(t)
	// root battle → one user (if_parent, flatten) ; join service → many modules (key_by, limit_per_parent, nested one service, drop_child_key)
	p := compile(t, e, `"kind":"all","entity":"battle",
	 "columns":{"mode":"none"},
	 "where":{"items":[{"pred":{"column":"service_seq","op":"eq","p":0}}]},
	 "order":[{"column":"seq","desc":true}],"limit":{"offset":0,"count":20},
	 "joins":[{"rel":"service","kind":"inner","query":{"entity":"service",
	    "relations":[{"rel":"modules","query":{"entity":"service_module","key_by":"name","limit_per_parent":3,"drop_child_key":true,
	       "order":[{"column":"seq","desc":true}],
	       "relations":[{"rel":"service","query":{"entity":"service","order":[{"column":"seq","desc":false}]}}]}}]}}],
	 "relations":[{"rel":"user","query":{"entity":"user","flatten":true,"if_parent":{"column":"is_close","p":1},
	    "where":{"items":[{"pred":{"column":"name","op":"contains","p":2}}]}}}]`)
	if len(p.Steps) != 4 {
		t.Fatalf("steps: %d", len(p.Steps))
	}
	main := p.Steps[0]
	// mode none = PK + FK; is_close is added because the user relation's if_parent needs it
	if want := "SELECT `a`.`seq` AS `a__seq`, `a`.`user_seq` AS `a__user_seq`, `a`.`service_seq` AS `a__service_seq`, `a`.`service_module_seq` AS `a__service_module_seq`, `a`.`service_member_seq` AS `a__service_member_seq`, `a`.`is_close` AS `a__is_close`, `service`.`seq` AS `service__seq`, `service`.`name` AS `service__name` FROM `battle` AS `a` INNER JOIN `service` AS `service` ON `a`.`service_seq` = `service`.`seq` WHERE `a`.`service_seq` = ? ORDER BY `a`.`seq` DESC LIMIT 0, 20"; main.SQL != want {
		t.Errorf("main:\n got  %s\n want %s", main.SQL, want)
	}
	// step 1: user rows for the battles (parent index 1 = user_seq), only for closed battles
	u := p.Steps[1]
	if want := "SELECT `a`.`seq` AS `a__seq`, `a`.`name` AS `a__name` FROM `user` AS `a` WHERE `a`.`seq` IN (?) AND (`a`.`name` LIKE ?)"; u.SQL != want || u.Role != "relation" {
		t.Errorf("user step:\n got  %s (%s)\n want %s", u.SQL, u.Role, want)
	}
	if u.Parent == nil || u.Parent.Step != 0 || u.Parent.Index != 1 || u.Parent.Column != "user_seq" || u.Parent.IfParent == nil || u.Parent.IfParent.Index != 5 || u.Parent.IfParent.Param != 1 {
		t.Errorf("user parent: %+v", u.Parent)
	}
	if len(u.BindSlots) != 2 || u.BindSlots[0].From != "parent" || u.BindSlots[0].Step != 0 || u.BindSlots[1].Transform != "like_contains" {
		t.Errorf("user binds: %+v", u.BindSlots)
	}
	// step 2: modules per service, 3 per parent by seq desc, service_seq hidden; step 3: nested one service ordered → per-parent 1
	m := p.Steps[2]
	if want := "SELECT `orm_w`.`a__seq`, `orm_w`.`a__service_seq`, `orm_w`.`a__name` FROM (SELECT `a`.`seq` AS `a__seq`, `a`.`service_seq` AS `a__service_seq`, `a`.`name` AS `a__name`, ROW_NUMBER() OVER (PARTITION BY `a`.`service_seq` ORDER BY `a`.`seq` DESC) AS `orm_rn` FROM `service_module` AS `a` WHERE `a`.`service_seq` IN (?)) AS `orm_w` WHERE `orm_w`.`orm_rn` <= 3 ORDER BY `orm_w`.`a__service_seq`, `orm_w`.`orm_rn`"; m.SQL != want {
		t.Errorf("modules step:\n got  %s\n want %s", m.SQL, want)
	}
	if m.Parent.Step != 0 || m.Parent.Index != 6 || !m.Assemble.Columns[1].Hidden {
		t.Errorf("modules parent/hidden: %+v %+v", m.Parent, m.Assemble.Columns)
	}
	sv := p.Steps[3]
	if !strings.Contains(sv.SQL, "ROW_NUMBER() OVER (PARTITION BY `a`.`seq` ORDER BY `a`.`seq` ASC)") || !strings.Contains(sv.SQL, "`orm_rn` <= 1") || sv.Parent.Step != 2 || sv.Parent.Index != 1 {
		t.Errorf("nested service step: %s %+v", sv.SQL, sv.Parent)
	}
	// children wiring
	root := main.Assemble
	if len(root.Children) != 2 || root.Children[0].Kind != "join" || root.Children[1].Kind != "one" || root.Children[1].Step != 1 || root.Children[1].ParentIndex != 1 || root.Children[1].ChildIndex != 0 || !root.Children[1].Flatten {
		t.Errorf("root children: %+v", root.Children)
	}
	js := root.Children[0].Assemble
	if len(js.Children) != 1 || js.Children[0].Kind != "many" || js.Children[0].Step != 2 || js.Children[0].ParentIndex != 6 || js.Children[0].ChildIndex != 1 || js.Children[0].KeyIndex != 2 || js.Children[0].KeyBy != "name" {
		t.Errorf("join children: %+v", js.Children[0])
	}
	if mc := p.Steps[2].Assemble.Children; len(mc) != 1 || mc[0].Kind != "one" || mc[0].Step != 3 || mc[0].ParentIndex != 1 {
		t.Errorf("modules children: %+v", mc)
	}
	// paginate: main, its relation, then count
	p = compile(t, e, `"kind":"paginate","entity":"service","limit":{"offset":0,"count":10},"relations":[{"rel":"modules","query":{"entity":"service_module"}}]`)
	if len(p.Steps) != 3 || p.Steps[1].Role != "relation" || p.Steps[2].Role != "count" {
		t.Errorf("paginate roles: %s %s %s", p.Steps[0].Role, p.Steps[1].Role, p.Steps[2].Role)
	}
	// zero-order one relation: plain IN, executor takes the first row
	p = compile(t, e, `"kind":"one","entity":"battle","where":{"items":[{"pred":{"column":"seq","op":"eq","p":0}}]},"relations":[{"rel":"user","query":{"entity":"user"}}]`)
	if want := "SELECT `a`.`seq` AS `a__seq`, `a`.`name` AS `a__name` FROM `user` AS `a` WHERE `a`.`seq` IN (?)"; p.Steps[1].SQL != want {
		t.Errorf("plain relation: %s", p.Steps[1].SQL)
	}
	for irs, code := range map[string]string{
		`"kind":"all","entity":"battle","relations":[{"rel":"user","query":{"entity":"user","key_by":"name"}}]`:      "IR_INVALID",
		`"kind":"all","entity":"service","relations":[{"rel":"modules","query":{"entity":"service_module","flatten":true}}]`: "IR_INVALID",
		`"kind":"all","entity":"battle","n_params":2,"relations":[{"rel":"user","query":{"entity":"user","if_parent":{"column":"nope","p":0}}}]`: "COLUMN_UNKNOWN",
	} {
		_, err := e.Compile([]byte(`{"ir_version":1,"schema_hash":"` + e.M.SchemaHash + `",` + irs + `}`))
		if err == nil || !strings.HasPrefix(err.Error(), code) {
			t.Errorf("%s\n got %v\n want %s", irs, err, code)
		}
	}
}
