package engine

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/plan"
	"github.com/polyspec/orm/engine/runtimemodel"
)

const formsSchema = `dbspec 1 forms

table place {
  seq i64 identity
  owner_seq i64
  name varchar(50)
  price i32 default 0
  created_ts datetime(6) default now
  primary key (seq)
}

table owner {
  seq i64 identity
  name varchar(50)
  min_price i32 default 0
  primary key (seq)
}

table visit {
  seq i64 identity
  place_seq i64
  amount i32 default 0
  status i32 default 0
  primary key (seq)
}

table membership {
  tenant_id i32
  account_id i32
  role varchar(20)
  primary key (tenant_id, account_id)
}
`

func formsEngine(t *testing.T, driver string) *Engine {
	t.Helper()
	m, diagnostics := runtimemodel.LoadDocuments([]string{formsSchema})
	if len(diagnostics) > 0 {
		t.Fatal(runtimemodel.DiagnosticsError(diagnostics))
	}
	e, err := New(m, driver)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func formsCompile(t *testing.T, e *Engine, body string) *plan.Plan {
	t.Helper()
	full := `{"ir_version":1,"manifest_hash":"` + e.M.ManifestHash + `","n_params":16,` + body + `}`
	out, err := e.Compile([]byte(full))
	if err != nil {
		t.Fatalf("%s compile %s: %v", e.P.D.Name(), body, err)
	}
	var p plan.Plan
	if err := json.Unmarshal(out, &p); err != nil {
		t.Fatal(err)
	}
	return &p
}

func formsError(t *testing.T, e *Engine, body, code string) {
	t.Helper()
	full := `{"ir_version":1,"manifest_hash":"` + e.M.ManifestHash + `","n_params":16,` + body + `}`
	_, err := e.Compile([]byte(full))
	if err == nil || !strings.Contains(err.Error(), code) {
		t.Fatalf("%s: want %s, got %v", body, code, err)
	}
}

func requireSQL(t *testing.T, sql string, parts ...string) {
	t.Helper()
	for _, part := range parts {
		if !strings.Contains(sql, part) {
			t.Errorf("sql missing %q\n got: %s", part, sql)
		}
	}
}

func TestExplicitKeyJoinPlacesChildConditionsInGroup(t *testing.T) {
	e := formsEngine(t, "mysql")
	p := formsCompile(t, e, `"kind":"all","entity":"place",
	 "joins":[{"rel":"owner","kind":"left","left":"owner_seq","right":"seq","query":{"entity":"owner",
	   "columns":{"mode":"none"},
	   "on":{"items":[{"pred":{"column":"min_price","op":"gt","p":0}}]},
	   "where":{"items":[{"pred":{"column":"name","op":"contains","p":1}}]}}}],
	 "where":{"items":[
	   {"pred":{"column":"price","op":"gte","p":2}},
	   {"group":{"conn":"and","items":[
	     {"pred":{"column":"name","op":"contains","p":3}},
	     {"joined":{"conn":"or","join":"owner"}}]}}]}`)
	sql := p.Steps[0].SQL
	requireSQL(t, sql,
		"LEFT JOIN `owner` AS `owner` ON `a`.`owner_seq` = `owner`.`seq` AND `owner`.`min_price` > ?",
		"WHERE `a`.`price` >= ? AND (`a`.`name` LIKE ? OR (`owner`.`name` LIKE ?))",
	)
	if strings.Count(sql, "`owner`.`name` LIKE") != 1 {
		t.Errorf("placed join condition must appear once: %s", sql)
	}
}

func TestUnplacedJoinConditionsAreAppended(t *testing.T) {
	e := formsEngine(t, "mysql")
	p := formsCompile(t, e, `"kind":"all","entity":"place",
	 "joins":[{"rel":"owner","kind":"inner","left":"owner_seq","right":"seq","query":{"entity":"owner",
	   "where":{"items":[{"pred":{"column":"min_price","op":"lt","p":0}}]}}}],
	 "where":{"items":[{"pred":{"column":"price","op":"gt","p":1}}]}`)
	requireSQL(t, p.Steps[0].SQL, "WHERE `a`.`price` > ? AND (`owner`.`min_price` < ?)")
}

func TestJoinedReferenceErrors(t *testing.T) {
	e := formsEngine(t, "mysql")
	formsError(t, e, `"kind":"all","entity":"place","where":{"items":[{"joined":{"join":"owner"}}]}`, "ENTITY_NOT_JOINED")
	formsError(t, e, `"kind":"all","entity":"place",
	 "joins":[{"rel":"owner","kind":"inner","left":"owner_seq","right":"seq","query":{"entity":"owner",
	   "where":{"items":[{"pred":{"column":"name","op":"eq","p":0}}]}}}],
	 "where":{"items":[{"joined":{"join":"owner"}},{"joined":{"conn":"or","join":"owner"}}]}`, "IR_INVALID")
	formsError(t, e, `"kind":"all","entity":"place",
	 "joins":[{"rel":"owner","kind":"inner","left":"missing","right":"seq","query":{"entity":"owner"}}]`, "COLUMN_UNKNOWN")
}

func TestExplicitKeyRelation(t *testing.T) {
	e := formsEngine(t, "mysql")
	p := formsCompile(t, e, `"kind":"all","entity":"place",
	 "relations":[{"rel":"visits","kind":"many","keys":[{"left":"seq","right":"place_seq"}],
	   "query":{"entity":"visit","limit_per_parent":2,"order":[{"column":"seq","desc":true}]}}]`)
	if len(p.Steps) != 2 {
		t.Fatalf("steps %d", len(p.Steps))
	}
	requireSQL(t, p.Steps[1].SQL, "`a`.`place_seq` IN (?)", "ROW_NUMBER() OVER (PARTITION BY `a`.`place_seq` ORDER BY `a`.`seq` DESC)")
	child := p.Steps[0].Assemble.Children[0]
	if child.Rel != "visits" || child.Kind != "many" || !child.Cascade {
		t.Fatalf("child %+v", child)
	}
	formsError(t, e, `"kind":"all","entity":"place","relations":[{"rel":"name","kind":"one","keys":[{"left":"seq","right":"place_seq"}],"query":{"entity":"visit"}}]`, "COLUMN_ALIAS_CONFLICT")
	formsError(t, e, `"kind":"all","entity":"place","relations":[
	 {"rel":"v","kind":"one","keys":[{"left":"seq","right":"place_seq"}],"query":{"entity":"visit"}},
	 {"rel":"v","kind":"many","keys":[{"left":"seq","right":"place_seq"}],"query":{"entity":"visit"}}]`, "COLUMN_ALIAS_CONFLICT")
}

func TestColumnComparisonWithJoinedModel(t *testing.T) {
	e := formsEngine(t, "mysql")
	p := formsCompile(t, e, `"kind":"all","entity":"place",
	 "joins":[{"rel":"owner","kind":"inner","left":"owner_seq","right":"seq","query":{"entity":"owner"}}],
	 "where":{"items":[{"pred":{"column":"price","op":"gt_col","ref":{"path":"owner","column":"min_price"}}}]}`)
	requireSQL(t, p.Steps[0].SQL, "WHERE `a`.`price` > `owner`.`min_price`")
}

func TestColumnFunctionsForEveryDialect(t *testing.T) {
	body := `"kind":"all","entity":"place",
	 "columns":{"fn":{"created_date":{"column":"created_ts","fn":{"name":"date"}}}},
	 "where":{"items":[
	   {"pred":{"column":"created_ts","op":"eq","p":0,"fn":{"name":"day_of_week"}}},
	   {"pred":{"conn":"and","column":"created_ts","op":"gt","p":1,"fn":{"name":"year"}}},
	   {"pred":{"conn":"and","column":"created_ts","op":"in","ps":[2,3],"fn":{"name":"month"}}}]},
	 "order":[{"column":"created_ts","fn":{"name":"year"}}]`
	for driver, parts := range map[string][]string{
		"mysql": {
			"DATE(`a`.`created_ts`) AS `a__created_date`",
			"DAYOFWEEK(`a`.`created_ts`) = ?",
			"YEAR(`a`.`created_ts`) > ?",
			"MONTH(`a`.`created_ts`) IN (?, ?)",
			"ORDER BY YEAR(`a`.`created_ts`) ASC",
		},
		"postgres": {
			`CAST("a"."created_ts" AS date) AS "a__created_date"`,
			`(EXTRACT(DOW FROM "a"."created_ts")::int + 1) = $`,
			`EXTRACT(YEAR FROM "a"."created_ts")::int > $`,
		},
		"sqlite": {
			`date("a"."created_ts") AS "a__created_date"`,
			`(CAST(strftime('%w', "a"."created_ts") AS INTEGER) + 1) = ?`,
			`CAST(strftime('%Y', "a"."created_ts") AS INTEGER) > ?`,
		},
	} {
		p := formsCompile(t, formsEngine(t, driver), body)
		requireSQL(t, p.Steps[0].SQL, parts...)
		if n := len(p.Steps[0].BindSlots); n != 4 {
			t.Errorf("%s binds %d, want 4", driver, n)
		}
		col := p.Steps[0].Assemble.Columns
		if col[len(col)-1].Name != "created_date" || col[len(col)-1].Type != "date" {
			t.Errorf("%s created_date output %+v", driver, col[len(col)-1])
		}
	}
	e := formsEngine(t, "mysql")
	formsError(t, e, `"kind":"all","entity":"place","where":{"items":[{"pred":{"column":"name","op":"eq","p":0,"fn":{"name":"year"}}}]}`, "OPERATOR_NOT_ALLOWED")
	formsError(t, e, `"kind":"all","entity":"place","where":{"items":[{"pred":{"column":"created_ts","op":"eq","p":0,"fn":{"name":"concat"}}}]}`, "FUNCTION_UNKNOWN")
	formsError(t, e, `"kind":"all","entity":"place","where":{"items":[{"pred":{"column":"created_ts","op":"lte","p":0,"fn":{"name":"year","ps":[1]}}}]}`, "IR_INVALID")
}

func TestValueFunctionsForEveryDialect(t *testing.T) {
	body := `"kind":"all","entity":"place","where":{"items":[
	  {"pred":{"column":"created_ts","op":"gt","value":{"name":"days_ago","ps":[0]}}},
	  {"pred":{"conn":"and","column":"created_ts","op":"lte","value":{"name":"now"}}},
	  {"pred":{"conn":"and","column":"created_ts","op":"lt","value":{"name":"months_later","ps":[1]}}}]}`
	for driver, parts := range map[string][]string{
		"mysql":    {"`a`.`created_ts` > DATE_SUB(NOW(6), INTERVAL ? DAY)", "`a`.`created_ts` <= NOW(6)", "DATE_ADD(NOW(6), INTERVAL ? MONTH)"},
		"postgres": {`"a"."created_ts" > (now() - make_interval(days => CAST($1 AS integer)))`, `"a"."created_ts" <= now()`, `(now() + make_interval(months => CAST($2 AS integer)))`},
		"sqlite":   {`"a"."created_ts" > (datetime(?, '-' || CAST(? AS TEXT) || ' days') || substr(?, 20))`, `"a"."created_ts" <= ?`, `(datetime(?, '+' || CAST(? AS TEXT) || ' months', 'floor') || substr(?, 20))`},
	} {
		p := formsCompile(t, formsEngine(t, driver), body)
		requireSQL(t, p.Steps[0].SQL, parts...)
		if driver == "sqlite" {
			var nows int
			for _, slot := range p.Steps[0].BindSlots {
				if slot.From == "now" {
					nows++
				}
			}
			if nows != 5 {
				t.Errorf("sqlite now slots %d, want 5", nows)
			}
		}
	}
	e := formsEngine(t, "mysql")
	formsError(t, e, `"kind":"all","entity":"place","where":{"items":[{"pred":{"column":"name","op":"gt","value":{"name":"now"}}}]}`, "OPERATOR_NOT_ALLOWED")
	formsError(t, e, `"kind":"all","entity":"place","where":{"items":[{"pred":{"column":"created_ts","op":"gt","value":{"name":"days_ago"}}}]}`, "IR_INVALID")
}

func TestTupleConditionsForEveryDialect(t *testing.T) {
	body := `"kind":"all","entity":"membership","where":{"items":[
	  {"pred":{"column":"","op":"tuple_in","cols":["tenant_id","account_id"],"ps":[0,1,2,3]}},
	  {"pred":{"conn":"and","op":"tuple_not_in","cols":["tenant_id","account_id"],"ps":[4,5]}}]}`
	for driver, parts := range map[string][]string{
		"mysql":    {"(`a`.`tenant_id`, `a`.`account_id`) IN ((?, ?), (?, ?))", "(`a`.`tenant_id`, `a`.`account_id`) NOT IN ((?, ?))"},
		"postgres": {`("a"."tenant_id", "a"."account_id") IN (($1, $2), ($3, $4))`},
		"sqlite":   {`("a"."tenant_id", "a"."account_id") IN (VALUES (?, ?), (?, ?))`},
	} {
		requireSQL(t, formsCompile(t, formsEngine(t, driver), body).Steps[0].SQL, parts...)
	}
	e := formsEngine(t, "mysql")
	formsError(t, e, `"kind":"all","entity":"membership","where":{"items":[{"pred":{"op":"tuple_in","cols":["tenant_id","account_id"],"ps":[0,1,2]}}]}`, "IR_INVALID")
	formsError(t, e, `"kind":"all","entity":"membership","where":{"items":[{"pred":{"op":"tuple_in","cols":["tenant_id","account_id"],"ps":[]}}]}`, "EMPTY_IN")
}

func TestSubqueryConditionsAndColumns(t *testing.T) {
	e := formsEngine(t, "mysql")
	p := formsCompile(t, e, `"kind":"all","entity":"owner",
	 "columns":{"sub":{"visit_total":{"agg":"sum","column":"amount","query":{"entity":"visit",
	   "where":{"items":[{"pred":{"column":"place_seq","op":"eq_col","ref":{"path":"^","column":"seq"}}},
	                     {"pred":{"conn":"and","column":"status","op":"eq","p":0}}]}}}}},
	 "where":{"items":[{"pred":{"column":"seq","op":"in","sub":{"column":"owner_seq","query":{"entity":"place",
	   "where":{"items":[{"pred":{"column":"price","op":"gt","p":1}}]}}}}}]}`)
	requireSQL(t, p.Steps[0].SQL,
		"(SELECT COALESCE(SUM(`s1`.`amount`), 0) FROM `visit` AS `s1` WHERE `s1`.`place_seq` = `a`.`seq` AND `s1`.`status` = ?) AS `a__visit_total`",
		"WHERE `a`.`seq` IN (SELECT `s2`.`owner_seq` FROM `place` AS `s2` WHERE `s2`.`price` > ?)",
	)
	formsError(t, e, `"kind":"all","entity":"owner","columns":{"sub":{"name":{"agg":"count","query":{"entity":"visit"}}}}`, "COLUMN_ALIAS_CONFLICT")
	formsError(t, e, `"kind":"all","entity":"owner","where":{"items":[{"pred":{"column":"seq","op":"in","sub":{"agg":"sum","column":"amount","query":{"entity":"visit"}}}}]}`, "IR_INVALID")
	formsError(t, e, `"kind":"all","entity":"owner","where":{"items":[{"pred":{"column":"seq","op":"eq_col","ref":{"path":"^","column":"seq"}}}]}`, "IR_INVALID")
}

func TestRawColumnReferencesAndRandomOrder(t *testing.T) {
	for driver, parts := range map[string][]string{
		"mysql":    {"(`a`.`price` * ? > ?)", "ORDER BY RAND()"},
		"postgres": {`("a"."price" * $1 > $2)`, "ORDER BY random()"},
		"sqlite":   {`("a"."price" * ? > ?)`, "ORDER BY random()"},
	} {
		p := formsCompile(t, formsEngine(t, driver), `"kind":"all","entity":"place",
		 "where":{"items":[{"pred":{"expr":"{price} * ? > ?","ps":[0,1]}}]},
		 "order":[{"random":true}]`)
		requireSQL(t, p.Steps[0].SQL, parts...)
	}
	formsError(t, formsEngine(t, "mysql"), `"kind":"all","entity":"place","where":{"items":[{"pred":{"expr":"{missing} > ?","ps":[0]}}]}`, "COLUMN_UNKNOWN")
}

func TestBoundRawColumnAndBinaryContains(t *testing.T) {
	for driver, parts := range map[string][]string{
		"mysql":    {"(`a`.`price` * ?) AS `a__doubled`", "`a`.`name` LIKE BINARY ?"},
		"postgres": {`("a"."price" * $1) AS "a__doubled"`, `"a"."name" LIKE $2`},
		"sqlite":   {`("a"."price" * ?) AS "a__doubled"`, `instr("a"."name", ?) > 0`},
	} {
		p := formsCompile(t, formsEngine(t, driver), `"kind":"all","entity":"place",
		 "columns":{"expr":{"doubled":{"sql":"({price} * ?)","ps":[0]}}},
		 "where":{"items":[{"pred":{"column":"name","op":"contains_binary","p":1}}]}`)
		requireSQL(t, p.Steps[0].SQL, parts...)
		want := "like_contains"
		if driver == "sqlite" {
			want = ""
		}
		if got := p.Steps[0].BindSlots[1].Transform; got != want {
			t.Fatalf("%s transform %q", driver, got)
		}
	}
	formsError(t, formsEngine(t, "mysql"), `"kind":"all","entity":"place","columns":{"expr":{"doubled":{"sql":"{price} * ?"}}}`, "IR_INVALID")
}

func TestMultiRowInsert(t *testing.T) {
	for driver, want := range map[string]string{
		"mysql":    "INSERT INTO `visit` (`place_seq`, `amount`) VALUES (?, ?), (?, ?), (?, ?)",
		"postgres": `INSERT INTO "visit" ("place_seq", "amount") VALUES ($1, $2), ($3, $4), ($5, $6)`,
		"sqlite":   `INSERT INTO "visit" ("place_seq", "amount") VALUES (?, ?), (?, ?), (?, ?)`,
	} {
		p := formsCompile(t, formsEngine(t, driver), `"kind":"insert","entity":"visit",
		 "set":[{"column":"place_seq","p":0},{"column":"amount","p":1}],"rows":[[2,3],[4,5]]`)
		if p.Steps[0].SQL != want {
			t.Fatalf("%s: %s", driver, p.Steps[0].SQL)
		}
		if len(p.Steps[0].BindSlots) != 6 || p.Steps[0].BindSlots[5].Param != 5 {
			t.Fatalf("%s binds %+v", driver, p.Steps[0].BindSlots)
		}
	}
	e := formsEngine(t, "mysql")
	formsError(t, e, `"kind":"insert","entity":"visit","set":[{"column":"place_seq","p":0},{"column":"amount","p":1}],"rows":[[2]]`, "IR_INVALID")
	formsError(t, e, `"kind":"update","entity":"visit","set":[{"column":"amount","p":0}],"rows":[[1]],"where":{"items":[{"pred":{"column":"seq","op":"eq","p":2}}]}`, "IR_INVALID")
}

// TestKeyColumnsAreNotWritten은 insert가 identity column 값을, update와
// duplicate update가 primary key와 identity column 값을 쓰지 못하게 하는지
// 세 dialect에서 확인한다. PostgreSQL identity는 명시한 key를 지나 나아가지
// 않으므로(postgres.identity.by_default_not_advanced) 이 거부가 없으면 다음
// 생성 key가 충돌한다.
func TestKeyColumnsAreNotWritten(t *testing.T) {
	cases := []struct{ body, message string }{
		{`"kind":"insert","entity":"place","set":[{"column":"seq","p":0},{"column":"owner_seq","p":1},{"column":"name","p":2}]`, "cannot set identity column seq"},
		{`"kind":"update","entity":"place","set":[{"column":"seq","p":0}],"where":{"items":[{"pred":{"column":"seq","op":"eq","p":1}}]}`, "cannot update seq"},
		{`"kind":"insert","entity":"place","set":[{"column":"owner_seq","p":0},{"column":"name","p":1}],"on_duplicate":[{"column":"seq","p":2}]`, "on_duplicate cannot assign place.seq"},
		{`"kind":"insert","entity":"membership","set":[{"column":"tenant_id","p":0},{"column":"account_id","p":1},{"column":"role","p":2}],"on_duplicate":[{"column":"tenant_id","p":3}]`, "on_duplicate cannot assign membership.tenant_id"},
	}
	for _, driver := range []string{"mysql", "postgres", "sqlite"} {
		e := formsEngine(t, driver)
		for _, c := range cases {
			full := `{"ir_version":1,"manifest_hash":"` + e.M.ManifestHash + `","n_params":16,` + c.body + `}`
			_, err := e.Compile([]byte(full))
			if err == nil || !strings.Contains(err.Error(), "IR_INVALID") || !strings.Contains(err.Error(), c.message) {
				t.Errorf("%s %s: want IR_INVALID %q, got %v", driver, c.body, c.message, err)
			}
		}
	}
}
