package dbspec

import (
	"slices"
	"strconv"
	"strings"
)

// Document is one parsed dbspec document. Slices keep document order; Emit
// applies the canonical order. Comments hold whole comment lines from `#` to
// the end of the line, attached to the line that follows them.
type Document struct {
	Name string
	// External은 문서가 set의 소유가 아니라 소유한 문서가 use로 쓰는 외부 문서임을
	// 뜻한다. 외부 문서는 parse하고 검사하지만 렌더링, 설치, 비교, 생성하지 않는다
	// (docs/dbspec.md "Documents and use"). 문서 text에는 나오지 않는다.
	External bool
	Uses     []Use
	Tables   []Table
	Diagrams []Diagram
	// TrailingComments are comment lines that no line follows.
	TrailingComments []string
}

// Use makes tables of another document of the declared set available as
// foreign key targets.
type Use struct {
	Comments []string
	Document string
	Tables   []string
}

// Table is one table block.
type Table struct {
	Comments    []string
	Name        string
	Columns     []Column
	PrimaryKey  PrimaryKey
	Uniques     []Unique
	Indexes     []Index
	ForeignKeys []ForeignKey
	Checks      []Check
	// Settings is nil when the table has no settings block.
	Settings *Settings
	// ClosingComments precede the closing brace of the table.
	ClosingComments []string
}

// Column is one column line.
type Column struct {
	Comments []string
	Name     string
	Type     Type
	Null     bool
	Identity bool
	// Default is nil when the column has no default.
	Default *Default
}

// TypeKind names a dbspec type.
type TypeKind string

// The dbspec types.
const (
	TypeI16      TypeKind = "i16"
	TypeI32      TypeKind = "i32"
	TypeI64      TypeKind = "i64"
	TypeBool     TypeKind = "bool"
	TypeDecimal  TypeKind = "decimal"
	TypeF64      TypeKind = "f64"
	TypeVarchar  TypeKind = "varchar"
	TypeText     TypeKind = "text"
	TypeBytes    TypeKind = "bytes"
	TypeUUID     TypeKind = "uuid"
	TypeDate     TypeKind = "date"
	TypeTime     TypeKind = "time"
	TypeDatetime TypeKind = "datetime"
)

// Type is a column type with its parameters: Length for varchar(n),
// Precision and Scale for decimal(p,s), and Precision (fraction digits) for
// time(p) and datetime(p). Unused parameters are zero.
type Type struct {
	Kind      TypeKind
	Length    int
	Precision int
	Scale     int
}

// String returns the canonical type text, such as decimal(13,2).
func (t Type) String() string {
	switch t.Kind {
	case TypeDecimal:
		return "decimal(" + strconv.Itoa(t.Precision) + "," + strconv.Itoa(t.Scale) + ")"
	case TypeVarchar:
		return "varchar(" + strconv.Itoa(t.Length) + ")"
	case TypeTime, TypeDatetime:
		return string(t.Kind) + "(" + strconv.Itoa(t.Precision) + ")"
	}
	return string(t.Kind)
}

// Default is a column default: Now for `default now`, otherwise Literal holds
// the literal in canonical form, such as 1.00 or 'pending'.
type Default struct {
	Now     bool
	Literal string
}

// PrimaryKey is the unnamed primary key of a table.
type PrimaryKey struct {
	Comments []string
	Columns  []string
}

// Unique is a named unique key; NULLs are distinct.
type Unique struct {
	Comments []string
	Name     string
	Columns  []string
}

// Index is a named index.
type Index struct {
	Comments []string
	Name     string
	Columns  []IndexColumn
}

// IndexColumn is one index column with its direction.
type IndexColumn struct {
	Name       string
	Descending bool
}

// Action is a foreign key action.
type Action string

// The foreign key actions.
const (
	ActionRestrict Action = "restrict"
	ActionCascade  Action = "cascade"
	ActionSetNull  Action = "set_null"
)

// ForeignKey is a named foreign key from Columns to References of Table.
type ForeignKey struct {
	Comments   []string
	Name       string
	Columns    []string
	Table      string
	References []string
	OnDelete   Action
	OnUpdate   Action
}

// Check is a named check constraint.
type Check struct {
	Comments   []string
	Name       string
	Expression Expr
}

// Settings is the settings block of a table. A nil field or an empty slice is
// an absent setting. Codecs repeat per column, BlindIndexes per AES column and
// Navigations per foreign key.
type Settings struct {
	Comments        []string
	Entity          *EntitySetting
	Updated         *ColumnSetting
	SoftDelete      *ColumnSetting
	SelectExplicit  *SelectExplicitSetting
	Codecs          []CodecSetting
	AESVersion      *ColumnSetting
	BlindIndexes    []BlindIndexSetting
	Navigations     []NavigationSetting
	Immutable       *ImmutableSetting
	Audit           *AuditSetting
	StateMachine    *StateMachineSetting
	ClosingComments []string
}

// StateMachineSetting은 한 column의 상태 기계다. 줄은 선언 순서를 유지한다.
type StateMachineSetting struct {
	Comments []string
	Column   string
	Lines    []StateLineSetting
}

// StateLineSetting은 전환 줄이거나 terminal 선언 줄이다.
type StateLineSetting struct {
	Comments []string
	Terminal bool
	From     string
	To       string
	State    string
	Requires []string
}

// EntitySetting is `entity <name>`.
type EntitySetting struct {
	Comments []string
	Name     string
}

// ColumnSetting is a setting that names one column: `updated`,
// `soft_delete` or `aes_version`.
type ColumnSetting struct {
	Comments []string
	Column   string
}

// SelectExplicitSetting is `select explicit <column> ...`.
type SelectExplicitSetting struct {
	Comments []string
	Columns  []string
}

// CodecSetting is `codec <column> <stage> ...`.
type CodecSetting struct {
	Comments []string
	Column   string
	Stages   []string
}

// BlindIndexSetting is `blind_index <aes column> <index column>`.
type BlindIndexSetting struct {
	Comments    []string
	AESColumn   string
	IndexColumn string
}

// NavigationSetting is `navigation <foreign key> <child name> <parent name>`.
type NavigationSetting struct {
	Comments   []string
	ForeignKey string
	ChildName  string
	ParentName string
}

// ImmutableSetting is `immutable`.
type ImmutableSetting struct {
	Comments []string
}

// AuditSetting은 `audit into <history> column <column> references <table>
// action <column> previous <column> [exclude (<column>, ...) | include
// (<column>, ...)]`이다. Column은 audit 기록 table References의 primary
// key를 담는 column이다.
// 목록이 없으면 Exclude와 Include는 nil이고, parse한 setting은 둘 중 하나만
// 가진다(docs/dbspec.md "Audit").
type AuditSetting struct {
	Comments   []string
	History    string
	Column     string
	References string
	Action     string
	Previous   string
	Exclude    []string
	Include    []string
}

// Records는 audit trigger가 column을 복사하는지 알린다. audit column은
// 언제나, exclude 목록의 column은 언제나 아니며, include 목록이 있으면 그
// column만 복사한다.
func (a *AuditSetting) Records(column string) bool {
	switch {
	case column == a.Column:
		return true
	case a.Exclude != nil:
		return !slices.Contains(a.Exclude, column)
	case a.Include != nil:
		return slices.Contains(a.Include, column)
	}
	return true
}

// Excluded는 audit trigger가 복사하지 않는 t의 column을 column 순서로
// 돌려준다. schema text가 쓰는 목록이다.
func (a *AuditSetting) Excluded(t *Table) []string {
	var out []string
	for _, c := range t.Columns {
		if !a.Records(c.Name) {
			out = append(out, c.Name)
		}
	}
	return out
}

// line은 setting 줄을 쓴다. columns가 nil이면 목록 없이, 아니면 list
// keyword와 그 column을 쓴다.
func (a *AuditSetting) line(list string, columns []string) string {
	s := "audit into " + a.History + " column " + a.Column + " references " + a.References + " action " + a.Action + " previous " + a.Previous
	if columns != nil {
		s += " " + list + " (" + strings.Join(columns, ", ") + ")"
	}
	return s
}

// Diagram places tables for a view.
type Diagram struct {
	Comments        []string
	Name            string
	Entries         []DiagramEntry
	ClosingComments []string
}

// DiagramEntry is `<table> at <x> <y>`.
type DiagramEntry struct {
	Comments []string
	Table    string
	X        int32
	Y        int32
}
