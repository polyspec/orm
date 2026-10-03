package dbspec

import (
	"regexp"
	"slices"
	"strings"
)

// itrigger는 catalog trigger 하나를 renderer가 쓰는 statement 형식으로 다시 쓴
// 것이다. PostgreSQL은 function과 trigger statement 두 개다.
type itrigger struct {
	name       string
	statements []string
}

var (
	auditInsertPattern = regexp.MustCompile("^INSERT INTO [`\"]([a-z0-9_]+)[`\"] \\(([^)]*)\\) VALUES ")
	auditColumnPattern = regexp.MustCompile("^[`\"]([a-z0-9_]+)[`\"]$")
	auditUpdatePattern = regexp.MustCompile("VALUES \\('update', OLD\\.[`\"]([a-z0-9_]+)[`\"],")
)

// recognizeTriggers는 table마다 trigger 집합이 immutable이나 audit의 renderer
// 출력과 같으면 그 setting을 더하고, 아니면 모든 trigger를 미지원으로 보고한다.
func (c *catalog) recognizeTriggers(dialect Dialect, triggers map[string][]itrigger) {
	tables := make([]string, 0, len(triggers))
	for table := range triggers {
		tables = append(tables, table)
	}
	slices.Sort(tables)
	for _, table := range tables {
		list := triggers[table]
		t := c.table(table)
		if t == nil {
			for _, tr := range list {
				c.report("trigger", table, tr.name, "the table is not read")
			}
			continue
		}
		setting, settings := c.triggerSetting(dialect, t, list)
		if setting == "" {
			for _, tr := range list {
				c.report("trigger", table, tr.name, "the trigger is not the renderer output of immutable or audit")
			}
			continue
		}
		t.settings = append(t.settings, settings...)
	}
}

// triggerSetting은 trigger 집합이 같은 renderer 출력을 주는 setting과 그 setting
// 줄을 돌려준다. 없으면 빈 문자열이다.
func (c *catalog) triggerSetting(dialect Dialect, t *itable, list []itrigger) (string, []string) {
	names := map[string]itrigger{}
	for _, tr := range list {
		names[tr.name] = tr
	}
	model := Table{Name: t.name}
	for _, col := range t.columns {
		model.Columns = append(model.Columns, Column{Name: col.name, Type: col.typ})
	}
	r := renderer{d: dialect}
	candidates := map[string]*Settings{}
	if len(list) == 2 {
		candidates["immutable"] = &Settings{Immutable: &ImmutableSetting{}}
	}
	if insert, ok := names[t.name+"$audit_insert"]; ok && len(list) == 3 {
		update := names[t.name+"$audit_update"]
		body := statementBody(insert.statements)
		m := auditInsertPattern.FindStringSubmatch(body)
		u := auditUpdatePattern.FindStringSubmatch(statementBody(update.statements))
		if m != nil && u != nil {
			if a := auditOf(t, m[1], strings.Split(m[2], ", "), u[1]); a != nil {
				candidates["audit"] = &Settings{Audit: a}
			}
		}
	}
	for kind, settings := range candidates {
		model.Settings = settings
		want := r.triggers(&model)
		var got []string
		for _, w := range triggerOrder(want) {
			tr, ok := names[w]
			if !ok {
				got = nil
				break
			}
			got = append(got, tr.statements...)
		}
		if slices.Equal(got, want) {
			if kind == "immutable" {
				return kind, []string{"immutable"}
			}
			a := settings.Audit
			return kind, []string{a.line("exclude", a.Exclude)}
		}
	}
	return "", nil
}

// auditOf는 audit insert trigger의 column 목록(action, previous, 기록하는
// column)과 update trigger의 audit column으로 audit setting을 만든다. audit
// 기록 table은 audit column 하나만 가진 table의 foreign key가 가리키는
// table이다. 기록하지 않는 column은 table의 column 순서로 exclude 목록이
// 된다. 목록이 renderer 형식이 아니거나, audit column을 기록하지 않거나, 그
// foreign key가 하나가 아니면 nil이다. 만든 setting은 다시 렌더링해 catalog
// trigger와 비교한다.
func auditOf(t *itable, history string, quoted []string, column string) *AuditSetting {
	var names []string
	for _, q := range quoted {
		m := auditColumnPattern.FindStringSubmatch(q)
		if m == nil {
			return nil
		}
		names = append(names, m[1])
	}
	if len(names) < 3 || !slices.Contains(names[2:], column) {
		return nil
	}
	references := ""
	for _, f := range t.fks {
		if len(f.columns) == 1 && f.columns[0] == column {
			if references != "" {
				return nil
			}
			references = f.table
		}
	}
	if references == "" {
		return nil
	}
	a := &AuditSetting{History: history, Column: column, References: references, Action: names[0], Previous: names[1]}
	for _, col := range t.columns {
		if !slices.Contains(names[2:], col.name) {
			a.Exclude = append(a.Exclude, col.name)
		}
	}
	return a
}

// triggerOrder는 renderer statement 목록에서 trigger 이름을 순서대로 꺼낸다.
func triggerOrder(statements []string) []string {
	var names []string
	for _, s := range statements {
		if !strings.HasPrefix(s, "CREATE TRIGGER ") {
			continue
		}
		rest := strings.TrimPrefix(s, "CREATE TRIGGER ")
		quote := rest[0]
		end := strings.IndexByte(rest[1:], quote)
		names = append(names, rest[1:1+end])
	}
	return names
}

// statementBody는 trigger statement에서 본문을 꺼낸다: MySQL은 FOR EACH ROW
// 뒤, PostgreSQL은 function의 BEGIN 뒤, SQLite는 BEGIN 뒤다.
func statementBody(statements []string) string {
	for _, s := range statements {
		if i := strings.Index(s, "$$BEGIN "); i >= 0 {
			return s[i+len("$$BEGIN "):]
		}
		if i := strings.Index(s, "FOR EACH ROW BEGIN "); i >= 0 {
			return s[i+len("FOR EACH ROW BEGIN "):]
		}
		if i := strings.Index(s, "FOR EACH ROW "); i >= 0 {
			return s[i+len("FOR EACH ROW "):]
		}
	}
	return ""
}
