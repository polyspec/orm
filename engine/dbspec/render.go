package dbspec

import (
	"slices"
	"strconv"
	"strings"
)

// Dialect names a database whose statements Render writes.
type Dialect string

// The dialects of docs/dialects.md "Rendered statements".
const (
	DialectMySQL    Dialect = "mysql"
	DialectPostgres Dialect = "postgres"
	DialectSQLite   Dialect = "sqlite"
)

// Render writes the statements that create the tables of the document set
// in one dialect (docs/dialects.md "Rendered statements"), or returns the
// diagnostics of an invalid set. A dialect other than the three constants is
// a programming error and panics.
func Render(documents []*Document, dialect Dialect) ([]string, []Diagnostic) {
	rendered, diagnostics := RenderStatements(documents, dialect)
	if len(diagnostics) > 0 {
		return nil, diagnostics
	}
	out := make([]string, len(rendered))
	for i, r := range rendered {
		out[i] = r.SQL
	}
	return out, nil
}

// RenderedStatement은 Render의 statement 하나와 그 statement가 만들거나 바꾸는 table이다.
type RenderedStatement struct {
	SQL   string
	Table string
}

// RenderStatements는 Render와 같은 statement를 같은 순서로 쓰고, 각 statement가
// 만들거나 바꾸는 table을 함께 돌려준다.
func RenderStatements(documents []*Document, dialect Dialect) ([]RenderedStatement, []Diagnostic) {
	switch dialect {
	case DialectMySQL, DialectPostgres, DialectSQLite:
	default:
		panic("dbspec: unknown dialect " + string(dialect))
	}
	if _, diagnostics := checkSet(documents); len(diagnostics) > 0 {
		return nil, diagnostics
	}
	r := renderer{d: dialect}
	ordered := useOrder(documents)
	var out []RenderedStatement
	add := func(table string, statements ...string) {
		for _, sql := range statements {
			out = append(out, RenderedStatement{SQL: sql, Table: table})
		}
	}
	// 외부 문서의 table은 그 문서를 소유한 set이 만든다.
	ordered = slices.DeleteFunc(ordered, func(d *Document) bool { return d.External })
	for _, document := range ordered {
		for i := range document.Tables {
			add(document.Tables[i].Name, r.table(&document.Tables[i])...)
		}
	}
	if dialect != DialectSQLite {
		for _, document := range ordered {
			for _, t := range document.Tables {
				for _, f := range sortedBy(t.ForeignKeys, func(f ForeignKey) string { return f.Name }) {
					add(t.Name, "ALTER TABLE "+r.q(t.Name)+" ADD "+r.foreignKey(f))
				}
			}
		}
	}
	for _, document := range ordered {
		for i := range document.Tables {
			add(document.Tables[i].Name, r.triggers(&document.Tables[i])...)
		}
	}
	return out, nil
}

// useOrder orders documents so that a used document comes before the
// documents that use it, ties by document name.
func useOrder(documents []*Document) []*Document {
	byName := map[string]*Document{}
	names := make([]string, 0, len(documents))
	for _, d := range documents {
		byName[d.Name] = d
		names = append(names, d.Name)
	}
	// checkSet has made every used document present and every name unique.
	slices.Sort(names)
	var out []*Document
	done := map[string]bool{}
	var visit func(name string)
	visit = func(name string) {
		d := byName[name]
		if done[name] {
			return
		}
		done[name] = true
		used := make([]string, 0, len(d.Uses))
		for _, u := range d.Uses {
			used = append(used, u.Document)
		}
		slices.Sort(used)
		for _, u := range used {
			visit(u)
		}
		out = append(out, d)
	}
	for _, name := range names {
		visit(name)
	}
	return out
}

type renderer struct {
	d Dialect
}

// q quotes an identifier.
func (r renderer) q(name string) string {
	if r.d == DialectMySQL {
		return "`" + name + "`"
	}
	return `"` + name + `"`
}

func (r renderer) list(names []string) string {
	quoted := make([]string, len(names))
	for i, n := range names {
		quoted[i] = r.q(n)
	}
	return strings.Join(quoted, ", ")
}

func (r renderer) table(t *Table) []string {
	create := r.createTable(t, t.Name, func(column string) string { return t.Name + "$" + column }, nil)
	out := []string{create}
	if r.d == DialectSQLite {
		for _, u := range sortedBy(t.Uniques, func(u Unique) string { return u.Name }) {
			out = append(out, "CREATE UNIQUE INDEX "+r.q(u.Name)+" ON "+r.q(t.Name)+" ("+r.list(u.Columns)+")")
		}
	}
	for _, x := range sortedBy(t.Indexes, func(x Index) string { return x.Name }) {
		columns := make([]string, len(x.Columns))
		for i, c := range x.Columns {
			columns[i] = r.q(c.Name)
			if c.Descending {
				columns[i] += " DESC"
			}
		}
		out = append(out, "CREATE INDEX "+r.q(x.Name)+" ON "+r.q(t.Name)+" ("+strings.Join(columns, ", ")+")")
	}
	return out
}

// createTable은 table t를 name으로 만드는 CREATE TABLE이다. checkName은 column의
// renderer CHECK 이름이고, hidden은 t의 column 뒤에 nullable이며 CHECK 없이 더하는
// column이다(docs/plans.md "Steps"의 SQLite 다시 만들기).
func (r renderer) createTable(t *Table, name string, checkName func(column string) string, hidden []Column) string {
	var parts []string
	for _, c := range t.Columns {
		parts = append(parts, r.column(c))
	}
	for _, c := range hidden {
		c.Null, c.Identity = true, false
		parts = append(parts, r.column(c))
	}
	identityInline := r.d == DialectSQLite && t.identity() != nil
	if !identityInline {
		parts = append(parts, "PRIMARY KEY ("+r.list(t.PrimaryKey.Columns)+")")
	}
	if r.d != DialectSQLite {
		for _, u := range sortedBy(t.Uniques, func(u Unique) string { return u.Name }) {
			parts = append(parts, "CONSTRAINT "+r.q(u.Name)+" UNIQUE ("+r.list(u.Columns)+")")
		}
	} else {
		for _, f := range sortedBy(t.ForeignKeys, func(f ForeignKey) string { return f.Name }) {
			parts = append(parts, r.foreignKey(f))
		}
	}
	for _, c := range t.Columns {
		if check := r.typeCheck(c); check != "" {
			parts = append(parts, "CONSTRAINT "+r.q(checkName(c.Name))+" CHECK ("+check+")")
		}
	}
	for _, k := range sortedBy(t.Checks, func(k Check) string { return k.Name }) {
		var b strings.Builder
		r.predicate(&b, t, k.Expression)
		parts = append(parts, "CONSTRAINT "+r.q(k.Name)+" CHECK ("+b.String()+")")
	}
	create := "CREATE TABLE " + r.q(name) + " (" + strings.Join(parts, ", ") + ")"
	if r.d == DialectMySQL {
		create += " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin"
	}
	return create
}

// identity returns the identity column of the table, or nil.
func (t *Table) identity() *Column {
	for i := range t.Columns {
		if t.Columns[i].Identity {
			return &t.Columns[i]
		}
	}
	return nil
}

func (r renderer) column(c Column) string {
	if c.Identity {
		switch r.d {
		case DialectMySQL:
			return r.q(c.Name) + " BIGINT NOT NULL AUTO_INCREMENT"
		case DialectPostgres:
			return r.q(c.Name) + " bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL"
		}
		return r.q(c.Name) + " INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT"
	}
	s := r.q(c.Name) + " " + r.typeText(c.Type)
	if c.Null {
		s += " NULL"
	} else {
		s += " NOT NULL"
	}
	if c.Default != nil {
		s += " DEFAULT " + r.defaultText(c.Type, *c.Default)
	}
	return s
}

func (r renderer) typeText(t Type) string {
	p, s, n := strconv.Itoa(t.Precision), strconv.Itoa(t.Scale), strconv.Itoa(t.Length)
	switch r.d {
	case DialectMySQL:
		switch t.Kind {
		case TypeI16:
			return "SMALLINT"
		case TypeI32:
			return "INT"
		case TypeI64:
			return "BIGINT"
		case TypeBool:
			return "tinyint(1)"
		case TypeDecimal:
			return "DECIMAL(" + p + "," + s + ")"
		case TypeF64:
			return "DOUBLE"
		case TypeVarchar:
			return "varchar(" + n + ") CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin"
		case TypeText:
			return "LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin"
		case TypeBytes:
			return "LONGBLOB"
		case TypeUUID:
			return "char(36) CHARACTER SET ascii COLLATE ascii_bin"
		case TypeDate:
			return "DATE"
		case TypeTime:
			return "TIME(" + p + ")"
		case TypeDatetime:
			return "DATETIME(" + p + ")"
		}
	case DialectPostgres:
		switch t.Kind {
		case TypeI16:
			return "smallint"
		case TypeI32:
			return "integer"
		case TypeI64:
			return "bigint"
		case TypeBool:
			return "boolean"
		case TypeDecimal:
			return "numeric(" + p + "," + s + ")"
		case TypeF64:
			return "double precision"
		case TypeVarchar:
			return "varchar(" + n + `) COLLATE "C"`
		case TypeText:
			return `text COLLATE "C"`
		case TypeBytes:
			return "bytea"
		case TypeUUID:
			return "uuid"
		case TypeDate:
			return "date"
		case TypeTime:
			return "time(" + p + ")"
		case TypeDatetime:
			return "timestamp(" + p + ")"
		}
	}
	switch t.Kind {
	case TypeI16:
		return "smallint"
	case TypeI32:
		return "integer"
	case TypeI64:
		return "bigint"
	case TypeBool:
		return "BOOLEAN"
	case TypeDecimal:
		return "DECIMALINT(" + p + "," + s + ")"
	case TypeF64:
		return "REAL"
	case TypeVarchar:
		return "varchar(" + n + ")"
	case TypeText, TypeUUID:
		return "TEXT"
	case TypeBytes:
		return "BLOB"
	case TypeDate:
		return "DATE"
	case TypeTime:
		return "TIME"
	}
	return "DATETIME"
}

func (r renderer) defaultText(t Type, d Default) string {
	if !d.Now {
		return r.literal(t, d.Literal)
	}
	switch r.d {
	case DialectMySQL:
		return "CURRENT_TIMESTAMP(" + strconv.Itoa(t.Precision) + ")"
	case DialectPostgres:
		return "statement_timestamp()"
	}
	switch p := t.Precision; {
	case p == 0:
		return "(strftime('%Y-%m-%d %H:%M:%S', 'now'))"
	case p <= 3:
		return "(substr(strftime('%Y-%m-%d %H:%M:%f', 'now'), 1, " + strconv.Itoa(20+p) + "))"
	default:
		return "(strftime('%Y-%m-%d %H:%M:%f', 'now') || '" + strings.Repeat("0", p-3) + "')"
	}
}

// literal writes a canonical literal of a column of type t in the dialect.
func (r renderer) literal(t Type, text string) string {
	switch {
	case text == "true" || text == "false":
		if r.d == DialectPostgres {
			return strings.ToUpper(text)
		}
		if text == "true" {
			return "1"
		}
		return "0"
	case strings.HasPrefix(text, "'"):
		if r.d == DialectMySQL {
			return strings.ReplaceAll(text, `\`, `\\`)
		}
		return text
	case t.Kind == TypeDecimal && r.d == DialectSQLite:
		return scaledDecimal(text)
	}
	return text
}

// scaledDecimal is a canonical decimal literal multiplied by 10^scale: the
// digits without the point, without leading zeros.
func scaledDecimal(text string) string {
	negative := strings.HasPrefix(text, "-")
	digits := strings.TrimLeft(strings.ReplaceAll(strings.TrimPrefix(text, "-"), ".", ""), "0")
	if digits == "" {
		return "0"
	}
	if negative {
		return "-" + digits
	}
	return digits
}

func (r renderer) foreignKey(f ForeignKey) string {
	return "CONSTRAINT " + r.q(f.Name) + " FOREIGN KEY (" + r.list(f.Columns) + ") REFERENCES " + r.q(f.Table) +
		" (" + r.list(f.References) + ") ON DELETE " + actionText(f.OnDelete) + " ON UPDATE " + actionText(f.OnUpdate)
}

func actionText(a Action) string {
	switch a {
	case ActionCascade:
		return "CASCADE"
	case ActionSetNull:
		return "SET NULL"
	}
	return "RESTRICT"
}

const uuidPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"

// typeCheck is the renderer CHECK of a column, or "" when the dialect
// enforces the type itself.
func (r renderer) typeCheck(c Column) string {
	if c.Identity {
		return ""
	}
	q := r.q(c.Name)
	t := c.Type
	switch r.d {
	case DialectMySQL:
		switch t.Kind {
		case TypeBool:
			return q + " IN (0, 1)"
		case TypeUUID:
			return "REGEXP_LIKE(" + q + ", '" + uuidPattern + "', 'c')"
		case TypeTime:
			return q + " >= '00:00:00' AND " + q + " < '24:00:00'"
		}
		return ""
	case DialectPostgres:
		if t.Kind == TypeTime {
			return q + " < '24:00:00'"
		}
		return ""
	}
	integer := "typeof(" + q + ") IN ('integer', 'null')"
	digits := func(n int) string { return strings.Repeat("[0-9]", n) }
	switch t.Kind {
	case TypeI16:
		return integer + " AND " + q + " BETWEEN -32768 AND 32767"
	case TypeI32:
		return integer + " AND " + q + " BETWEEN -2147483648 AND 2147483647"
	case TypeI64:
		return integer
	case TypeBool:
		return q + " IN (0, 1)"
	case TypeDecimal:
		limit := strings.Repeat("9", t.Precision)
		return integer + " AND " + q + " BETWEEN -" + limit + " AND " + limit
	case TypeF64:
		return "typeof(" + q + ") IN ('real', 'null')"
	case TypeVarchar:
		return "length(" + q + ") <= " + strconv.Itoa(t.Length)
	case TypeUUID:
		hex := func(n int) string { return strings.Repeat("[0-9a-f]", n) }
		return q + " GLOB '" + hex(8) + "-" + hex(4) + "-" + hex(4) + "-" + hex(4) + "-" + hex(12) + "'"
	case TypeDate:
		return q + " IS date(" + q + ")"
	case TypeTime:
		if t.Precision == 0 {
			return q + " IS time(" + q + ") AND " + q + " < '24:00:00'"
		}
		clock := "substr(" + q + ", 1, 8)"
		return "length(" + q + ") = " + strconv.Itoa(9+t.Precision) + " AND " + clock + " IS time(" + clock + ") AND " + clock +
			" < '24:00:00' AND substr(" + q + ", 9, 1) = '.' AND substr(" + q + ", 10) GLOB '" + digits(t.Precision) + "'"
	case TypeDatetime:
		if t.Precision == 0 {
			return "length(" + q + ") = 19 AND " + q + " IS datetime(" + q + ") AND substr(" + q + ", 12, 2) < '24'"
		}
		stamp := "substr(" + q + ", 1, 19)"
		return "length(" + q + ") = " + strconv.Itoa(20+t.Precision) + " AND " + stamp + " IS datetime(" + stamp + ") AND substr(" + q +
			", 12, 2) < '24' AND substr(" + q + ", 20, 1) = '.' AND substr(" + q + ", 21) GLOB '" + digits(t.Precision) + "'"
	}
	return ""
}

// predicate writes a typed check predicate of table t in the dialect.
func (r renderer) predicate(b *strings.Builder, t *Table, e Expr) {
	switch e := e.(type) {
	case ColumnRef:
		b.WriteString(r.q(e.Name))
	case Binary:
		if e.Op == "and" || e.Op == "or" {
			for i, side := range []Expr{e.Left, e.Right} {
				if i > 0 {
					b.WriteString(" " + strings.ToUpper(e.Op) + " ")
				}
				if needsParentheses(e.Op, side) {
					b.WriteString("(")
					r.predicate(b, t, side)
					b.WriteString(")")
				} else {
					r.predicate(b, t, side)
				}
			}
			return
		}
		typ := r.operandType(t, e.Left, e.Right)
		r.operand(b, typ, e.Left)
		b.WriteString(" " + e.Op + " ")
		r.operand(b, typ, e.Right)
	case In:
		typ := r.operandType(t, e.Operand, nil)
		r.operand(b, typ, e.Operand)
		if e.Negated {
			b.WriteString(" NOT")
		}
		b.WriteString(" IN (")
		for i, l := range e.List {
			if i > 0 {
				b.WriteString(", ")
			}
			b.WriteString(r.literal(typ, l.Text))
		}
		b.WriteString(")")
	case IsNull:
		r.operand(b, Type{}, e.Operand)
		if e.Negated {
			b.WriteString(" IS NOT NULL")
		} else {
			b.WriteString(" IS NULL")
		}
	}
}

// operandType is the type of the column among the operands; validation has
// made at least one of them a column.
func (r renderer) operandType(t *Table, a, b Expr) Type {
	for _, e := range []Expr{a, b} {
		if c, ok := e.(ColumnRef); ok {
			for _, col := range t.Columns {
				if col.Name == c.Name {
					return col.Type
				}
			}
		}
	}
	return Type{}
}

func (r renderer) operand(b *strings.Builder, typ Type, e Expr) {
	switch e := e.(type) {
	case ColumnRef:
		b.WriteString(r.q(e.Name))
	case Literal:
		b.WriteString(r.literal(typ, e.Text))
	}
}

// triggers writes the triggers of the immutable and audit settings.
func (r renderer) triggers(t *Table) []string {
	if t.Settings == nil {
		return nil
	}
	var out []string
	if t.Settings.Immutable != nil {
		message := "table " + t.Name + " is immutable"
		out = append(out, r.reject(t, "immutable_update", "BEFORE UPDATE", message)...)
		out = append(out, r.reject(t, "immutable_delete", "BEFORE DELETE", message)...)
	}
	if a := t.Settings.Audit; a != nil {
		out = append(out, r.history(t, a, "audit_insert", "AFTER INSERT", "'insert'", "NULL")...)
		out = append(out, r.history(t, a, "audit_update", "AFTER UPDATE", "'update'", "OLD."+r.q(a.Column))...)
		out = append(out, r.reject(t, "audit_delete", "BEFORE DELETE", "table "+t.Name+" deletes through its soft delete column")...)
	}
	return out
}

// trigger writes the trigger named <table>$<event> whose body is the single
// statement body; PostgreSQL wraps it in a function of the same name.
func (r renderer) trigger(t *Table, event, timing, body string, rejects bool) []string {
	name := r.q(t.Name + "$" + event)
	on := " " + timing + " ON " + r.q(t.Name) + " FOR EACH ROW "
	switch r.d {
	case DialectMySQL:
		return []string{"CREATE TRIGGER " + name + on + body}
	case DialectPostgres:
		function := "CREATE FUNCTION " + name + "() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN " + body + "; "
		if !rejects {
			function += "RETURN NULL; "
		}
		return []string{function + "END$$", "CREATE TRIGGER " + name + on + "EXECUTE FUNCTION " + name + "()"}
	}
	return []string{"CREATE TRIGGER " + name + on + "BEGIN " + body + "; END"}
}

func (r renderer) reject(t *Table, event, timing, message string) []string {
	var body string
	switch r.d {
	case DialectMySQL:
		body = "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '" + message + "'"
	case DialectPostgres:
		body = "RAISE EXCEPTION '" + message + "'"
	default:
		body = "SELECT RAISE(ABORT, '" + message + "')"
	}
	return r.trigger(t, event, timing, body, true)
}

func (r renderer) history(t *Table, a *AuditSetting, event, timing, action, previous string) []string {
	columns := []string{r.q(a.Action), r.q(a.Previous)}
	values := []string{action, previous}
	for _, c := range t.Columns {
		if !a.Records(c.Name) {
			continue
		}
		columns = append(columns, r.q(c.Name))
		values = append(values, "NEW."+r.q(c.Name))
	}
	body := "INSERT INTO " + r.q(a.History) + " (" + strings.Join(columns, ", ") + ") VALUES (" + strings.Join(values, ", ") + ")"
	return r.trigger(t, event, timing, body, false)
}
