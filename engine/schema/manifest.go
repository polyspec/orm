package schema

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
)

// Manifest is the generated schema.json: everything the engine, generators and
// executors need, with every name and type already decided. Never hand-edited.
type Manifest struct {
	SchemaHash  string             `json:"schema_hash"`
	Order       []string           `json:"order"` // entity names in source order
	Entities    map[string]*Entity `json:"entities"`
	ORM         []*ORMDirective    `json:"orm,omitempty"`
	ExternalFKs []ExternalFK       `json:"external_fks,omitempty"`
	Immutable   []string           `json:"immutable,omitempty"`
}

// ExternalFK describes a foreign key whose target table belongs to another
// schema manifest. It affects generated DDL only; no duplicate target entity
// or generated relation is created in the package model.
type ExternalFK struct {
	Entity      string   `json:"entity"`
	Columns     []string `json:"columns"`
	TargetTable string   `json:"target_table"`
	TargetCols  []string `json:"target_columns"`
	Name        string   `json:"name,omitempty"`
	OnDelete    string   `json:"on_delete,omitempty"`
	Deferred    bool     `json:"deferred,omitempty"`
}

type Entity struct {
	Name        string                `json:"name"`
	Table       string                `json:"table"`
	RenamedFrom string                `json:"renamed_from,omitempty"`
	Comment     string                `json:"comment,omitempty"`
	PK          []string              `json:"pk"`
	Auto        string                `json:"auto,omitempty"`
	Columns     []*Col                `json:"columns"`
	Relations   map[string]*Rel       `json:"relations"`
	Unique      [][]string            `json:"unique,omitempty"`
	Indexes     map[string][]string   `json:"indexes,omitempty"`
	Fulltext    [][]string            `json:"fulltext,omitempty"`
	Checks      []Check               `json:"checks,omitempty"`
	Timestamps  *Timestamps           `json:"timestamps,omitempty"`
	Predicates  map[string]*Predicate `json:"predicates,omitempty"`  // %% predicate → generated <name>(args…) methods
	Scope       string                `json:"scope,omitempty"`       // %% scope <table> <column>
	SoftDelete  string                `json:"soft_delete,omitempty"` // %% soft_delete <table> <nullable datetime column>
	AESVersion  string                `json:"aes_version,omitempty"` // %% aes_version <table> <version column>
	Line        int                   `json:"-"`

	cols map[string]*Col
}

type Check struct {
	Name string `json:"name"`
	Expr string `json:"expr"`
}

// Column returns the column by name, or nil.
func (e *Entity) Column(name string) *Col { return e.cols[name] }

type Timestamps struct {
	Created string `json:"created,omitempty"`
	Updated string `json:"updated,omitempty"`
}

// Col is a column with its canonical type:
// i32 i64 f64 decimal string text bytes bool date time datetime json enum point inet
type Col struct {
	Name        string   `json:"name"`
	RenamedFrom string   `json:"renamed_from,omitempty"`
	Type        string   `json:"type"`
	Raw         string   `json:"raw"`
	Nullable    bool     `json:"nullable,omitempty"`
	Default     *string  `json:"default,omitempty"`
	Auto        bool     `json:"auto,omitempty"`
	OnUpdate    bool     `json:"on_update,omitempty"`
	Unsigned    bool     `json:"unsigned,omitempty"`
	Lazy        bool     `json:"lazy,omitempty"`
	Len         int      `json:"len,omitempty"`
	Precision   int      `json:"precision,omitempty"`
	Scale       int      `json:"scale,omitempty"`
	Enum        []string `json:"enum,omitempty"`
	Styles      []string `json:"styles,omitempty"`
	BlindIndex  string   `json:"blind_index,omitempty"`
	Ref         *Ref     `json:"ref,omitempty"`
	PK          bool     `json:"pk,omitempty"`
	FK          bool     `json:"fk,omitempty"`
	UK          bool     `json:"uk,omitempty"`
	Describe    string   `json:"describe,omitempty"`
	Comment     string   `json:"comment,omitempty"`
	Line        int      `json:"-"`
}

type Ref struct {
	Entity string `json:"entity"`
	Column string `json:"column"`
}

// Rel is one direction of a relationship line. Keys preserves the SQL column
// pair order for joins, relation loading, and row attachment.
type Rel struct {
	Name        string   `json:"name"`
	Kind        string   `json:"kind"`
	Target      string   `json:"target"`
	Keys        []RelKey `json:"keys"`
	Through     string   `json:"through,omitempty"`
	ThroughKeys []RelKey `json:"through_keys,omitempty"`
	OnDelete    string   `json:"on_delete,omitempty"`
}

type RelKey struct {
	Local  string `json:"local"`
	Target string `json:"target"`
}

// Predicate is a reusable expr fragment declared with `%% predicate <table> <name> : <fragment>`:
// backtick column names are checked against the entity, each `?` becomes a method argument.
type Predicate struct {
	Expr  string `json:"expr"`
	Arity int    `json:"arity"`
}

type BuildError struct {
	Line int
	Msg  string
}

func (e *BuildError) Error() string {
	if e.Line > 0 {
		return fmt.Sprintf("line %d: %s", e.Line, e.Msg)
	}
	return e.Msg
}

// Names that collide with DSL tokens or generated methods.
var reservedNames = map[string]bool{
	"or": true, "and": true, "on": true, "where": true, "select": true, "limit": true, "distinct": true,
	"one": true, "all": true, "count": true, "sum": true, "avg": true, "insert": true, "update": true,
	"delete": true, "save": true, "debug": true, "sql": true, "clone": true, "expr": true, "paginate": true,
	"flatten": true, "relation": true, "relations": true, "join": true, "left_join": true, "order_by": true,
	"group_by": true, "group_by_expr": true, "key_by": true, "set": true, "get": true, "get_count": true, "gets_count": true, "new": true,
}

var opSuffixes = []string{"_eq", "_not_eq", "_gt", "_gte", "_lt", "_lte", "_in", "_not_in", "_like",
	"_like_binary", "_contains", "_starts_with", "_ends_with", "_between", "_is_null", "_is_not_null",
	"_match", "_match_boolean"}

var (
	reTypeParen = regexp.MustCompile(`^([a-z]+)(?:\(([^)]*)\))?$`)
	reIdent     = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
)

// Build derives the manifest from parsed diagrams and validates it.
func Build(diagrams ...*Diagram) (*Manifest, error) {
	return build(false, diagrams...)
}

// BuildMigrationSource accepts a live schema that predates required AES version metadata.
// Migration targets must continue to use Build.
func BuildMigrationSource(diagrams ...*Diagram) (*Manifest, error) {
	return build(true, diagrams...)
}

func build(allowMissingAESVersion bool, diagrams ...*Diagram) (*Manifest, error) {
	m := &Manifest{Entities: map[string]*Entity{}}
	for _, d := range diagrams {
		m.ORM = append(m.ORM, d.ORM...)
		for _, e := range d.Entities {
			if _, dup := m.Entities[e.Name]; dup {
				return nil, &BuildError{e.Line, "duplicate entity " + e.Name}
			}
			ent, err := buildEntity(e)
			if err != nil {
				return nil, err
			}
			m.Entities[e.Name] = ent
			m.Order = append(m.Order, e.Name)
		}
	}
	for _, d := range diagrams {
		for _, x := range d.ORM {
			if x.Kind != "table" {
				continue
			}
			entity := x.Args["entity"]
			name := x.Args["name"]
			ent, ok := m.Entities[entity]
			if !ok {
				return nil, &BuildError{x.Line, "%% orm:table: unknown entity " + entity}
			}
			if !qualifiedTableName(name) {
				return nil, &BuildError{x.Line, "%% orm:table: name must be schema.table: " + name}
			}
			if ent.Table != entity {
				return nil, &BuildError{x.Line, "%% orm:table: duplicate entity " + entity}
			}
			ent.Table = name
		}
	}
	for _, d := range diagrams {
		for _, r := range d.Relations {
			if err := m.addRelation(r); err != nil {
				return nil, err
			}
		}
	}
	for _, d := range diagrams {
		for _, x := range d.Directives {
			if err := m.addDirective(x); err != nil {
				return nil, err
			}
		}
	}
	for _, d := range diagrams {
		for _, x := range d.ORM {
			if x.Kind == "immutable" {
				entity := x.Args["entity"]
				if m.Entities[entity] == nil {
					return nil, &BuildError{x.Line, "%% orm:immutable: unknown entity " + entity}
				}
				if !slices.Contains(m.Immutable, entity) {
					m.Immutable = append(m.Immutable, entity)
				}
			}
			if x.Kind != "foreign" {
				continue
			}
			fk, err := externalFK(x, m)
			if err != nil {
				return nil, err
			}
			m.ExternalFKs = append(m.ExternalFKs, fk)
		}
	}
	if err := m.validate(allowMissingAESVersion); err != nil {
		return nil, err
	}
	m.SchemaHash = m.hash()
	return m, nil
}

func externalFK(x *ORMDirective, m *Manifest) (ExternalFK, error) {
	entity := x.Args["entity"]
	e := m.Entities[entity]
	if e == nil {
		return ExternalFK{}, &BuildError{x.Line, "%% orm:foreign: unknown entity " + entity}
	}
	columns := splitDirectiveList(x.Args["columns"])
	if len(columns) == 0 {
		return ExternalFK{}, &BuildError{x.Line, "%% orm:foreign: columns must not be empty"}
	}
	for _, column := range columns {
		if e.Column(column) == nil {
			return ExternalFK{}, &BuildError{x.Line, fmt.Sprintf("%% orm:foreign: unknown column %s.%s", entity, column)}
		}
	}
	table, targetColumns, ok := parseExternalReference(x.Args["references"])
	if !ok || table == "" || len(targetColumns) != len(columns) {
		return ExternalFK{}, &BuildError{x.Line, "%% orm:foreign: references must be table(col,...) with matching columns"}
	}
	name := x.Args["name"]
	if name == "" {
		name = "fk_" + strings.ReplaceAll(e.Table, ".", "_") + "_" + strings.Join(columns, "_")
	}
	onDelete := x.Args["on_delete"]
	if onDelete != "" && onDelete != "cascade" && onDelete != "setnull" {
		return ExternalFK{}, &BuildError{x.Line, "%% orm:foreign: on_delete must be cascade or setnull"}
	}
	deferred := x.Args["deferred"] == "true"
	if value := x.Args["deferred"]; value != "" && value != "true" && value != "false" {
		return ExternalFK{}, &BuildError{x.Line, "%% orm:foreign: deferred must be true or false"}
	}
	return ExternalFK{Entity: entity, Columns: columns, TargetTable: table, TargetCols: targetColumns, Name: name, OnDelete: onDelete, Deferred: deferred}, nil
}

func splitDirectiveList(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			result = append(result, part)
		}
	}
	return result
}

func parseExternalReference(value string) (string, []string, bool) {
	open := strings.LastIndexByte(value, '(')
	if open <= 0 || !strings.HasSuffix(value, ")") {
		return "", nil, false
	}
	table := strings.TrimSpace(value[:open])
	columns := splitDirectiveList(strings.TrimSuffix(value[open+1:], ")"))
	return table, columns, table != "" && len(columns) > 0
}

func qualifiedTableName(name string) bool {
	parts := strings.Split(name, ".")
	return len(parts) == 2 && reIdent.MatchString(parts[0]) && reIdent.MatchString(parts[1])
}

func buildEntity(e *DEntity) (*Entity, error) {
	if !reIdent.MatchString(e.Name) {
		return nil, &BuildError{e.Line, "entity name must be snake_case: " + e.Name}
	}
	ent := &Entity{Name: e.Name, Table: e.Name, Comment: e.Comment, Relations: map[string]*Rel{}, Line: e.Line, cols: map[string]*Col{}}
	for _, dc := range e.Columns {
		if err := checkColumnName(dc.Name); err != nil {
			return nil, &BuildError{dc.Line, err.Error()}
		}
		if _, dup := ent.cols[dc.Name]; dup {
			return nil, &BuildError{dc.Line, "duplicate column " + e.Name + "." + dc.Name}
		}
		c, err := buildColumn(dc)
		if err != nil {
			return nil, &BuildError{dc.Line, err.Error()}
		}
		for _, k := range dc.Keys {
			switch k {
			case "PK":
				c.PK = true
				ent.PK = append(ent.PK, c.Name)
			case "FK":
				c.FK = true
			case "UK":
				c.UK = true
				ent.Unique = append(ent.Unique, []string{c.Name})
			}
		}
		if c.Auto {
			if ent.Auto != "" {
				return nil, &BuildError{dc.Line, "two auto columns in " + e.Name}
			}
			ent.Auto = c.Name
		}
		ent.Columns = append(ent.Columns, c)
		ent.cols[c.Name] = c
	}
	if len(ent.PK) == 0 {
		return nil, &BuildError{e.Line, "entity " + e.Name + " has no PK"}
	}
	// The conventional version column remains an input convention, but the
	// generated clients consume the resolved manifest field rather than naming
	// it themselves. An explicit %% aes_version directive may replace it.
	if ent.cols["aes_key_version"] != nil {
		ent.AESVersion = "aes_key_version"
	}
	// Timestamps by convention; %% timestamps overrides.
	if ent.cols["created_ts"] != nil || ent.cols["updated_ts"] != nil {
		ent.Timestamps = &Timestamps{}
		if ent.cols["created_ts"] != nil {
			ent.Timestamps.Created = "created_ts"
		}
		if ent.cols["updated_ts"] != nil {
			ent.Timestamps.Updated = "updated_ts"
		}
	}
	return ent, nil
}

func checkColumnName(n string) error {
	if !reIdent.MatchString(n) {
		return fmt.Errorf("column name must be snake_case: %s", n)
	}
	if strings.Contains(n, "__") {
		return fmt.Errorf("column name may not contain '__': %s", n)
	}
	for _, bad := range []string{"_and_", "_or_", "_with_"} {
		if strings.Contains(n, bad) {
			return fmt.Errorf("column name may not contain %q: %s", bad, n)
		}
	}
	for _, suf := range opSuffixes {
		if strings.HasSuffix(n, suf) {
			return fmt.Errorf("column name may not end with operator suffix %q: %s", suf, n)
		}
	}
	if reservedNames[n] {
		return fmt.Errorf("column name is a reserved DSL word: %s", n)
	}
	return nil
}

// buildColumn maps the raw DB type to the canonical type and applies the
// naming conventions (is_* → bool, *_seq prefix styles, text/blob → lazy).
func buildColumn(dc *DColumn) (*Col, error) {
	c := &Col{Name: dc.Name, Raw: dc.Type, Nullable: dc.Nullable, Default: dc.Default, Auto: dc.Auto,
		OnUpdate: dc.OnUpdate, Unsigned: dc.Unsigned, Lazy: dc.Lazy, Styles: dc.Styles, Describe: dc.Describe, Comment: dc.DBComment, Line: dc.Line}
	m := reTypeParen.FindStringSubmatch(strings.ToLower(dc.Type))
	if m == nil {
		return nil, fmt.Errorf("column %s: bad type %q", dc.Name, dc.Type)
	}
	base, arg := m[1], m[2]
	switch base {
	case "tinyint", "smallint", "mediumint", "int", "integer":
		c.Type = "i32"
		if dc.Unsigned {
			c.Type = "i64" // an unsigned 32-bit column needs 64 bits on the host side
		}
		if base == "tinyint" && (dc.Bool || (strings.HasPrefix(dc.Name, "is_") && !dc.Int)) {
			c.Type = "bool"
		}
	case "bigint":
		c.Type = "i64"
	case "float", "double", "real":
		c.Type = "f64"
	case "decimal", "numeric":
		c.Type = "decimal"
		if arg != "" {
			p, s, ok := strings.Cut(arg, "_")
			var err error
			if c.Precision, err = strconv.Atoi(p); err != nil {
				return nil, fmt.Errorf("column %s: decimal precision %q", dc.Name, arg)
			}
			if ok {
				if c.Scale, err = strconv.Atoi(s); err != nil {
					return nil, fmt.Errorf("column %s: decimal scale %q", dc.Name, arg)
				}
			}
		}
	case "varchar", "char":
		c.Type = "string"
		if arg == "" {
			return nil, fmt.Errorf("column %s: %s requires a positive length", dc.Name, base)
		}
		n, err := strconv.Atoi(arg)
		if err != nil || n < 1 {
			return nil, fmt.Errorf("column %s: %s requires a positive length, got %q", dc.Name, base, arg)
		}
		c.Len = n
	case "uuid":
		// UUID is represented as a string in generated language bindings while
		// retaining its native database type through Col.Raw for DDL.
		c.Type = "string"
	case "text", "tinytext", "mediumtext", "longtext":
		c.Type = "text"
	case "blob", "tinyblob", "mediumblob", "longblob", "varbinary", "binary":
		c.Type = "bytes"
		if arg != "" {
			c.Len, _ = strconv.Atoi(arg)
		}
	case "date":
		c.Type = "date"
	case "time":
		c.Type = "time"
	case "datetime", "timestamp":
		c.Type = "datetime"
		if arg != "" {
			c.Precision, _ = strconv.Atoi(arg)
		}
	case "json":
		c.Type = "json"
	case "enum":
		c.Type = "enum"
		if arg == "" {
			return nil, fmt.Errorf("column %s: enum needs values enum(a_b_c)", dc.Name)
		}
		c.Enum = strings.Split(arg, "_")
	case "point":
		c.Type = "point"
	case "bool", "boolean":
		c.Type = "bool"
	default:
		return nil, fmt.Errorf("column %s: unsupported type %q", dc.Name, dc.Type)
	}
	// Style inference from column naming: aes_hex_x, aes_x, gz_x, json_x, jsons_x,
	// base64_x, serialize_x, curlfile_serialize_x; column named ip.
	if len(c.Styles) == 0 {
		switch {
		case strings.HasPrefix(dc.Name, "aes_hex_"):
			c.Styles = []string{"aes", "hex"}
		case strings.HasPrefix(dc.Name, "aes_") && dc.Name != "aes_key_version":
			c.Styles = []string{"aes"}
		case strings.HasPrefix(dc.Name, "gz_"):
			c.Styles = []string{"serialize", "gz"}
		case strings.HasPrefix(dc.Name, "jsons_"):
			c.Styles = []string{"jsons"}
		case strings.HasPrefix(dc.Name, "json_"):
			c.Styles = []string{"json"}
		case strings.HasPrefix(dc.Name, "yaml_"):
			c.Styles = []string{"yaml"}
		case strings.HasPrefix(dc.Name, "base64_"):
			c.Styles = []string{"serialize", "base64"}
		case strings.HasPrefix(dc.Name, "serialize_"):
			c.Styles = []string{"serialize"}
		case strings.HasPrefix(dc.Name, "curlfile_serialize_"):
			c.Styles = []string{"curlfile", "serialize"}
		case dc.Name == "ip":
			c.Styles = []string{"ip"}
		}
	}
	if len(c.Styles) == 1 && c.Styles[0] == "ip" {
		c.Type = "inet"
	}
	if c.Type == "json" && len(c.Styles) == 0 {
		c.Styles = []string{"json"}
	}
	// The AES version is plaintext metadata. Keep it out of the default
	// projection while retaining it in explicit rotation queries.
	if dc.Name == "aes_key_version" {
		c.Lazy = true
	}
	// Lazy by default for large or encoded columns; aes_hex stays eager.
	if !c.Lazy && !dc.Lazy {
		switch {
		case c.Type == "text" || c.Type == "bytes" && c.Type != "inet":
			c.Lazy = true
		case len(c.Styles) > 0 && !(len(c.Styles) == 2 && c.Styles[0] == "aes" && c.Styles[1] == "hex") && c.Styles[0] != "ip":
			c.Lazy = true
		}
	}
	if dc.Ref != "" {
		ent, col, _ := strings.Cut(dc.Ref, ".")
		c.Ref = &Ref{Entity: ent, Column: col}
		c.FK = true
	}
	return c, nil
}

func (m *Manifest) addRelation(r *DRelation) error {
	parent, ok := m.Entities[r.Parent]
	if !ok {
		return &BuildError{r.Line, "relation references unknown entity " + r.Parent}
	}
	child, ok := m.Entities[r.Child]
	if !ok {
		return &BuildError{r.Line, "relation references unknown entity " + r.Child}
	}
	if len(r.FKs) != len(parent.PK) {
		return &BuildError{r.Line, fmt.Sprintf("relation %s -> %s: %d FK columns do not match %d target PK columns", r.Parent, r.Child, len(r.FKs), len(parent.PK))}
	}
	for i, name := range r.FKs {
		fk := child.cols[name]
		if fk == nil {
			return &BuildError{r.Line, fmt.Sprintf("relation %s -> %s: FK column %s not in %s", r.Parent, r.Child, name, r.Child)}
		}
		fk.FK = true
		if fk.Ref == nil {
			fk.Ref = &Ref{Entity: parent.Name, Column: parent.PK[i]}
		} else if fk.Ref.Entity != parent.Name || fk.Ref.Column != parent.PK[i] {
			return &BuildError{r.Line, fmt.Sprintf("relation %s -> %s: FK column %s references %s.%s, expected %s.%s", r.Parent, r.Child, name, fk.Ref.Entity, fk.Ref.Column, parent.Name, parent.PK[i])}
		}
	}
	// Cardinality: right side of the token is the child side.
	childMany := strings.HasSuffix(r.Cardinality, "{")
	childName := r.ChildName
	if childName == "" {
		if len(r.FKs) != 1 {
			return &BuildError{r.Line, fmt.Sprintf("relation %s -> %s: composite relation must name both sides", r.Parent, r.Child)}
		}
		childName = strings.TrimSuffix(strings.TrimSuffix(r.FKs[0], "_seq"), "_id")
		if childName == r.FKs[0] {
			return &BuildError{r.Line, fmt.Sprintf("relation %s -> %s: cannot derive a name from FK %s; write (child / parent) in the label", r.Parent, r.Child, r.FKs[0])}
		}
	}
	parentName := r.ParentName
	if parentName == "" {
		base := strings.TrimPrefix(child.Name, parent.Name+"_")
		if childMany {
			parentName = plural(base)
		} else {
			parentName = base
		}
	}
	if _, dup := child.Relations[childName]; dup {
		return &BuildError{r.Line, fmt.Sprintf("relation name %s.%s already used; name the sides in the label", child.Name, childName)}
	}
	if _, dup := parent.Relations[parentName]; dup {
		return &BuildError{r.Line, fmt.Sprintf("relation name %s.%s already used; name the sides in the label", parent.Name, parentName)}
	}
	childKeys := make([]RelKey, len(r.FKs))
	parentKeys := make([]RelKey, len(r.FKs))
	for i := range r.FKs {
		childKeys[i] = RelKey{Local: r.FKs[i], Target: parent.PK[i]}
		parentKeys[i] = RelKey{Local: parent.PK[i], Target: r.FKs[i]}
	}
	child.Relations[childName] = &Rel{Name: childName, Kind: "one", Target: parent.Name, Keys: childKeys, OnDelete: r.OnDelete}
	kind := "many"
	if !childMany {
		kind = "one"
	}
	parent.Relations[parentName] = &Rel{Name: parentName, Kind: kind, Target: child.Name, Keys: parentKeys, OnDelete: r.OnDelete}
	return nil
}

func plural(s string) string {
	switch {
	case strings.HasSuffix(s, "y") && len(s) > 1 && !strings.ContainsRune("aeiou", rune(s[len(s)-2])):
		return s[:len(s)-1] + "ies"
	case strings.HasSuffix(s, "s"), strings.HasSuffix(s, "x"), strings.HasSuffix(s, "ch"), strings.HasSuffix(s, "sh"):
		return s + "es"
	default:
		return s + "s"
	}
}

func (m *Manifest) addDirective(x *Directive) error {
	ent, ok := m.Entities[x.Table]
	if !ok {
		return &BuildError{x.Line, "%% " + x.Kind + ": unknown entity " + x.Table}
	}
	for _, c := range x.Columns {
		if x.Kind != "predicate" && x.Kind != "many_to_many" && ent.cols[c] == nil {
			return &BuildError{x.Line, fmt.Sprintf("%%%% %s %s: unknown column %s", x.Kind, x.Table, c)}
		}
	}
	switch x.Kind {
	case "table_comment":
		ent.Comment = x.Raw
	case "column_comment":
		ent.cols[x.Columns[0]].Comment = x.Raw
	case "rename_table":
		if ent.RenamedFrom != "" {
			return &BuildError{x.Line, "rename_table declared twice for " + ent.Name}
		}
		ent.RenamedFrom = x.Name
	case "rename_column":
		column := ent.cols[x.Columns[0]]
		if column.RenamedFrom != "" {
			return &BuildError{x.Line, "rename_column declared twice for " + ent.Name + "." + column.Name}
		}
		column.RenamedFrom = x.Name
	case "unique":
		ent.Unique = append(ent.Unique, x.Columns)
	case "index":
		if ent.Indexes == nil {
			ent.Indexes = map[string][]string{}
		}
		name := x.Name
		if name == "" {
			name = "ix_" + strings.Join(x.Columns, "_")
		}
		if _, dup := ent.Indexes[name]; dup {
			return &BuildError{x.Line, "duplicate index name " + name}
		}
		ent.Indexes[name] = x.Columns
	case "fulltext":
		ent.Fulltext = append(ent.Fulltext, x.Columns)
	case "check":
		if slices.IndexFunc(ent.Checks, func(c Check) bool { return c.Name == x.Name }) >= 0 {
			return &BuildError{x.Line, "check " + x.Name + " declared twice"}
		}
		if ent.Column(x.Name) != nil {
			return &BuildError{x.Line, "check " + x.Name + " collides with a column"}
		}
		for _, col := range backtickNames(x.Raw) {
			if ent.Column(col) == nil {
				return &BuildError{x.Line, "check " + x.Name + ": unknown column `" + col + "`"}
			}
		}
		ent.Checks = append(ent.Checks, Check{Name: x.Name, Expr: x.Raw})
	case "timestamps":
		ent.Timestamps = &Timestamps{Created: x.Columns[0], Updated: x.Columns[1]}
	case "scope":
		if ent.Scope != "" {
			return &BuildError{x.Line, "scope declared twice for " + ent.Name}
		}
		c := ent.Column(x.Columns[0])
		if c == nil {
			return &BuildError{x.Line, "scope column " + x.Columns[0] + " is unknown"}
		}
		if c.Nullable {
			return &BuildError{x.Line, "scope column " + x.Columns[0] + " must be NOT NULL"}
		}
		if c.Type != "i32" && c.Type != "i64" && c.Type != "string" && c.Type != "enum" {
			return &BuildError{x.Line, "scope column " + x.Columns[0] + " must be an integer or string"}
		}
		ent.Scope = x.Columns[0]
	case "aes_version":
		if ent.AESVersion != "" && ent.AESVersion != "aes_key_version" {
			return &BuildError{x.Line, "aes version declared twice for " + ent.Name}
		}
		column := ent.Column(x.Columns[0])
		if column == nil {
			return &BuildError{x.Line, "aes version column " + x.Columns[0] + " is unknown"}
		}
		ent.AESVersion = x.Columns[0]
	case "soft_delete":
		if ent.SoftDelete != "" {
			return &BuildError{x.Line, "soft_delete declared twice for " + ent.Name}
		}
		c := ent.Column(x.Columns[0])
		if c == nil {
			return &BuildError{x.Line, "soft_delete column " + x.Columns[0] + " is unknown"}
		}
		if c.Type != "datetime" || !c.Nullable {
			return &BuildError{x.Line, "soft_delete column " + x.Columns[0] + " must be a nullable datetime"}
		}
		ent.SoftDelete = x.Columns[0]
	case "blind_index":
		encrypted := ent.Column(x.Columns[0])
		index := ent.Column(x.Columns[1])
		if encrypted == index {
			return &BuildError{x.Line, "blind index source and target must differ"}
		}
		if !slices.Contains(encrypted.Styles, "aes") {
			return &BuildError{x.Line, fmt.Sprintf("blind index source %s is not an AES column", encrypted.Name)}
		}
		if slices.Contains(index.Styles, "aes") {
			return &BuildError{x.Line, fmt.Sprintf("blind index target %s must not be an AES column", index.Name)}
		}
		if index.Type != "string" && index.Type != "bytes" {
			return &BuildError{x.Line, fmt.Sprintf("blind index target %s must be string or bytes", index.Name)}
		}
		if index.Type == "string" && index.Len < 64 {
			return &BuildError{x.Line, fmt.Sprintf("blind index target %s must hold 64 hexadecimal characters", index.Name)}
		}
		if encrypted.Nullable != index.Nullable {
			return &BuildError{x.Line, fmt.Sprintf("blind index target %s nullability must match source %s", index.Name, encrypted.Name)}
		}
		indexed := false
		for _, columns := range ent.Indexes {
			if slices.Equal(columns, []string{index.Name}) {
				indexed = true
				break
			}
		}
		if !indexed {
			return &BuildError{x.Line, fmt.Sprintf("blind index target %s requires a declared single-column index", index.Name)}
		}
		if encrypted.BlindIndex != "" {
			return &BuildError{x.Line, fmt.Sprintf("blind index source %s is declared twice", encrypted.Name)}
		}
		for _, col := range ent.Columns {
			if col.BlindIndex == index.Name {
				return &BuildError{x.Line, fmt.Sprintf("blind index target %s is declared twice", index.Name)}
			}
		}
		encrypted.BlindIndex = index.Name
	case "many_to_many":
		if len(x.Columns) != 2 {
			return &BuildError{x.Line, "many_to_many requires target entity and reverse relation"}
		}
		target, ok := m.Entities[x.Columns[0]]
		if !ok {
			return &BuildError{x.Line, "many_to_many target entity " + x.Columns[0] + " is unknown"}
		}
		through, ok := m.Entities[x.Through]
		if !ok {
			return &BuildError{x.Line, "many_to_many through entity " + x.Through + " is unknown"}
		}
		if _, dup := ent.Relations[x.Name]; dup {
			return &BuildError{x.Line, "relation name " + ent.Name + "." + x.Name + " already used"}
		}
		if _, dup := target.Relations[x.Columns[1]]; dup {
			return &BuildError{x.Line, "relation name " + target.Name + "." + x.Columns[1] + " already used"}
		}
		sourceKeys, targetKeys := throughForeignKeys(through, ent.Name, target.Name)
		if len(sourceKeys) != len(ent.PK) || len(targetKeys) != len(target.PK) {
			return &BuildError{x.Line, fmt.Sprintf("many_to_many %s.%s through %s requires one FK for every source and target PK component", ent.Name, x.Name, through.Name)}
		}
		if len(through.PK) != len(sourceKeys)+len(targetKeys) {
			return &BuildError{x.Line, "many_to_many through entity primary key must contain exactly the source and target FK columns"}
		}
		for _, column := range append(append([]string{}, sourceKeys...), targetKeys...) {
			if !slices.Contains(through.PK, column) {
				return &BuildError{x.Line, "many_to_many through entity primary key must contain " + column}
			}
		}
		forward := &Rel{Name: x.Name, Kind: "many", Target: target.Name, Through: through.Name}
		for i, c := range sourceKeys {
			forward.Keys = append(forward.Keys, RelKey{Local: ent.PK[i], Target: c})
		}
		for i, c := range targetKeys {
			forward.ThroughKeys = append(forward.ThroughKeys, RelKey{Local: c, Target: target.PK[i]})
		}
		reverse := &Rel{Name: x.Columns[1], Kind: "many", Target: ent.Name, Through: through.Name}
		for i, c := range targetKeys {
			reverse.Keys = append(reverse.Keys, RelKey{Local: target.PK[i], Target: c})
		}
		for i, c := range sourceKeys {
			reverse.ThroughKeys = append(reverse.ThroughKeys, RelKey{Local: c, Target: ent.PK[i]})
		}
		ent.Relations[x.Name] = forward
		target.Relations[x.Columns[1]] = reverse
	case "predicate":
		if ent.Predicates == nil {
			ent.Predicates = map[string]*Predicate{}
		}
		if err := checkColumnName(x.Name); err != nil {
			return &BuildError{x.Line, "predicate " + x.Name + ": " + err.Error()}
		}
		if _, dup := ent.Predicates[x.Name]; dup {
			return &BuildError{x.Line, "predicate " + x.Name + " declared twice"}
		}
		if ent.Column(x.Name) != nil {
			return &BuildError{x.Line, "predicate " + x.Name + " collides with a column"}
		}
		for _, col := range backtickNames(x.Raw) {
			if ent.Column(col) == nil {
				return &BuildError{x.Line, "predicate " + x.Name + ": unknown column `" + col + "`"}
			}
		}
		ent.Predicates[x.Name] = &Predicate{Expr: x.Raw, Arity: strings.Count(x.Raw, "?")}
	}
	return nil
}

func throughForeignKeys(through *Entity, source, target string) ([]string, []string) {
	var sourceKeys, targetKeys []string
	for _, c := range through.Columns {
		if c.Ref == nil {
			continue
		}
		if c.Ref.Entity == source {
			sourceKeys = append(sourceKeys, c.Name)
		}
		if c.Ref.Entity == target {
			targetKeys = append(targetKeys, c.Name)
		}
	}
	return sourceKeys, targetKeys
}

func (m *Manifest) validate(allowMissingAESVersion bool) error {
	renamedTables := map[string]string{}
	for _, name := range m.Order {
		e := m.Entities[name]
		if e.RenamedFrom != "" {
			if e.RenamedFrom == e.Name {
				return &BuildError{e.Line, "rename_table source equals target " + e.Name}
			}
			if target := renamedTables[e.RenamedFrom]; target != "" {
				return &BuildError{e.Line, fmt.Sprintf("rename_table source %s is used by %s and %s", e.RenamedFrom, target, e.Name)}
			}
			renamedTables[e.RenamedFrom] = e.Name
		}
		targetColumns := map[string]bool{}
		for _, c := range e.Columns {
			targetColumns[c.Name] = true
		}
		renamedColumns := map[string]string{}
		for _, c := range e.Columns {
			if c.RenamedFrom == "" {
				continue
			}
			if c.RenamedFrom == c.Name {
				return &BuildError{c.Line, "rename_column source equals target " + e.Name + "." + c.Name}
			}
			if targetColumns[c.RenamedFrom] {
				return &BuildError{c.Line, fmt.Sprintf("rename_column source %s.%s remains a target column", e.Name, c.RenamedFrom)}
			}
			if target := renamedColumns[c.RenamedFrom]; target != "" {
				return &BuildError{c.Line, fmt.Sprintf("rename_column source %s.%s is used by %s and %s", e.Name, c.RenamedFrom, target, c.Name)}
			}
			renamedColumns[c.RenamedFrom] = c.Name
		}
	}
	for _, name := range m.Order {
		e := m.Entities[name]
		for _, c := range e.Columns {
			if len(c.Styles) > 0 && c.Styles[0] == "aes" {
				version := e.Column(e.AESVersion)
				if version == nil || version.Nullable || (version.Type != "i32" && version.Type != "i64") {
					if allowMissingAESVersion && version == nil {
						continue
					}
					return &BuildError{e.Line, fmt.Sprintf("%s.%s requires a non-null integer aes version column", e.Name, c.Name)}
				}
			}
		}
		for rn, r := range e.Relations {
			if reservedNames[rn] {
				return &BuildError{e.Line, fmt.Sprintf("relation name %s.%s is a reserved DSL word", e.Name, rn)}
			}
			if e.cols[rn] != nil {
				return &BuildError{e.Line, fmt.Sprintf("relation name %s.%s collides with a column; name the sides in the label", e.Name, rn)}
			}
			if _, ok := m.Entities[r.Target]; !ok {
				return &BuildError{e.Line, "relation target missing: " + r.Target}
			}
			if r.Through != "" {
				through, ok := m.Entities[r.Through]
				if !ok {
					return &BuildError{e.Line, fmt.Sprintf("relation %s.%s through entity missing: %s", e.Name, rn, r.Through)}
				}
				if r.Kind != "many" || len(r.Keys) != len(e.PK) || len(r.ThroughKeys) == 0 {
					return &BuildError{e.Line, fmt.Sprintf("relation %s.%s has invalid through metadata", e.Name, rn)}
				}
				for _, key := range r.Keys {
					if e.Column(key.Local) == nil || through.Column(key.Target) == nil {
						return &BuildError{e.Line, fmt.Sprintf("relation %s.%s has an invalid source through key", e.Name, rn)}
					}
				}
				target := m.Entities[r.Target]
				if len(r.ThroughKeys) != len(target.PK) {
					return &BuildError{e.Line, fmt.Sprintf("relation %s.%s has an invalid target through key count", e.Name, rn)}
				}
				for _, key := range r.ThroughKeys {
					if through.Column(key.Local) == nil || target.Column(key.Target) == nil {
						return &BuildError{e.Line, fmt.Sprintf("relation %s.%s has an invalid target through key", e.Name, rn)}
					}
				}
			}
		}
		for _, c := range e.Columns {
			if c.Ref != nil {
				t, ok := m.Entities[c.Ref.Entity]
				if !ok || t.cols[c.Ref.Column] == nil {
					return &BuildError{c.Line, fmt.Sprintf("%s.%s -> %s.%s: target does not exist", e.Name, c.Name, c.Ref.Entity, c.Ref.Column)}
				}
			}
		}
		if e.Timestamps != nil {
			for _, ts := range []string{e.Timestamps.Created, e.Timestamps.Updated} {
				if ts != "" && e.cols[ts] == nil {
					return &BuildError{e.Line, "timestamps column missing: " + e.Name + "." + ts}
				}
			}
		}
		seen := map[string]bool{}
		for _, u := range e.Unique {
			k := strings.Join(u, ",")
			if seen[k] {
				return &BuildError{e.Line, "duplicate unique " + e.Name + " (" + k + ")"}
			}
			seen[k] = true
		}
	}
	return nil
}

// Warnings are non-fatal findings (FK columns without a relationship line).
func (m *Manifest) Warnings() []string {
	var w []string
	for _, name := range m.Order {
		e := m.Entities[name]
		for _, c := range e.Columns {
			if c.FK && c.Ref == nil {
				w = append(w, fmt.Sprintf("%s.%s is FK but has no relationship line or '-> table.column'", e.Name, c.Name))
			}
		}
	}
	return w
}

// hash is a SHA-256 of the canonical JSON (sorted keys, no hash field).
func (m *Manifest) hash() string {
	saved := m.SchemaHash
	m.SchemaHash = ""
	b, _ := json.Marshal(m) // encoding/json sorts map keys
	m.SchemaHash = saved
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:8])
}

// MarshalIndent writes the manifest as schema.json.
func (m *Manifest) MarshalIndent() ([]byte, error) { return json.MarshalIndent(m, "", "  ") }

// Load reads a schema.json produced by Build.
func Load(b []byte) (*Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	for _, e := range m.Entities {
		e.cols = map[string]*Col{}
		for _, c := range e.Columns {
			e.cols[c.Name] = c
		}
	}
	if m.hash() != m.SchemaHash {
		return nil, fmt.Errorf("schema.json was edited by hand: hash %s does not match content %s", m.SchemaHash, m.hash())
	}
	sort.Strings(nil)
	return &m, nil
}

// backtickNames lists the `quoted` identifiers of an expr fragment.
func backtickNames(frag string) []string {
	var out []string
	for {
		i := strings.IndexByte(frag, '`')
		if i < 0 {
			return out
		}
		j := strings.IndexByte(frag[i+1:], '`')
		if j < 0 {
			return out
		}
		out = append(out, frag[i+1:i+1+j])
		frag = frag[i+j+2:]
	}
}
