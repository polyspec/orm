// Package plan is what executors run: SQL text with bind slots and an
// assembly spec. Plans are value-independent so clients cache them by IR shape.
package plan

type Plan struct {
	ManifestHash string `json:"manifest_hash"`
	Kind         string `json:"kind"`
	Steps        []Step `json:"steps"`
}

type Step struct {
	ID   int    `json:"id"`
	Role string `json:"role"` // main | count | relation
	SQL  string `json:"sql"`
	// Tables는 statement가 이름으로 쓰는 table이다: 정렬하고 중복을 뺀 물리 table 이름.
	Tables    []string   `json:"tables"`
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
//   - audit: transaction의 audit 기록 key. audit table의 insert와 update가 audit column에 쓴다. Name은 audit 기록 table이다.
//
// Transform (executor-side, value-level): "" | "like_contains" (escape % _ \ then wrap in %).
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
	// ColType은 placeholder가 받는 값의 dbspec type이다. column과 비교하거나
	// column에 할당하는 값은 그 column의 type이고(host style을 거친 값도 column에
	// 저장되는 값이므로 같다), SQL 쪽 style 함수가 받는 값은 그 함수 입력의 type,
	// 함수와 비교하는 값은 함수 결과의 type, secret은 text, config는 그 값을 쓰는
	// column의 type, now는 datetime, audit은 audit column의 type이다. parent
	// slot은 ColType 대신 KeyTypes를 싣는다. raw fragment의 placeholder만 type이
	// 없다(G5.32-3이 raw fragment를 없앤다).
	ColType string `json:"col_type,omitempty"`
	// KeyTypes는 parent slot이 펼치는 key 값의 dbspec type이며 key column 순서다.
	KeyTypes  []string `json:"key_types,omitempty"`
	Precision int      `json:"precision,omitempty"`
	Scale     int      `json:"scale,omitempty"`
}

// Assemble maps result columns positionally and describes how rows attach.
type Assemble struct {
	Entity  string   `json:"entity"`
	Alias   string   `json:"alias"`
	Columns []OutCol `json:"columns"`
	// AESVersion는 node가 AES column을 읽을 때 key version을 담은 column의
	// Columns 위치다. 고른 column이면 그대로, 아니면 숨은 column이다.
	AESVersion *int     `json:"aes_version,omitempty"`
	Children   []*Child `json:"children,omitempty"`
	Key        []KeyRef `json:"key"`
}

type OutCol struct {
	Index  int      `json:"index"`
	Name   string   `json:"name"`             // output name (column or alias)
	Column string   `json:"column,omitempty"` // source column, "" for expr
	Type   string   `json:"type"`
	Styles []string `json:"styles,omitempty"` // remaining client-side decode stages
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
