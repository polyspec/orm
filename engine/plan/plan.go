// Package plan is what executors run: SQL text with bind slots and an
// assembly spec. Plans are value-independent so clients cache them by IR shape.
package plan

type Plan struct {
	SchemaHash string `json:"schema_hash"`
	Kind       string `json:"kind"`
	Steps      []Step `json:"steps"`
}

type Step struct {
	ID        int        `json:"id"`
	Role      string     `json:"role"` // main | count | relation
	SQL       string     `json:"sql"`
	Lock      string     `json:"lock,omitempty"` // adapter lock mode for a root row select
	BindSlots []BindSlot `json:"bind_slots"`
	Assemble  *Assemble  `json:"assemble,omitempty"`
	Parent    *ParentRef `json:"parent,omitempty"` // relation steps: where the IN values come from
}

// KeyRef identifies one ordered component of a row key.
type KeyRef struct {
	Column string `json:"column"`
	Index  int    `json:"index"`
}

// ParentRef binds a relation step to the rows of an earlier step. The executor
// collects distinct non-null key tuples in Keys order and skips the step when
// no parent key remains.
type ParentRef struct {
	Step     int       `json:"step"`
	Keys     []KeyRef  `json:"keys"`
	IfParent *IfParent `json:"if_parent,omitempty"`
}

// IfParent loads children only for parent rows whose value at Index equals Params[Param].
type IfParent struct {
	Column string `json:"column"`
	Index  int    `json:"index"`
	Param  int    `json:"param"`
}

// BindSlot tells the executor where the value for one placeholder comes from.
//   - param:  Params[Param] of the request, optionally passed through Transform
//   - secret: a key from executor config (Name = "aes")
//   - parent: the distinct values described by the step's ParentRef (relation IN lists; expands to N placeholders)
//   - now:    the executor's current UTC time as "YYYY-MM-DD HH:MM:SS.ffffff" (dialects without a sub-second clock)
//
// Transform (executor-side, value-level): "" | "fulltext_boolean" (
// "+w1 +w2*") | "like_contains" (escape % _ \ then wrap in %).
type BindSlot struct {
	From      string `json:"from"`
	Param     int    `json:"param"`
	Transform string `json:"transform,omitempty"`
	Name      string `json:"name,omitempty"`
	Step      int    `json:"step,omitempty"`
	Column    string `json:"column,omitempty"`
	// HostStyles: style stages the dialect leaves to the executor for this
	// value (aes/hex/ip on PostgreSQL/SQLite): the executor applies them to
	// the bound value before sending it (write order). Empty on MySQL.
	HostStyles []string `json:"host_styles,omitempty"`
	// ColType is the canonical type of the column this value is compared with
	// or assigned to (only date/time/datetime are carried): executors whose
	// language has no datetime type normalise exactly these, never a bare string
	// that merely looks like a timestamp.
	ColType string `json:"col_type,omitempty"`
}

// Assemble maps result columns positionally and describes how rows attach.
type Assemble struct {
	Entity   string   `json:"entity"`
	Alias    string   `json:"alias"`
	Columns  []OutCol `json:"columns"`
	Children []*Child `json:"children,omitempty"`
	Key      []KeyRef `json:"key"`
}

type OutCol struct {
	Index  int      `json:"index"`
	Name   string   `json:"name"`             // output name (column or alias)
	Column string   `json:"column,omitempty"` // source column, "" for expr
	Type   string   `json:"type"`
	Styles []string `json:"styles,omitempty"` // remaining app-side decode stages
	Hidden bool     `json:"hidden,omitempty"` // selected for writing only (the AES key version): left out of array/JSON forms
}

// Child is a joined entity's slice of the same row (kind join, Assemble set)
// or a relation step's rows attached by key (kind one/many: the rows of
// Steps[Step] whose value at ChildIndex equals the parent row's value at
// ParentIndex; their assembly is Steps[Step].Assemble).
//   - one:  the first matching row (child ORDER BY decides), else null
//   - many: a collection keyed by KeyIndex in row order, else empty
//   - Flatten: the child's columns also appear as the parent's in array/JSON forms
type Child struct {
	Rel        string   `json:"rel"`
	Kind       string   `json:"kind"` // join | one | many
	Step       int      `json:"step,omitempty"`
	ParentKeys []KeyRef `json:"parent_keys,omitempty"`
	ChildKeys  []KeyRef `json:"child_keys,omitempty"`
	Key        []KeyRef `json:"key,omitempty"`
	Flatten    bool     `json:"flatten,omitempty"`
	// Cascade: the related rows belong to this row (their FK points here) and
	// no_cascade_delete was not set — deleteCascade removes them first.
	Cascade  bool      `json:"cascade,omitempty"`
	Assemble *Assemble `json:"assemble,omitempty"`
}
