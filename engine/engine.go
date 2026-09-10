// Package engine is the query compiler: JSON IR in, Plan out. It is pure and
// stateless; execution lives in the language-native executors.
//
// S0 scope: enough of the real pipeline (JSON decode, schema validation,
// WHERE tree rendering, dialect quoting, JSON encode) to make boundary
// measurements carry realistic payloads. The schema is a fixed in-memory
// table until the YAML loader lands in S1.
package engine

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

const IRVersion = 1

// IR is the wire form a client sends. Field names are proto-JSON compatible.
type IR struct {
	IRVersion  int      `json:"ir_version"`
	SchemaHash string   `json:"schema_hash"`
	Entity     string   `json:"entity"`
	Alias      string   `json:"alias,omitempty"`
	Columns    []string `json:"columns,omitempty"`
	Where      *Group   `json:"where,omitempty"`
	Order      []Order  `json:"order,omitempty"`
	Limit      *Limit   `json:"limit,omitempty"`
}

// Group is a parenthesised predicate list. Conn is the connector that joins
// this group to its predecessor inside the parent group ("and" | "or").
type Group struct {
	Conn  string `json:"conn,omitempty"`
	Items []Item `json:"items"`
}

// Item is either a Pred or a nested Group (exactly one is set).
type Item struct {
	Pred  *Pred  `json:"pred,omitempty"`
	Group *Group `json:"group,omitempty"`
}

type Pred struct {
	Conn   string          `json:"conn,omitempty"`
	Column string          `json:"column"`
	Op     string          `json:"op"`
	Value  json.RawMessage `json:"value,omitempty"`
}

type Order struct {
	Column string `json:"column"`
	Dir    string `json:"dir,omitempty"`
}

type Limit struct {
	Offset int `json:"offset"`
	Count  int `json:"count"`
}

// Plan is what executors run. bind_slots tell the executor where each
// placeholder's value comes from (PARAM index into the IR's flattened values).
type Plan struct {
	SchemaHash string   `json:"schema_hash"`
	Steps      []Step   `json:"steps"`
	Assemble   Assemble `json:"assemble"`
}

type Step struct {
	ID        int        `json:"id"`
	Kind      string     `json:"kind"`
	SQL       string     `json:"sql"`
	BindSlots []BindSlot `json:"bind_slots"`
}

type BindSlot struct {
	From  string          `json:"from"` // "param"
	Value json.RawMessage `json:"value,omitempty"`
}

type Assemble struct {
	Entity  string     `json:"entity"`
	Columns []ColumnAt `json:"columns"`
}

type ColumnAt struct {
	Column string `json:"column"`
	Index  int    `json:"index"`
}

// Error carries the error code that clients map to their generated enums.
type Error struct {
	Code string `json:"code"`
	Msg  string `json:"msg"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Msg }

var opSQL = map[string]string{
	"eq": "=", "ne": "!=", "gt": ">", "ge": ">=", "lt": "<", "le": "<=",
	"in": "IN", "nin": "NOT IN", "lk": "LIKE", "lb": "LIKE BINARY",
	"between": "BETWEEN", "isNull": "IS NULL", "notNull": "IS NOT NULL",
}

// Compile turns IR JSON into Plan JSON. It never touches a database.
func Compile(irJSON []byte) ([]byte, error) {
	var ir IR
	if err := json.Unmarshal(irJSON, &ir); err != nil {
		return nil, &Error{"IR_INVALID", err.Error()}
	}
	if ir.IRVersion != IRVersion {
		return nil, &Error{"VERSION_MISMATCH", fmt.Sprintf("ir_version %d, engine %d", ir.IRVersion, IRVersion)}
	}
	if ir.SchemaHash != Schema.Hash {
		return nil, &Error{"SCHEMA_HASH_MISMATCH", ir.SchemaHash}
	}
	ent, ok := Schema.Entities[ir.Entity]
	if !ok {
		return nil, &Error{"ENTITY_UNKNOWN", ir.Entity}
	}
	alias := ir.Alias
	if alias == "" {
		alias = "a"
	}

	cols := ir.Columns
	if len(cols) == 0 {
		cols = ent.DefaultColumns
	}
	var sb strings.Builder
	sb.Grow(512)
	sb.WriteString("SELECT ")
	assemble := Assemble{Entity: ir.Entity, Columns: make([]ColumnAt, 0, len(cols))}
	for i, c := range cols {
		if _, ok := ent.Columns[c]; !ok {
			return nil, &Error{"COLUMN_UNKNOWN", ir.Entity + "." + c}
		}
		if i > 0 {
			sb.WriteString(", ")
		}
		quoteQualified(&sb, alias, c)
		assemble.Columns = append(assemble.Columns, ColumnAt{Column: c, Index: i})
	}
	sb.WriteString(" FROM ")
	quote(&sb, ent.Table)
	sb.WriteString(" AS ")
	quote(&sb, alias)

	var binds []BindSlot
	if ir.Where != nil && len(ir.Where.Items) > 0 {
		sb.WriteString(" WHERE ")
		if err := renderGroup(&sb, &binds, ent, alias, ir.Where, true); err != nil {
			return nil, err
		}
	}
	if len(ir.Order) > 0 {
		sb.WriteString(" ORDER BY ")
		for i, o := range ir.Order {
			if _, ok := ent.Columns[o.Column]; !ok {
				return nil, &Error{"COLUMN_UNKNOWN", ir.Entity + "." + o.Column}
			}
			if i > 0 {
				sb.WriteString(", ")
			}
			quoteQualified(&sb, alias, o.Column)
			if strings.EqualFold(o.Dir, "desc") {
				sb.WriteString(" DESC")
			} else {
				sb.WriteString(" ASC")
			}
		}
	}
	if ir.Limit != nil {
		sb.WriteString(" LIMIT ")
		sb.WriteString(strconv.Itoa(ir.Limit.Offset))
		sb.WriteString(", ")
		sb.WriteString(strconv.Itoa(ir.Limit.Count))
	}

	plan := Plan{
		SchemaHash: Schema.Hash,
		Steps:      []Step{{ID: 0, Kind: "query", SQL: sb.String(), BindSlots: binds}},
		Assemble:   assemble,
	}
	out, err := json.Marshal(plan)
	if err != nil {
		return nil, &Error{"INTERNAL", err.Error()}
	}
	return out, nil
}

// renderGroup writes "(a AND b OR (c))". The first item's connector is ignored;
// a leading "or" is a compile error because it silently changes meaning.
func renderGroup(sb *strings.Builder, binds *[]BindSlot, ent *Entity, alias string, g *Group, top bool) error {
	if !top {
		sb.WriteByte('(')
	}
	for i, it := range g.Items {
		conn := ""
		switch {
		case it.Pred != nil:
			conn = it.Pred.Conn
		case it.Group != nil:
			conn = it.Group.Conn
		default:
			return &Error{"IR_INVALID", "empty where item"}
		}
		if i == 0 {
			if strings.EqualFold(conn, "or") {
				return &Error{"OR_AT_GROUP_START", "a group may not start with OR"}
			}
		} else {
			if strings.EqualFold(conn, "or") {
				sb.WriteString(" OR ")
			} else {
				sb.WriteString(" AND ")
			}
		}
		if it.Group != nil {
			if err := renderGroup(sb, binds, ent, alias, it.Group, false); err != nil {
				return err
			}
			continue
		}
		p := it.Pred
		if _, ok := ent.Columns[p.Column]; !ok {
			return &Error{"COLUMN_UNKNOWN", ent.Name + "." + p.Column}
		}
		sqlOp, ok := opSQL[p.Op]
		if !ok {
			return &Error{"OPERATOR_UNKNOWN", p.Op}
		}
		quoteQualified(sb, alias, p.Column)
		sb.WriteByte(' ')
		sb.WriteString(sqlOp)
		switch p.Op {
		case "isNull", "notNull":
		case "in", "nin":
			var list []json.RawMessage
			if err := json.Unmarshal(p.Value, &list); err != nil || len(list) == 0 {
				return &Error{"EMPTY_IN", p.Column}
			}
			sb.WriteString(" (")
			for j, v := range list {
				if j > 0 {
					sb.WriteString(", ")
				}
				sb.WriteByte('?')
				*binds = append(*binds, BindSlot{From: "param", Value: v})
			}
			sb.WriteByte(')')
		case "between":
			var pair []json.RawMessage
			if err := json.Unmarshal(p.Value, &pair); err != nil || len(pair) != 2 {
				return &Error{"IR_INVALID", "between needs [lo, hi]"}
			}
			sb.WriteString(" ? AND ?")
			*binds = append(*binds, BindSlot{From: "param", Value: pair[0]}, BindSlot{From: "param", Value: pair[1]})
		default:
			if len(p.Value) == 0 || string(p.Value) == "null" {
				return &Error{"IR_INVALID", "null value for " + p.Op + " " + p.Column}
			}
			sb.WriteString(" ?")
			*binds = append(*binds, BindSlot{From: "param", Value: p.Value})
		}
	}
	if !top {
		sb.WriteByte(')')
	}
	return nil
}

func quote(sb *strings.Builder, ident string) {
	sb.WriteByte('`')
	sb.WriteString(strings.ReplaceAll(ident, "`", "``"))
	sb.WriteByte('`')
}

func quoteQualified(sb *strings.Builder, alias, col string) {
	quote(sb, alias)
	sb.WriteByte('.')
	quote(sb, col)
}

// ErrorJSON renders an error as the wire envelope {"error":{code,msg}}.
func ErrorJSON(err error) []byte {
	var e *Error
	if !errors.As(err, &e) {
		e = &Error{"INTERNAL", err.Error()}
	}
	b, _ := json.Marshal(struct {
		Error *Error `json:"error"`
	}{e})
	return b
}
