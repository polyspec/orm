package ormgen

import (
	"fmt"
	"slices"
	"strings"
	"unicode"

	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/schema"
)

// Method names of generated models are parsed with the grammar of docs/dsl.md.
// A name is split into PascalCase words; column names never contain the
// connector and operator segments, so the split is unambiguous.

// checkColumnNames applies the column naming rules to a manifest that may
// have been loaded without a build.
func checkColumnNames(m *schema.Manifest) error {
	for _, name := range m.Order {
		for _, c := range m.Entities[name].Columns {
			if err := schema.CheckColumnName(c.Name); err != nil {
				return fmt.Errorf("%s.%s: %v", name, c.Name, err)
			}
		}
	}
	return nil
}

// words splits a PascalCase name; digits stay with the preceding word.
func words(name string) []string {
	var out []string
	start := 0
	for i, r := range name {
		if i > 0 && unicode.IsUpper(r) {
			out = append(out, name[start:i])
			start = i
		}
	}
	if start < len(name) {
		out = append(out, name[start:])
	}
	return out
}

// chainKey is one parsed key of a chain name.
type chainKey struct {
	conn    string
	op      string // "", ne, gt, lt, ge, le, lk, lb, between, fulltext, fulltext_boolean, tuple, ne_tuple
	column  string
	columns []string
	compare string // right column of a column comparison
}

var leadingOps = map[string]string{"Ne": "ne", "Eq": "", "Gt": "gt", "Lt": "lt", "Ge": "ge", "Le": "le", "Lk": "lk", "Lb": "lb", "Between": "between"}

var compareOps = map[string]string{"Eq": "", "Ne": "ne", "Gt": "gt", "Lt": "lt", "Ge": "ge", "Le": "le"}

// engineOp maps a chain operator to the engine operator used for the type rule.
var engineOp = map[string]string{"": "eq", "ne": "not_eq", "gt": "gt", "lt": "lt", "ge": "gte", "le": "lte", "lk": "contains", "lb": "contains_binary", "between": "between"}

type columnIndex map[string]*schema.Col

func indexColumns(e *schema.Entity) columnIndex {
	out := columnIndex{}
	for _, c := range e.Columns {
		out[pascal(c.Name)] = c
	}
	return out
}

func (ix columnIndex) column(ws []string) (*schema.Col, bool) {
	c, ok := ix[strings.Join(ws, "")]
	return c, ok
}

// hasColumn reports whether any entity has the PascalCase column.
func hasColumn(m *schema.Manifest, pascalName string) bool {
	return columnName(m, nil, pascalName) != ""
}

// columnName returns the column of e (or of any entity when e is nil) whose
// PascalCase name is pascalName.
func columnName(m *schema.Manifest, e *schema.Entity, pascalName string) string {
	entities := []*schema.Entity{e}
	if e == nil {
		entities = nil
		for _, name := range m.Order {
			entities = append(entities, m.Entities[name])
		}
	}
	for _, ent := range entities {
		for _, c := range ent.Columns {
			if pascal(c.Name) == pascalName {
				return c.Name
			}
		}
	}
	return ""
}

// parseChain parses the chain part of a method name for entity e.
func parseChain(m *schema.Manifest, e *schema.Entity, name string) ([]chainKey, error) {
	ws := words(name)
	if len(ws) == 0 {
		return nil, fmt.Errorf("empty condition name")
	}
	ix := indexColumns(e)
	var keys []chainKey
	conn := ""
	start := 0
	flush := func(end int) error {
		k, err := parseKey(m, e, ix, ws[start:end])
		if err != nil {
			return err
		}
		k.conn = conn
		keys = append(keys, k)
		return nil
	}
	for i, w := range ws {
		if w == "And" || w == "Or" {
			if err := flush(i); err != nil {
				return nil, err
			}
			conn, start = strings.ToLower(w), i+1
		}
	}
	if err := flush(len(ws)); err != nil {
		return nil, err
	}
	return keys, nil
}

func parseKey(m *schema.Manifest, e *schema.Entity, ix columnIndex, ws []string) (chainKey, error) {
	if len(ws) == 0 {
		return chainKey{}, fmt.Errorf("a condition key is empty")
	}
	text := strings.Join(ws, "")
	var candidates []chainKey
	var errs []string
	try := func(k chainKey, err error) {
		if err != nil {
			errs = append(errs, err.Error())
			return
		}
		candidates = append(candidates, k)
	}
	if c, ok := ix.column(ws); ok {
		try(checkOp(e, c, "", chainKey{column: c.Name}))
	}
	if op, ok := leadingOps[ws[0]]; ok && len(ws) > 1 {
		if ws[0] == "Ne" && ws[1] == "Tuple" {
			try(tupleKey(e, ix, ws[2:], "ne_tuple"))
		} else if c, ok := ix.column(ws[1:]); ok {
			try(checkOp(e, c, op, chainKey{op: op, column: c.Name}))
		}
	}
	if ws[0] == "Tuple" {
		try(tupleKey(e, ix, ws[1:], "tuple"))
	}
	if ws[0] == "Fulltext" {
		try(fulltextKey(e, ix, ws[1:], "fulltext"))
		if len(ws) > 1 && ws[1] == "Boolean" {
			try(fulltextKey(e, ix, ws[2:], "fulltext_boolean"))
		}
	}
	for i := 1; i < len(ws)-1; i++ {
		op, ok := compareOps[ws[i]]
		if !ok {
			continue
		}
		left, ok := ix.column(ws[:i])
		if !ok {
			continue
		}
		right := strings.Join(ws[i+1:], "")
		if !hasColumn(m, right) {
			errs = append(errs, fmt.Sprintf("no model has the column %s", right))
			continue
		}
		try(checkOp(e, left, op, chainKey{op: op, column: left.Name, compare: columnName(m, nil, right)}))
	}
	switch len(candidates) {
	case 1:
		return candidates[0], nil
	case 0:
		if len(errs) > 0 {
			return chainKey{}, fmt.Errorf("%s: %s", text, strings.Join(errs, "; "))
		}
		return chainKey{}, fmt.Errorf("%s is not a column of %s", text, e.Name)
	}
	return chainKey{}, fmt.Errorf("%s has more than one meaning", text)
}

func checkOp(e *schema.Entity, c *schema.Col, op string, k chainKey) (chainKey, error) {
	if k.compare != "" {
		if !ir.OpAllowed(c, engineOp[op]+"_col") || len(appStyles(c)) > 0 {
			return k, fmt.Errorf("%s.%s cannot be compared with a column", e.Name, c.Name)
		}
		return k, nil
	}
	allowed := ir.OpAllowed(c, engineOp[op])
	if op == "" || op == "ne" {
		allowed = allowed || ir.OpAllowed(c, "is_null")
	}
	if (op == "gt" || op == "lt" || op == "ge" || op == "le" || op == "") && functionColumn(c) {
		allowed = true
	}
	if !allowed {
		return k, fmt.Errorf("%s.%s does not accept the %s operator", e.Name, c.Name, opName(op))
	}
	return k, nil
}

func opName(op string) string {
	if op == "" {
		return "equality"
	}
	return op
}

// functionColumn reports columns that accept ORM column functions.
func functionColumn(c *schema.Col) bool {
	return len(appStyles(c)) == 0 && (c.Type == "date" || c.Type == "datetime" || c.Type == "point")
}

func splitWith(ix columnIndex, ws []string) ([]*schema.Col, bool) {
	var out []*schema.Col
	start := 0
	for i := 0; i <= len(ws); i++ {
		if i < len(ws) && ws[i] != "With" {
			continue
		}
		c, ok := ix.column(ws[start:i])
		if !ok {
			return nil, false
		}
		out = append(out, c)
		start = i + 1
	}
	return out, true
}

func tupleKey(e *schema.Entity, ix columnIndex, ws []string, op string) (chainKey, error) {
	cols, ok := splitWith(ix, ws)
	if !ok || len(cols) < 2 {
		return chainKey{}, fmt.Errorf("a tuple needs two or more columns of %s joined by With", e.Name)
	}
	k := chainKey{op: op}
	for _, c := range cols {
		if len(appStyles(c)) > 0 || !ir.OpAllowed(c, "in") {
			return k, fmt.Errorf("%s.%s cannot be used in a tuple", e.Name, c.Name)
		}
		k.columns = append(k.columns, c.Name)
	}
	return k, nil
}

func fulltextKey(e *schema.Entity, ix columnIndex, ws []string, op string) (chainKey, error) {
	cols, ok := splitWith(ix, ws)
	if !ok || len(cols) == 0 {
		return chainKey{}, fmt.Errorf("full-text columns of %s are not valid", e.Name)
	}
	k := chainKey{op: op}
	for _, c := range cols {
		k.columns = append(k.columns, c.Name)
	}
	for _, index := range e.Fulltext {
		if slices.Equal(index, k.columns) {
			return k, nil
		}
	}
	return k, fmt.Errorf("%s has no full-text index on %s", e.Name, strings.Join(k.columns, ", "))
}

// orderKey is one key of an orderBy chain.
type orderKey struct {
	column string
	desc   bool
}

func parseOrder(e *schema.Entity, name string) ([]orderKey, error) {
	ix := indexColumns(e)
	ws := words(name)
	var out []orderKey
	start := 0
	for i := 0; i <= len(ws); i++ {
		if i < len(ws) && ws[i] != "And" {
			continue
		}
		part := ws[start:i]
		start = i + 1
		if len(part) < 2 {
			return nil, fmt.Errorf("orderBy%s: each key needs a column and Asc or Desc", name)
		}
		dir := part[len(part)-1]
		if dir != "Asc" && dir != "Desc" {
			return nil, fmt.Errorf("orderBy%s: each key ends with Asc or Desc", name)
		}
		c, ok := ix.column(part[:len(part)-1])
		if !ok {
			return nil, fmt.Errorf("orderBy%s: %s is not a column of %s", name, strings.Join(part[:len(part)-1], ""), e.Name)
		}
		out = append(out, orderKey{column: c.Name, desc: dir == "Desc"})
	}
	return out, nil
}

// splitPair parses <L>With<R> where L is a column of left and R of right; a
// nil entity accepts a column of any entity.
func splitPair(m *schema.Manifest, left, right *schema.Entity, name string) (string, string, error) {
	ws := words(name)
	var found [][2]string
	for i, w := range ws {
		if w != "With" {
			continue
		}
		l, r := strings.Join(ws[:i], ""), strings.Join(ws[i+1:], "")
		if l == "" || r == "" {
			continue
		}
		if !columnOf(m, left, l) || !columnOf(m, right, r) {
			continue
		}
		found = append(found, [2]string{columnName(m, left, l), columnName(m, right, r)})
	}
	switch len(found) {
	case 1:
		return found[0][0], found[0][1], nil
	case 0:
		return "", "", fmt.Errorf("%s is not <column>With<column>", name)
	}
	return "", "", fmt.Errorf("%s has more than one meaning", name)
}

func columnOf(m *schema.Manifest, e *schema.Entity, pascalName string) bool {
	return columnName(m, e, pascalName) != ""
}
