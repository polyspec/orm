package dbspec

import "strconv"

// Document is one parsed dbspec document. Slices keep document order; Emit
// applies the canonical order. Comments hold whole comment lines from `#` to
// the end of the line, attached to the line that follows them.
type Document struct {
	Name     string
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
// an absent setting.
type Settings struct {
	Comments        []string
	Entity          *EntitySetting
	Updated         *ColumnSetting
	SoftDelete      *ColumnSetting
	SelectExplicit  *SelectExplicitSetting
	Codecs          []CodecSetting
	AESVersion      *ColumnSetting
	BlindIndex      *BlindIndexSetting
	Navigations     []NavigationSetting
	Immutable       *ImmutableSetting
	Audit           *AuditSetting
	ClosingComments []string
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

// AuditSetting is
// `audit into <history> operation <column> action <column> previous <column>`.
type AuditSetting struct {
	Comments  []string
	History   string
	Operation string
	Action    string
	Previous  string
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
	X        int64
	Y        int64
}
