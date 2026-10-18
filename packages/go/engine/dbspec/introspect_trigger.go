package dbspec

import (
	"regexp"
	"slices"
	"strings"
)

// itrigger rewrites a catalog trigger into the statement form that the renderer writes.
// PostgreSQL uses two statements: a function and a trigger.
type itrigger struct {
	name       string
	statements []string
}

var (
	auditInsertPattern = regexp.MustCompile("^INSERT INTO [`\"]([a-z0-9_]+)[`\"] \\(([^)]*)\\) VALUES ")
	auditColumnPattern = regexp.MustCompile("^[`\"]([a-z0-9_]+)[`\"]$")
	auditUpdatePattern = regexp.MustCompile("VALUES \\('update', OLD\\.[`\"]([a-z0-9_]+)[`\"],")
)

// recognizeTriggers: if a table's trigger set equals the output of the immutable and audit renderers, it adds
// that setting; otherwise it reports all triggers as unsupported.
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
		ok, settings := c.triggerSetting(dialect, t, list)
		if !ok {
			for _, tr := range list {
				c.report("trigger", table, tr.name, "the trigger is not the renderer output of immutable or audit")
			}
			continue
		}
		t.settings = append(t.settings, settings...)
	}
}

// triggerSetting checks whether the trigger set equals each renderer output of the immutable and audit settings.
// Each setting is recognized by its own trigger names (the renderer names, recomputed), not by
// count. A table that uses both settings has triggers that are the sum of the two outputs.
// It returns the setting line only if the set equals the sum in names and content; otherwise ok is
// false.
func (c *catalog) triggerSetting(dialect Dialect, t *itable, list []itrigger) (bool, []string) {
	names := map[string]itrigger{}
	for _, tr := range list {
		names[tr.name] = tr
	}
	model := Table{Name: t.name}
	for _, col := range t.columns {
		model.Columns = append(model.Columns, Column{Name: col.name, Type: col.typ})
	}
	settings := &Settings{}
	for _, event := range []string{"immutable_update", "immutable_delete"} {
		if _, ok := names[rendererName(t.name, event)]; ok {
			settings.Immutable = &ImmutableSetting{}
		}
	}
	if insert, ok := names[rendererName(t.name, "audit_insert")]; ok {
		update := names[rendererName(t.name, "audit_update")]
		body := statementBody(insert.statements)
		m := auditInsertPattern.FindStringSubmatch(body)
		u := auditUpdatePattern.FindStringSubmatch(statementBody(update.statements))
		if m != nil && u != nil {
			settings.Audit = auditOf(t, m[1], strings.Split(m[2], ", "), u[1])
		}
	}
	if settings.Immutable == nil && settings.Audit == nil {
		return false, nil
	}
	model.Settings = settings
	r := renderer{d: dialect}
	want := r.triggers(&model)
	wanted := triggerOrder(want)
	if len(wanted) != len(list) {
		return false, nil
	}
	var got []string
	for _, w := range wanted {
		tr, ok := names[w]
		if !ok {
			return false, nil
		}
		got = append(got, tr.statements...)
	}
	if !slices.Equal(got, want) {
		return false, nil
	}
	var lines []string
	if settings.Immutable != nil {
		lines = append(lines, "immutable")
	}
	if a := settings.Audit; a != nil {
		lines = append(lines, a.line("exclude", a.Exclude))
	}
	return true, lines
}

// auditOf makes the audit setting from the column list of the audit insert trigger (action, previous, and the recorded
// columns) and the audit columns of the update trigger. The audit
// record table is the table that the foreign key of a table with only one audit column points to.
// Columns that are not recorded become the exclude list, in the table's column order.
// It is nil if the list is not in renderer form, if an audit column is not recorded, or if
// there is not exactly one foreign key. It compares the setting it made, once rendered again,
// with the catalog trigger.
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

// triggerOrder takes the trigger names, in order, from the list of renderer statements.
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

// statementBody takes the body from a trigger statement: in MySQL, after FOR EACH ROW;
// in PostgreSQL, after the function's BEGIN; and in SQLite, after BEGIN.
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
