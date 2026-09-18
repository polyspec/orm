package engine

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/plan"
	"github.com/polyspec/orm/engine/schema"
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
		"UNHEX(`a`.`aes_hex_email`) AS `a__aes_hex_email`",
		" FROM `battle` AS `a` WHERE `a`.`service_seq` = ? AND `a`.`is_close` = ? AND (`a`.`is_display` = ? OR (`a`.`is_display` = ? AND `a`.`display_start_dt` < ?)) AND `a`.`seq` IN (?, ?, ?) AND `a`.`email_blind_index` = ? AND `a`.`name` LIKE ? ORDER BY `a`.`seq` DESC LIMIT 0, 100",
	}
	for _, w := range wantParts {
		if !strings.Contains(sql, w) {
			t.Errorf("sql missing %q\n got: %s", w, sql)
		}
	}
	if strings.Contains(sql, "`a`.`description`") {
		t.Error("lazy column selected by default")
	}
	// Binds preserve parameter order; equality on AES uses the blind-index target.
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
	if got := strings.Join(kinds, " "); got != "p0 p1 p2 p3 p4 p5 p6 p7 p8 p9:like_contains" {
		t.Errorf("bind kinds: %s", got)
	}
	asm := p.Steps[0].Assemble
	// 27 public columns plus the hidden AES version column.
	if asm == nil || asm.Columns[0].Name != "seq" || asm.Columns[0].Index != 0 || len(asm.Columns) != 28 || asm.Columns[26].Name != "ip" || !asm.Columns[27].Hidden || !strings.Contains(sql, "INET6_NTOA(`a`.`ip`) AS `a__ip`") {
		t.Errorf("assemble: %+v", asm)
	}
}

func TestCurrentTimeExpressionUsesDialectWallClock(t *testing.T) {
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
	for _, tc := range []struct {
		dialect string
		want    string
	}{
		{"postgres", "clock_timestamp()"},
		{"sqlite", "CURRENT_TIMESTAMP"},
	} {
		e, err := New(m, tc.dialect)
		if err != nil {
			t.Fatal(err)
		}
		body := `{"kind":"one","entity":"battle","columns":{"mode":"none","expr":{"database_now":{"sql":"$CURRENT_TIME"}}}}`
		out, err := e.Compile([]byte(`{"ir_version":1,"schema_hash":"` + m.SchemaHash + `",` + body[1:]))
		if err != nil {
			t.Fatalf("%s: %v", tc.dialect, err)
		}
		if !strings.Contains(string(out), tc.want) {
			t.Fatalf("%s: expected %q in %s", tc.dialect, tc.want, out)
		}
	}
}

func TestRowLock(t *testing.T) {
	e := testEngine(t)
	p := compile(t, e, `"kind":"all","entity":"battle","lock":"update","limit":{"offset":0,"count":1}`)
	if !strings.HasSuffix(p.Steps[0].SQL, " LIMIT 0, 1 FOR UPDATE") {
		t.Fatalf("mysql row lock: %s", p.Steps[0].SQL)
	}

	src, err := os.ReadFile("../schema/bench.mmd")
	if err != nil {
		t.Fatal(err)
	}
	diagram, err := schema.Parse(string(src))
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(diagram)
	if err != nil {
		t.Fatal(err)
	}
	sqliteEngine, err := New(m, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	full := `{"ir_version":1,"schema_hash":"` + sqliteEngine.M.SchemaHash + `","n_params":0,"kind":"all","entity":"battle","lock":"share"}`
	if plan, err := sqliteEngine.Compile([]byte(full)); err != nil || strings.Contains(string(plan), "CAPABILITY_UNSUPPORTED") {
		t.Fatalf("sqlite transaction-level row lock: %v", err)
	}
	sqliteNowait := `{"ir_version":1,"schema_hash":"` + sqliteEngine.M.SchemaHash + `","n_params":0,"kind":"all","entity":"battle","lock":"update_nowait"}`
	if plan, err := sqliteEngine.Compile([]byte(sqliteNowait)); err != nil || strings.Contains(string(plan), "CAPABILITY_UNSUPPORTED") {
		t.Fatalf("sqlite nowait lock: %v", err)
	}
	postgresEngine, err := New(m, "postgres")
	if err != nil {
		t.Fatal(err)
	}
	nowait := `{"ir_version":1,"schema_hash":"` + postgresEngine.M.SchemaHash + `","n_params":0,"kind":"one","entity":"battle","lock":"update_nowait"}`
	plan, err := postgresEngine.Compile([]byte(nowait))
	if err != nil || !strings.Contains(string(plan), "FOR UPDATE NOWAIT") {
		t.Fatalf("postgres nowait row lock: %v", err)
	}
}

func mustCompileError(t *testing.T, e *Engine, input string) error {
	t.Helper()
	_, err := e.Compile([]byte(input))
	if err == nil {
		t.Fatal("expected compile error")
	}
	return err
}

func TestJoinAndPlacement(t *testing.T) {
	e := testEngine(t)
	p := compile(t, e, `"kind":"count","entity":"battle",
	 "joins":[{"rel":"service_module","kind":"left","query":{"entity":"service_module",
	    "on":{"items":[{"pred":{"column":"name","op":"eq","p":0}}]},
	    "where":{"items":[{"pred":{"column":"seq","op":"gt","p":3}}]},
	    "joins":[{"rel":"service","kind":"inner","query":{"entity":"service",
	       "where":{"items":[{"pred":{"column":"name","op":"eq","p":4}}]}}}]}}],
	 "where":{"items":[
	   {"pred":{"column":"user_seq","op":"eq","p":2}},
	   {"group":{"conn":"and","items":[
	     {"pred":{"column":"is_close","op":"eq","p":1}},
	     {"joined":{"conn":"or","join":"service_module"}}]}}]}`)
	want := "SELECT COUNT(*) FROM `battle` AS `a` LEFT JOIN `service_module` AS `service_module` ON `a`.`service_module_seq` = `service_module`.`seq` AND `service_module`.`name` = ? INNER JOIN `service` AS `service_module__service` ON `service_module`.`service_seq` = `service_module__service`.`seq` WHERE `a`.`user_seq` = ? AND (`a`.`is_close` = ? OR (`service_module`.`seq` > ?)) AND (`service_module__service`.`name` = ?)"
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
	if want := "INSERT INTO `battle` (`name`, `aes_hex_email`, `user_seq`, `service_seq`, `service_module_seq`, `service_member_seq`, `start_dt`, `end_dt`, `email_blind_index`, `aes_key_version`) VALUES (?, HEX(?), ?, ?, ?, ?, ?, ?, ?, ?)"; p.Steps[0].SQL != want {
		t.Errorf("insert: %s", p.Steps[0].SQL)
	}
	if len(p.Steps[0].BindSlots) < 9 || !slices.Equal(p.Steps[0].BindSlots[8].HostStyles, []string{"blind_index"}) {
		t.Errorf("insert blind-index bind: %+v", p.Steps[0].BindSlots)
	}
	p = compile(t, e, `"kind":"update","entity":"battle","set":[{"column":"name","p":0},{"column":"like_count","plus_p":1},{"column":"read_count","minus_p":2}],
	  "where":{"items":[{"pred":{"column":"seq","op":"eq","p":3}}]},"optimistic":{"column":"updated_ts","p":4}`)
	if want := "UPDATE `battle` SET `name` = ?, `like_count` = `battle`.`like_count` + ?, `read_count` = CASE WHEN `battle`.`read_count` > ? THEN `battle`.`read_count` - ? ELSE 0 END, `updated_ts` = CURRENT_TIMESTAMP(6) WHERE `battle`.`seq` = ? AND `battle`.`updated_ts` = ?"; p.Steps[0].SQL != want {
		t.Errorf("update: %s", p.Steps[0].SQL)
	}
	p = compile(t, e, `"kind":"update","entity":"battle","set":[{"column":"aes_hex_email","p":0},{"column":"aes_hex_phone","p":1}],"where":{"items":[{"pred":{"column":"seq","op":"eq","p":2}}]}`)
	if !strings.Contains(p.Steps[0].SQL, "`aes_key_version` = ?") || !slices.ContainsFunc(p.Steps[0].BindSlots, func(b plan.BindSlot) bool { return b.From == "config" && b.Name == "aes_version" }) {
		t.Errorf("AES update must store the configured key version: %+v", p.Steps[0])
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

func TestUpsertAndCascade(t *testing.T) {
	e := testEngine(t)
	p := compile(t, e, `"kind":"insert","entity":"battle","set":[{"column":"uuid","p":0},{"column":"name","p":1},{"column":"user_seq","p":2},{"column":"service_seq","p":2},{"column":"service_module_seq","p":2},{"column":"service_member_seq","p":2},{"column":"start_dt","p":3},{"column":"end_dt","p":3}],
	  "on_duplicate":[{"column":"name","p":1},{"column":"read_count","plus_p":4}]`)
	if want := "INSERT INTO `battle` (`uuid`, `name`, `user_seq`, `service_seq`, `service_module_seq`, `service_member_seq`, `start_dt`, `end_dt`, `aes_key_version`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE `name` = ?, `read_count` = `battle`.`read_count` + ?, `seq` = LAST_INSERT_ID(`seq`)"; p.Steps[0].SQL != want {
		t.Errorf("upsert:\n got  %s\n want %s", p.Steps[0].SQL, want)
	}
	if got := len(p.Steps[0].BindSlots); got != 11 {
		t.Errorf("upsert binds: %d", got)
	}
	// cascade: service → members (owned) yes; member → user (parent) no; no_cascade_delete stops it
	p = compile(t, e, `"kind":"one","entity":"service","where":{"items":[{"pred":{"column":"seq","op":"eq","p":0}}]},
	  "relations":[{"rel":"members","query":{"entity":"service_member","relations":[{"rel":"user","query":{"entity":"user"}}]}},
	               {"rel":"modules","query":{"entity":"service_module","no_cascade_delete":true}}]`)
	root := p.Steps[0].Assemble
	if !root.Children[0].Cascade || root.Children[1].Cascade {
		t.Errorf("cascade flags: members=%v modules=%v", root.Children[0].Cascade, root.Children[1].Cascade)
	}
	if mc := p.Steps[1].Assemble.Children; len(mc) != 1 || mc[0].Cascade {
		t.Errorf("member → user must not cascade: %+v", mc)
	}
	for irs, code := range map[string]string{
		`"kind":"update","entity":"battle","n_params":2,"set":[{"column":"name","p":0}],"where":{"items":[{"pred":{"column":"seq","op":"eq","p":1}}]},"on_duplicate":[{"column":"name","p":0}]`: "IR_INVALID: on_duplicate is only valid on insert",
		`"kind":"insert","entity":"battle","n_params":2,"set":[{"column":"name","p":0}],"on_duplicate":[{"column":"seq","p":1}]`:                                                                "IR_INVALID: on_duplicate cannot assign",
		`"kind":"update","entity":"battle","n_params":2,"set":[{"column":"aes_hex_email","p":0}],"where":{"items":[{"pred":{"column":"seq","op":"eq","p":1}}]}`:                                 "IR_INVALID: AES update must assign every AES column; missing aes_hex_phone",
		`"kind":"update","entity":"battle","n_params":2,"set":[{"column":"aes_key_version","p":0}],"where":{"items":[{"pred":{"column":"seq","op":"eq","p":1}}]}`:                               "IR_INVALID: aes_key_version is managed by the AES writer",
		`"kind":"insert","entity":"battle","n_params":2,"set":[{"column":"name","p":0},{"column":"aes_key_version","p":1}]`:                                                                     "IR_INVALID: aes_key_version is managed by the AES writer",
		`"kind":"insert","entity":"battle","n_params":2,"set":[{"column":"name","p":0}],"on_duplicate":[{"column":"aes_hex_email","p":1}]`:                                                      "IR_INVALID: AES update must assign every AES column; missing aes_hex_phone",
		`"kind":"all","entity":"battle","no_cascade_delete":true`:                                                                                                                               "IR_INVALID: relation-only options",
	} {
		_, err := e.Compile([]byte(`{"ir_version":1,"schema_hash":"` + e.M.SchemaHash + `",` + irs + `}`))
		if err == nil || !strings.HasPrefix(err.Error(), code) {
			t.Errorf("%s\n got %v\n want %s", irs, err, code)
		}
	}
}

func TestAggregates(t *testing.T) {
	e := testEngine(t)
	cases := map[string]string{
		`"kind":"count","entity":"battle","group_by":["service_seq"],"n_params":0`:                                                                                           "SELECT COUNT(*) FROM (SELECT 1 FROM `battle` AS `a` GROUP BY `a`.`service_seq`) AS `orm_g`",
		`"kind":"group_count","entity":"battle","group_by_expr":[{"expr":"ROUND(` + "`like_count`" + `)","as":"bucket"}]`:                                                    "SELECT ROUND(`a`.`like_count`) AS `a__bucket`, COUNT(*) AS `a__row_count` FROM `battle` AS `a` GROUP BY ROUND(`a`.`like_count`)",
		`"kind":"all","entity":"battle","columns":{"mode":"none"},"group_by":["service_seq"],"order":[{"column":"service_seq","desc":false}],"limit":{"offset":0,"count":2}`: "SELECT `a`.`seq` AS `a__seq`, `a`.`user_seq` AS `a__user_seq`, `a`.`service_seq` AS `a__service_seq`, `a`.`service_module_seq` AS `a__service_module_seq`, `a`.`service_member_seq` AS `a__service_member_seq` FROM `battle` AS `a` GROUP BY `a`.`service_seq` ORDER BY `a`.`service_seq` ASC LIMIT 0, 2",
	}
	for irs, want := range cases {
		p := compile(t, e, irs)
		if p.Steps[0].SQL != want {
			t.Errorf("%s\n got  %s\n want %s", irs, p.Steps[0].SQL, want)
		}
	}
	grouped := compile(t, e, `"kind":"group_count","entity":"battle","group_by":["service_seq"],"group_by_expr":[{"expr":"ROUND(`+"`like_count`"+`)","as":"bucket"}]`)
	if got := grouped.Steps[0].Assemble.Key; len(got) != 2 || got[0].Column != "service_seq" || got[0].Index != 0 || got[1].Column != "bucket" || got[1].Index != 1 {
		t.Fatalf("group_count collection key = %#v", got)
	}
	rows := compile(t, e, `"kind":"all","entity":"composite_account"`)
	if got := rows.Steps[0].Assemble.Key; len(got) != 2 || got[0].Column != "tenant_id" || got[1].Column != "account_id" {
		t.Fatalf("composite row collection key = %#v", got)
	}
	for irs, code := range map[string]string{
		`"kind":"group_count","entity":"battle","group_by_expr":[{"expr":"ROUND(` + "`nope`" + `)","as":"bucket"}]`: "COLUMN_UNKNOWN",
		`"kind":"group_count","entity":"battle","group_by_expr":[{"expr":"ROUND(like_count)","as":""}]`:             "IR_INVALID",
	} {
		_, err := e.Compile([]byte(`{"ir_version":1,"schema_hash":"` + e.M.SchemaHash + `",` + irs + `}`))
		if err == nil || !strings.HasPrefix(err.Error(), code) {
			t.Errorf("%s\n got %v\n want %s", irs, err, code)
		}
	}
}

func testEngineFor(t *testing.T, dialect string) *Engine {
	t.Helper()
	e := testEngine(t)
	pg, err := New(e.M, dialect)
	if err != nil {
		t.Fatal(err)
	}
	return pg
}

func TestPostgresAndSQLite(t *testing.T) {
	pg := testEngineFor(t, "postgres")
	p := compile(t, pg, `"kind":"all","entity":"battle","columns":{"mode":"none"},"n_params":3,
	 "where":{"items":[{"pred":{"column":"name","op":"contains","p":0}},{"pred":{"conn":"and","column":"name","op":"contains_binary","p":1}},{"pred":{"conn":"and","column":"aes_hex_email","op":"eq","p":2}}]},
	 "order":[{"column":"seq","desc":true}],"limit":{"offset":20,"count":10},"force_index":"ik"`)
	if want := "SELECT \"a\".\"seq\" AS \"a__seq\", \"a\".\"user_seq\" AS \"a__user_seq\", \"a\".\"service_seq\" AS \"a__service_seq\", \"a\".\"service_module_seq\" AS \"a__service_module_seq\", \"a\".\"service_member_seq\" AS \"a__service_member_seq\" FROM \"battle\" AS \"a\" WHERE \"a\".\"name\" ILIKE $1 AND \"a\".\"name\" LIKE $2 AND \"a\".\"email_blind_index\" = $3 ORDER BY \"a\".\"seq\" DESC LIMIT 10 OFFSET 20"; p.Steps[0].SQL != want {
		t.Errorf("postgres select:\n got  %s\n want %s", p.Steps[0].SQL, want)
	}
	// aes/hex are app-side on postgres: the read is the bare column and the styles reach the executor
	p = compile(t, pg, `"kind":"one","entity":"battle","n_params":1,"where":{"items":[{"pred":{"column":"seq","op":"eq","p":0}}]}`)
	var aes, ip *plan.OutCol
	for i := range p.Steps[0].Assemble.Columns {
		c := &p.Steps[0].Assemble.Columns[i]
		if c.Name == "aes_hex_email" {
			aes = c
		}
		if c.Name == "ip" {
			ip = c
		}
	}
	if aes == nil || strings.Join(aes.Styles, ",") != "aes,hex" || !strings.Contains(p.Steps[0].SQL, "\"a\".\"aes_hex_email\" AS \"a__aes_hex_email\"") {
		t.Errorf("postgres aes read: %+v", aes)
	}
	if ip == nil || len(ip.Styles) != 0 || !strings.Contains(p.Steps[0].SQL, "host(\"a\".\"ip\") AS \"a__ip\"") {
		t.Errorf("postgres ip read: %+v", ip)
	}
	// upsert: RETURNING, ON CONFLICT on the unique key covered by the insert (uuid), no LAST_INSERT_ID idiom
	p = compile(t, pg, `"kind":"insert","entity":"battle","n_params":3,"set":[{"column":"uuid","p":0},{"column":"name","p":1},{"column":"user_seq","p":2},{"column":"service_seq","p":2},{"column":"service_module_seq","p":2},{"column":"service_member_seq","p":2},{"column":"start_dt","p":2},{"column":"end_dt","p":2}],"on_duplicate":[{"column":"name","p":1}]`)
	if want := "INSERT INTO \"battle\" (\"uuid\", \"name\", \"user_seq\", \"service_seq\", \"service_module_seq\", \"service_member_seq\", \"start_dt\", \"end_dt\", \"aes_key_version\") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (\"uuid\") DO UPDATE SET \"name\" = $10 RETURNING \"seq\""; p.Steps[0].SQL != want {
		t.Errorf("postgres upsert:\n got  %s\n want %s", p.Steps[0].SQL, want)
	}
	// fulltext on postgres
	p = compile(t, pg, `"kind":"count","entity":"battle","n_params":1,"where":{"items":[{"pred":{"op":"match_boolean","match":["name","description"],"p":0}}]}`)
	if !strings.Contains(p.Steps[0].SQL, "to_tsvector('simple', coalesce(\"a\".\"name\", '') || ' ' || coalesce(\"a\".\"description\", '')) @@ websearch_to_tsquery('simple', $1)") {
		t.Errorf("postgres fulltext: %s", p.Steps[0].SQL)
	}

	lite := testEngineFor(t, "sqlite")
	p = compile(t, lite, `"kind":"all","entity":"battle","columns":{"mode":"none"},"n_params":1,"where":{"items":[{"pred":{"column":"name","op":"contains","p":0}}]},"limit":{"offset":0,"count":5},"force_index":"ik"`)
	if want := "SELECT \"a\".\"seq\" AS \"a__seq\", \"a\".\"user_seq\" AS \"a__user_seq\", \"a\".\"service_seq\" AS \"a__service_seq\", \"a\".\"service_module_seq\" AS \"a__service_module_seq\", \"a\".\"service_member_seq\" AS \"a__service_member_seq\" FROM \"battle\" AS \"a\" INDEXED BY \"ik\" WHERE \"a\".\"name\" LIKE ? ESCAPE '\\' LIMIT 5 OFFSET 0"; p.Steps[0].SQL != want {
		t.Errorf("sqlite select:\n got  %s\n want %s", p.Steps[0].SQL, want)
	}
	for irs, code := range map[string]string{
		`"kind":"count","entity":"battle","n_params":1,"where":{"items":[{"pred":{"op":"match","match":["name","description"],"p":0}}]}`: "OPERATOR_NOT_ALLOWED",
	} {
		_, err := lite.Compile([]byte(`{"ir_version":1,"schema_hash":"` + lite.M.SchemaHash + `",` + irs + `}`))
		if err == nil || !strings.HasPrefix(err.Error(), code) {
			t.Errorf("sqlite %s\n got %v\n want %s", irs, err, code)
		}
	}
	// the relation window survives quoting
	p = compile(t, lite, `"kind":"all","entity":"service","n_params":1,"where":{"items":[{"pred":{"column":"seq","op":"eq","p":0}}]},"relations":[{"rel":"modules","query":{"entity":"service_module","limit_per_parent":2,"order":[{"column":"seq","desc":true}]}}]`)
	if !strings.Contains(p.Steps[1].SQL, "ROW_NUMBER() OVER (PARTITION BY \"a\".\"service_seq\" ORDER BY \"a\".\"seq\" DESC) AS \"orm_rn\"") || !strings.Contains(p.Steps[1].SQL, "\"a\".\"service_seq\" IN (?)") {
		t.Errorf("sqlite relation window: %s", p.Steps[1].SQL)
	}
}

// Joins nest by relation name and aliases are path-derived, so two levels of the
// same target stay distinct and each keeps its own projection namespace.
func TestJoinAliasNamespaces(t *testing.T) {
	e := testEngine(t)
	p := compile(t, e, `"kind":"one","entity":"battle","columns":{"mode":"none","expr":{"battle_name":{"sql":"{name}"}}},"n_params":1,
	 "where":{"items":[{"pred":{"column":"seq","op":"eq","p":0}}]},
	 "joins":[{"rel":"service_member","kind":"inner","query":{"entity":"service_member","columns":{"mode":"none"},
	     "joins":[{"rel":"service","kind":"inner","query":{"entity":"service","columns":{"mode":"none","expr":{"service_name":{"sql":"{name}"}}}}},
	              {"rel":"user","kind":"inner","query":{"entity":"user","columns":{"mode":"none","expr":{"user_name":{"sql":"{name}"}}}}}]}},
	          {"rel":"service","kind":"inner","query":{"entity":"service","columns":{"mode":"none","expr":{"root_service_name":{"sql":"{name}"}}}}}]`)
	sql := p.Steps[0].SQL
	for _, want := range []string{
		"`service_member`.`name` AS `service_member__battle_name`", // not present: battle's alias belongs to the root
		"INNER JOIN `service` AS `service_member__service` ON `service_member`.`service_seq` = `service_member__service`.`seq`",
		"INNER JOIN `user` AS `service_member__user` ON `service_member`.`user_seq` = `service_member__user`.`seq`",
		"INNER JOIN `service` AS `service` ON `a`.`service_seq` = `service`.`seq`",
		"`service_member__service`.`name` AS `service_member__service__service_name`",
		"`service`.`name` AS `service__root_service_name`",
		"`a`.`name` AS `a__battle_name`",
	} {
		has := strings.Contains(sql, want)
		if want[0] == '`' && strings.HasPrefix(want, "`service_member`.`name`") {
			if has {
				t.Errorf("alias leaked across entities: %s", want)
			}
			continue
		}
		if !has {
			t.Errorf("missing %q in\n%s", want, sql)
		}
	}
	// the two joins of the same target are separate assemble children with distinct aliases
	root := p.Steps[0].Assemble
	aliases := map[string]bool{}
	var walk func(a *plan.Assemble)
	walk = func(a *plan.Assemble) {
		if aliases[a.Alias] {
			t.Errorf("duplicate alias %s", a.Alias)
		}
		aliases[a.Alias] = true
		for _, ch := range a.Children {
			if ch.Assemble != nil {
				walk(ch.Assemble)
			}
		}
	}
	walk(root)
	if len(aliases) != 5 {
		t.Errorf("aliases: %v", aliases)
	}
	for irs, code := range map[string]string{
		`"kind":"all","entity":"battle","columns":{"expr":{"seq":{"sql":"1"}}}`: "COLUMN_ALIAS_CONFLICT",
	} {
		_, err := e.Compile([]byte(`{"ir_version":1,"schema_hash":"` + e.M.SchemaHash + `",` + irs + `}`))
		if err == nil || !strings.HasPrefix(err.Error(), code) {
			t.Errorf("%s\n got %v\n want %s", irs, err, code)
		}
	}
}

func TestCompileErrors(t *testing.T) {
	e := testEngine(t)
	h := e.M.SchemaHash
	cases := map[string]string{
		`{"ir_version":2,"schema_hash":"` + h + `","kind":"all","entity":"battle"}`:                                                                                             "VERSION_MISMATCH",
		`{"ir_version":1,"schema_hash":"nope","kind":"all","entity":"battle"}`:                                                                                                  "SCHEMA_HASH_MISMATCH",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"nope"}`:                                                                                               "ENTITY_UNKNOWN",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","n_params":8,"where":{"items":[{"pred":{"column":"nope","op":"eq","p":2}}]}}`:                 "COLUMN_UNKNOWN",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","n_params":8,"where":{"items":[{"pred":{"column":"name","op":"between","p":0,"ps":[1,2]}}]}}`: "OPERATOR_NOT_ALLOWED",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","n_params":8,"where":{"items":[{"pred":{"column":"aes_hex_email","op":"contains","p":0}}]}}`:  "OPERATOR_NOT_ALLOWED",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","where":{"items":[{"pred":{"conn":"or","column":"seq","op":"eq","p":2}}]}}`:                   "OR_AT_GROUP_START",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","where":{"items":[{"pred":{"column":"seq","op":"in","ps":[]}}]}}`:                             "EMPTY_IN",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","where":{"items":[{"pred":{"column":"seq","op":"gt"}}]}}`:                                     "IR_INVALID",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","n_params":1,"where":{"items":[{"pred":{"column":"seq","op":"eq","p":7}}]}}`:                  "IR_INVALID: param index 7 out of range",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","where":{"items":[{"joined":{"join":"service"}}]}}`:                                           "ENTITY_NOT_JOINED",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","joins":[{"rel":"nope","kind":"inner","query":{"entity":"service"}}]}`:                        "RELATION_UNKNOWN",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"update","entity":"battle","n_params":1,"set":[{"column":"name","p":0}]}`:                                             "IR_INVALID: update without where",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","force_index":"nope"}`:                                                                        "INDEX_UNKNOWN",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","order":[{"expr":"DATE(` + "`nope`" + `)"}]}`:                                                 "COLUMN_UNKNOWN",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","relations":[{"rel":"service","query":{"entity":"service","limit":{"offset":0,"count":1}}}]}`: "LIMIT_IN_RELATION",
		`{"ir_version":1,"schema_hash":"` + h + `","kind":"all","entity":"battle","multi_statement":true}`:                                                                      "IR_INVALID",
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
	// root battle → one user (if_parent, flatten) ; join service → many modules (key_by, limit_per_parent, nested one service)
	p := compile(t, e, `"kind":"all","entity":"battle",
	 "columns":{"mode":"none"},
	 "where":{"items":[{"pred":{"column":"service_seq","op":"eq","p":0}}]},
	 "order":[{"column":"seq","desc":true}],"limit":{"offset":0,"count":20},
	 "joins":[{"rel":"service","kind":"inner","query":{"entity":"service",
	    "relations":[{"rel":"modules","query":{"entity":"service_module","key_by":"name","limit_per_parent":3,
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
	if u.Parent == nil || u.Parent.Step != 0 || len(u.Parent.Keys) != 1 || u.Parent.Keys[0].Index != 1 || u.Parent.Keys[0].Column != "user_seq" || u.Parent.IfParent == nil || u.Parent.IfParent.Index != 5 || u.Parent.IfParent.Param != 1 {
		t.Errorf("user parent: %+v", u.Parent)
	}
	if len(u.BindSlots) != 2 || u.BindSlots[0].From != "parent" || u.BindSlots[0].Step != 0 || u.BindSlots[1].Transform != "like_contains" {
		t.Errorf("user binds: %+v", u.BindSlots)
	}
	// step 2: modules per service, 3 per parent by seq desc; step 3: nested one service ordered → per-parent 1
	m := p.Steps[2]
	if want := "SELECT `orm_w`.`a__seq`, `orm_w`.`a__service_seq`, `orm_w`.`a__name` FROM (SELECT `a`.`seq` AS `a__seq`, `a`.`service_seq` AS `a__service_seq`, `a`.`name` AS `a__name`, ROW_NUMBER() OVER (PARTITION BY `a`.`service_seq` ORDER BY `a`.`seq` DESC) AS `orm_rn` FROM `service_module` AS `a` WHERE `a`.`service_seq` IN (?)) AS `orm_w` WHERE `orm_w`.`orm_rn` <= 3 ORDER BY `orm_w`.`a__service_seq`, `orm_w`.`orm_rn`"; m.SQL != want {
		t.Errorf("modules step:\n got  %s\n want %s", m.SQL, want)
	}
	if m.Parent.Step != 0 || len(m.Parent.Keys) != 1 || m.Parent.Keys[0].Index != 6 {
		t.Errorf("modules parent: %+v", m.Parent)
	}
	sv := p.Steps[3]
	if !strings.Contains(sv.SQL, "ROW_NUMBER() OVER (PARTITION BY `a`.`seq` ORDER BY `a`.`seq` ASC)") || !strings.Contains(sv.SQL, "`orm_rn` <= 1") || sv.Parent.Step != 2 || len(sv.Parent.Keys) != 1 || sv.Parent.Keys[0].Index != 1 {
		t.Errorf("nested service step: %s %+v", sv.SQL, sv.Parent)
	}
	// children wiring
	root := main.Assemble
	if len(root.Children) != 2 || root.Children[0].Kind != "join" || root.Children[1].Kind != "one" || root.Children[1].Step != 1 || root.Children[1].ParentKeys[0].Index != 1 || root.Children[1].ChildKeys[0].Index != 0 || !root.Children[1].Flatten {
		t.Errorf("root children: %+v", root.Children)
	}
	js := root.Children[0].Assemble
	if len(js.Children) != 1 || js.Children[0].Kind != "many" || js.Children[0].Step != 2 || js.Children[0].ParentKeys[0].Index != 6 || js.Children[0].ChildKeys[0].Index != 1 || js.Children[0].Key[0].Index != 2 || js.Children[0].Key[0].Column != "name" {
		t.Errorf("join children: %+v", js.Children[0])
	}
	if mc := p.Steps[2].Assemble.Children; len(mc) != 1 || mc[0].Kind != "one" || mc[0].Step != 3 || mc[0].ParentKeys[0].Index != 1 {
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
		`"kind":"all","entity":"battle","relations":[{"rel":"user","query":{"entity":"user","key_by":"name"}}]`:                                  "IR_INVALID",
		`"kind":"all","entity":"service","relations":[{"rel":"modules","query":{"entity":"service_module","flatten":true}}]`:                     "IR_INVALID",
		`"kind":"all","entity":"battle","n_params":2,"relations":[{"rel":"user","query":{"entity":"user","if_parent":{"column":"nope","p":0}}}]`: "COLUMN_UNKNOWN",
	} {
		_, err := e.Compile([]byte(`{"ir_version":1,"schema_hash":"` + e.M.SchemaHash + `",` + irs + `}`))
		if err == nil || !strings.HasPrefix(err.Error(), code) {
			t.Errorf("%s\n got %v\n want %s", irs, err, code)
		}
	}
}
