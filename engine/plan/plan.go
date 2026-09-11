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
}

// BindSlot tells the executor where the value for one placeholder comes from.
//   - param:  Params[Param] of the request, optionally passed through Transform
//   - secret: a key from executor config (Name = "aes")
//   - parent: dedup'd values of Column from step Step (relation IN lists; expands to N placeholders)
//
// Transform (executor-side, value-level): "" | "fulltext_boolean" (compatibility
// "+w1 +w2*") | "like_contains" | "like_starts" | "like_ends" (escape % _ \ then wrap).
type BindSlot struct {
	From      string `json:"from"`
	Param     int    `json:"param,omitempty"`
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
}

// Child is a joined entity's slice of the same row (Join) or a later step's
// rows attached by key (Relation).
type Child struct {
	Rel          string    `json:"rel"`
	Kind         string    `json:"kind"` // join | one | many
	Step         int       `json:"step,omitempty"`
	ParentColumn string    `json:"parent_column,omitempty"`
	ChildColumn  string    `json:"child_column,omitempty"`
	KeyBy        string    `json:"key_by,omitempty"`
	Flatten      bool      `json:"flatten,omitempty"`
	DropChildKey bool      `json:"drop_child_key,omitempty"`
	IfParent     *IfParent `json:"if_parent,omitempty"`
	Assemble     *Assemble `json:"assemble"`
}

type IfParent struct {
	Column string `json:"column"`
	Param  int    `json:"param"`
}
