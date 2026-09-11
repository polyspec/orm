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
	BindSlots []BindSlot `json:"bind_slots"`
	Assemble  *Assemble  `json:"assemble,omitempty"`
	Parent    *ParentRef `json:"parent,omitempty"` // relation steps: where the IN values come from
}

// ParentRef binds a relation step to the rows of an earlier step: the executor
// collects the distinct values at Index (skipping nulls, and rows failing
// IfParent), expands the step's single `parent` slot to that many placeholders,
// and skips the step entirely when there are none.
type ParentRef struct {
	Step     int       `json:"step"`
	Column   string    `json:"column"`
	Index    int       `json:"index"`
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
//
// Transform (executor-side, value-level): "" | "fulltext_boolean" (compatibility
// "+w1 +w2*") | "like_contains" | "like_starts" | "like_ends" (escape % _ \ then wrap).
type BindSlot struct {
	From      string `json:"from"`
	Param     int    `json:"param"`
	Transform string `json:"transform,omitempty"`
	Name      string `json:"name,omitempty"`
	Step      int    `json:"step,omitempty"`
	Column    string `json:"column,omitempty"`
}

// Assemble maps result columns positionally and describes how rows attach.
type Assemble struct {
	Entity   string   `json:"entity"`
	Alias    string   `json:"alias"`
	Columns  []OutCol `json:"columns"`
	Children []*Child `json:"children,omitempty"`
}

type OutCol struct {
	Index  int      `json:"index"`
	Name   string   `json:"name"`             // output name (column or alias)
	Column string   `json:"column,omitempty"` // source column, "" for expr
	Type   string   `json:"type"`
	Styles []string `json:"styles,omitempty"` // remaining app-side decode stages
	Hidden bool     `json:"hidden,omitempty"` // selected for binding only (drop_child_key): left out of array/JSON forms
}

// Child is a joined entity's slice of the same row (kind join, Assemble set)
// or a relation step's rows attached by key (kind one/many: the rows of
// Steps[Step] whose value at ChildIndex equals the parent row's value at
// ParentIndex; their assembly is Steps[Step].Assemble).
//   - one:  the first matching row (child ORDER BY decides), else null
//   - many: a collection keyed by KeyIndex in row order, else empty
//   - Flatten: the child's columns also appear as the parent's in array/JSON forms
type Child struct {
	Rel          string    `json:"rel"`
	Kind         string    `json:"kind"` // join | one | many
	Step         int       `json:"step,omitempty"`
	ParentColumn string    `json:"parent_column,omitempty"`
	ParentIndex  int       `json:"parent_index"`
	ChildColumn  string    `json:"child_column,omitempty"`
	ChildIndex   int       `json:"child_index"`
	KeyBy        string    `json:"key_by,omitempty"`
	KeyIndex     int       `json:"key_index"`
	Flatten      bool      `json:"flatten,omitempty"`
	Assemble     *Assemble `json:"assemble,omitempty"`
}
