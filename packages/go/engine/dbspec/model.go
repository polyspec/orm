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
	// External means the document is not owned by the set; it is an external document that the owning document uses through use.
	// External documents are parsed and checked, but not rendered, installed, compared, or generated
	// (docs/spec/dbspec.md "Documents and use"). They do not appear in document text.
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
	Marks           []MarkSetting
	Store           *StoreSetting
	KeyPrefix       *KeyPrefixSetting
	Title           *ColumnSetting
	Body            *ColumnSetting
	Order           *ColumnSetting
	Checkboxes      []CheckboxSetting
	ClosingComments []string
}

// StoreSetting is the table's storage declaration. Kind is files, document, or block.
// For block, Foreign holds the foreign key name of the parent row; for document and block, Shape holds list or table.
type StoreSetting struct {
	Comments []string
	Kind     string
	Foreign  string
	Shape    string
	// Shard is the `shard <column> <period>` clause, or nil if there is no clause. The SQL backend does not read it.
	Shard *StoreShard
}

// StoreShard is the time shard of the storage: Column is a non-null date or datetime column, and
// Period is year, month, or day.
type StoreShard struct {
	Column string
	Period string
}

// KeyPrefixSetting is `key_prefix '<p>'`: the assignment prefix of a character primary key.
type KeyPrefixSetting struct {
	Comments []string
	Prefix   string
}

// CheckboxSetting is the list glyph of one state.
type CheckboxSetting struct {
	Comments []string
	Column   string
	State    string
	Glyph    string
}

// HistorySetting is the history line of a state_machine. Row is the foreign key column of the history table,
// From, To, and At are the previous state, next state, and time columns of a state transition.
type HistorySetting struct {
	Comments []string
	Table    string
	Row      string
	From     string
	To       string
	At       string
}

// LimitSetting is the limit line of a state_machine: rows of that state cannot exceed Count.
type LimitSetting struct {
	Comments []string
	State    string
	Count    int64
}

// MarkSetting is `markdown <column>`: a manifest-only mark of a prose column.
type MarkSetting struct {
	Comments []string
	Column   string
}

// StateMachineSetting is the state machine of one column. Its lines keep their declaration order.
type StateMachineSetting struct {
	Comments []string
	Column   string
	Lines    []StateLineSetting
	History  *HistorySetting
	Limits   []LimitSetting
}

// StateLineSetting is a transition line, a terminal declaration line, or an initial declaration line.
type StateLineSetting struct {
	Comments []string
	Initial  bool
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

// AuditSetting is `audit into <history> column <column> references <table>
// action <column> previous <column> [tables <table> (<column>, <column>)]
// [exclude (<column>, ...) | include (<column>, ...)]`. Tables, TablesRecord
// and TablesName are the tables table and its record and name columns, all
// empty without the clause. Column is the column that holds the primary key of the audit record table that References names.
// It is the column that holds the key.
// If there is no list, Exclude and Include are nil, and a parsed setting has only one of them
// (docs/spec/dbspec.md "Audit").
type AuditSetting struct {
	Comments     []string
	History      string
	Column       string
	References   string
	Action       string
	Previous     string
	Tables       string
	TablesRecord string
	TablesName   string
	Exclude      []string
	Include      []string
}

// Records tells whether the audit trigger copies a column. Audit columns are always
// recorded, a column in the exclude list never is, and if there is an include list, only
// its columns are copied.
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

// Excluded returns the columns of t that the audit trigger does not copy, in column order.
// This is the list that schema text writes.
func (a *AuditSetting) Excluded(t *Table) []string {
	var out []string
	for _, c := range t.Columns {
		if !a.Records(c.Name) {
			out = append(out, c.Name)
		}
	}
	return out
}

// line writes the setting line. If columns is nil, it writes no list; otherwise it writes the list
// keyword and its columns.
func (a *AuditSetting) line(list string, columns []string) string {
	s := "audit into " + a.History + " column " + a.Column + " references " + a.References + " action " + a.Action + " previous " + a.Previous
	if a.Tables != "" {
		s += " tables " + a.Tables + " (" + a.TablesRecord + ", " + a.TablesName + ")"
	}
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
