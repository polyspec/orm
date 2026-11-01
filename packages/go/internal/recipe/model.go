package recipe

// The generated-model path (FCV-4 model ops, FCV-14). Each op calls the generated model that its model name names, through
// the connection that model.connect bound. A model or a column without an entry in this file fails the case by name, so no
// recipe passes on a call that the helper does not make.

import (
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strconv"

	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
)

// The keys that the generated models of the bench set read their encrypted columns with (the native model tests use the
// same keys).
const (
	benchAESKey        = "bench-salt"
	benchBlindIndexKey = "bench-blind-index"
)

// sortedColumns is the columns of an assignment object in name order, so that every row of a batch sets its columns in
// the same order (CONFIG otherwise) and a filter chain joins its conditions in one order.
func sortedColumns(values map[string]any) []string {
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// modelOp runs one model op of s. model.connect opens the connection and binds it with as; every other op uses the
// connection that its connection name names.
func modelOp(s databaseStep, c *databaseContext) (outcome, error) {
	if len(s.Row) > 0 && s.Connection == "" {
		return rowOp(s, c)
	}
	if s.Op == "model.connect" {
		db, err := orm.ConnectSchema(c.dsn, c.schema, orm.Config{PoolSize: s.PoolSize, AESKey: benchAESKey, BlindIndexKey: benchBlindIndexKey})
		if err != nil {
			return outcome{}, err
		}
		c.closers = append(c.closers, func() error { return db.Close() })
		return outcome{api: db, fields: map[string]any{}}, nil
	}
	bound, ok := c.bound[s.Connection]
	db, isDB := bound.api.(*orm.DB)
	if !ok || !isDB {
		return outcome{}, fmt.Errorf("model op %s: connection %q is not bound by model.connect", s.Op, s.Connection)
	}
	switch s.Model {
	case "CompositeAccount":
		return compositeAccountOp(s, c, db)
	case "Author":
		return authorOp(s, c, db)
	case "User":
		return userOp(s, c, db)
	case "NoteReader":
		return noteReaderOp(s, c, db)
	}
	if table, ok := tableModels[s.Model]; ok {
		return tableModelOp(s, c, db, table)
	}
	return outcome{}, fmt.Errorf("model %s has no recipe entry", s.Model)
}

// rowOp runs a model op of the {row} form, which names no model and no connection: the bound row records the path that
// made it and the connection, and the op runs on that path and connection. A row that no bound row holds fails by name.
func rowOp(s databaseStep, c *databaseContext) (outcome, error) {
	name := refName(s.Row)
	b, ok := c.bound[name]
	if !ok || b.row == nil {
		return outcome{}, fmt.Errorf("model op %s names row %q, which no bound row holds", s.Op, name)
	}
	if b.row.path != "table" {
		return outcome{}, fmt.Errorf("model op %s: row %q was bound by the %s path, which has no row form", s.Op, name, b.row.path)
	}
	table, ok := tableModels[b.row.model]
	if !ok {
		return outcome{}, fmt.Errorf("model %s has no table entry", b.row.model)
	}
	return tableModelOp(s, c, b.row.db, table)
}

// modelValues reads an object of assignments of a model op into native values.
func modelValues(raw []byte, c *databaseContext) (map[string]any, error) {
	out := map[string]any{}
	if len(raw) == 0 {
		return out, nil
	}
	var entries map[string]json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, err
	}
	for column, value := range entries {
		v, err := assignmentValue(value, c)
		if err != nil {
			return nil, fmt.Errorf("column %s: %w", column, err)
		}
		out[column] = v
	}
	return out, nil
}

// wrapperOf is the recipe wrapper of a native value that a model getter returns.
func wrapperOf(v any) any {
	switch x := v.(type) {
	case int64:
		return map[string]any{"int": strconv.FormatInt(x, 10)}
	case int32:
		return map[string]any{"int": strconv.FormatInt(int64(x), 10)}
	case string:
		return map[string]any{"text": x}
	}
	return map[string]any{"text": fmt.Sprint(v)}
}

// int64Of is a native int64 from a value of a recipe int wrapper.
func int64Of(v any, column string) (int64, error) {
	if n, ok := v.(int64); ok {
		return n, nil
	}
	return 0, fmt.Errorf("column %s: want an int wrapper, got %T", column, v)
}

// int32Of is a native int32 from a value of a recipe int wrapper.
func int32Of(v any, column string) (int32, error) {
	n, err := int64Of(v, column)
	if err != nil {
		return 0, err
	}
	return int32(n), nil
}

// stringOf is a native string from a value of a recipe text wrapper.
func stringOf(v any, column string) (string, error) {
	if s, ok := v.(string); ok {
		return s, nil
	}
	return "", fmt.Errorf("column %s: want a text wrapper, got %T", column, v)
}

// compositeAccount is a CompositeAccount model set from the values of a model op.
func compositeAccount(db *orm.DB, values map[string]any) (*model.CompositeAccountModel, error) {
	m := model.CompositeAccount().Connect(db)
	for _, column := range sortedColumns(values) {
		v := values[column]
		var err error
		switch column {
		case "tenant_id":
			var n int64
			n, err = int64Of(v, column)
			m.SetTenantId(n)
		case "account_id":
			var n int64
			n, err = int64Of(v, column)
			m.SetAccountId(n)
		case "name":
			var s string
			s, err = stringOf(v, column)
			m.SetName(s)
		default:
			return nil, fmt.Errorf("CompositeAccount column %s has no recipe setter", column)
		}
		if err != nil {
			return nil, err
		}
	}
	return m, nil
}

// compositeAccountFilter narrows a CompositeAccount chain by the equalities of a model op.
func compositeAccountFilter(m *model.CompositeAccountModel, where map[string]any) (*model.CompositeAccountModel, error) {
	for i, column := range sortedColumns(where) {
		v := where[column]
		if i > 0 {
			m = m.And()
		}
		switch column {
		case "tenant_id":
			n, err := int64Of(v, column)
			if err != nil {
				return nil, err
			}
			m = m.TenantId(n)
		case "account_id":
			n, err := int64Of(v, column)
			if err != nil {
				return nil, err
			}
			m = m.AccountId(n)
		default:
			// The generator makes an equality filter for the key columns only, so a text column has no filter here.
			return nil, fmt.Errorf("CompositeAccount column %s has no recipe filter", column)
		}
	}
	return m, nil
}

// compositeAccountOp runs a model op on the CompositeAccount model.
func compositeAccountOp(s databaseStep, c *databaseContext, db *orm.DB) (outcome, error) {
	switch s.Op {
	case "model.create", "model.save":
		values, err := modelValues(s.Values, c)
		if err != nil {
			return outcome{}, err
		}
		m, err := compositeAccount(db, values)
		if err != nil {
			return outcome{}, err
		}
		if s.Op == "model.save" {
			_, err = m.Save()
		} else {
			_, err = m.Create()
		}
		return outcome{api: m, fields: map[string]any{}}, err
	case "model.duplicate_create":
		values, err := modelValues(s.Values, c)
		if err != nil {
			return outcome{}, err
		}
		duplication, err := modelValues(s.Duplication, c)
		if err != nil {
			return outcome{}, err
		}
		m, err := compositeAccount(db, values)
		if err != nil {
			return outcome{}, err
		}
		d, err := compositeAccount(db, duplication)
		if err != nil {
			return outcome{}, err
		}
		_, err = m.Duplication(d).Create()
		return outcome{fields: map[string]any{}}, err
	case "model.creates":
		var raw []json.RawMessage
		if err := json.Unmarshal(s.Rows, &raw); err != nil {
			return outcome{}, err
		}
		rows := make([]*model.CompositeAccountModel, 0, len(raw))
		for _, row := range raw {
			values, err := modelValues(row, c)
			if err != nil {
				return outcome{}, err
			}
			m, err := compositeAccount(db, values)
			if err != nil {
				return outcome{}, err
			}
			rows = append(rows, m)
		}
		n, err := model.CompositeAccount().Connect(db).Creates(rows, s.Batch)
		return outcome{fields: map[string]any{"value": map[string]any{"int": strconv.FormatInt(n, 10)}}}, err
	case "model.update":
		key, err := modelValues(s.Key, c)
		if err != nil {
			return outcome{}, err
		}
		set, err := modelValues(s.Set, c)
		if err != nil {
			return outcome{}, err
		}
		rows, err := compositeAccountRows(db, key)
		if err != nil {
			return outcome{}, err
		}
		for column, v := range set {
			if column != "name" {
				return outcome{}, fmt.Errorf("CompositeAccount column %s has no recipe update", column)
			}
			name, err := stringOf(v, column)
			if err != nil {
				return outcome{}, err
			}
			rows[0].SetName(name)
		}
		_, err = rows[0].Update()
		return outcome{fields: map[string]any{}}, err
	case "model.delete":
		where, err := modelValues(s.Where, c)
		if err != nil {
			return outcome{}, err
		}
		m, err := compositeAccountFilter(model.CompositeAccount().Connect(db), where)
		if err != nil {
			return outcome{}, err
		}
		rows, err := m.Gets()
		if err != nil {
			return outcome{}, err
		}
		for _, row := range rows.Slice() {
			if err := row.Delete(); err != nil {
				return outcome{}, err
			}
		}
		return outcome{fields: map[string]any{}}, nil
	case "model.count":
		where, err := modelValues(s.Where, c)
		if err != nil {
			return outcome{}, err
		}
		m, err := compositeAccountFilter(model.CompositeAccount().Connect(db), where)
		if err != nil {
			return outcome{}, err
		}
		n, err := m.GetCount()
		return outcome{fields: map[string]any{"value": map[string]any{"int": strconv.FormatInt(n, 10)}}}, err
	case "model.get_by", "model.query":
		where := s.Key
		if s.Op == "model.query" {
			where = s.Where
		}
		filter, err := modelValues(where, c)
		if err != nil {
			return outcome{}, err
		}
		m, err := compositeAccountFilter(model.CompositeAccount().Connect(db), filter)
		if err != nil {
			return outcome{}, err
		}
		rows, err := m.Gets()
		if err != nil {
			return outcome{}, err
		}
		var out [][]any
		for _, row := range rows.Slice() {
			var cells []any
			for _, column := range s.Columns {
				var v any
				var err error
				switch column {
				case "name":
					v, err = row.GetName()
				default:
					return outcome{}, fmt.Errorf("CompositeAccount column %s has no recipe getter", column)
				}
				if err != nil {
					return outcome{}, err
				}
				cells = append(cells, wrapperOf(v))
			}
			out = append(out, cells)
		}
		return outcome{fields: map[string]any{"rows": out}}, nil
	}
	return outcome{}, fmt.Errorf("OP_UNKNOWN %s", s.Op)
}

// compositeAccountRows loads the CompositeAccount rows that the key names; an update needs the one row it names.
func compositeAccountRows(db *orm.DB, key map[string]any) ([]*model.CompositeAccountModel, error) {
	m, err := compositeAccountFilter(model.CompositeAccount().Connect(db), key)
	if err != nil {
		return nil, err
	}
	rows, err := m.Gets()
	if err != nil {
		return nil, err
	}
	if len(rows.Slice()) != 1 {
		return nil, fmt.Errorf("key names %d rows, want one", len(rows.Slice()))
	}
	return rows.Slice(), nil
}

// authorCondition narrows an Author chain by one equality.
type authorCondition func(*model.AuthorModel) *model.AuthorModel

// authorConditions is the table of the Author equality conditions that the recipes name, by column.
var authorConditions = map[string]func(v int64) authorCondition{
	"seq": func(v int64) authorCondition {
		return func(m *model.AuthorModel) *model.AuthorModel { return m.Seq(v) }
	},
	"user_seq": func(v int64) authorCondition {
		return func(m *model.AuthorModel) *model.AuthorModel { return m.UserSeq(v) }
	},
	"service_seq": func(v int64) authorCondition {
		return func(m *model.AuthorModel) *model.AuthorModel { return m.ServiceSeq(v) }
	},
	"service_region_seq": func(v int64) authorCondition {
		return func(m *model.AuthorModel) *model.AuthorModel { return m.ServiceRegionSeq(v) }
	},
	"service_member_seq": func(v int64) authorCondition {
		return func(m *model.AuthorModel) *model.AuthorModel { return m.ServiceMemberSeq(v) }
	},
}

// authorColumns is the table of the Author columns that a recipe may read, by column name.
var authorColumns = map[string]func(*model.AuthorModel) *model.AuthorModel{
	"seq":                (*model.AuthorModel).AddColumnSeq,
	"name":               (*model.AuthorModel).AddColumnName,
	"user_seq":           (*model.AuthorModel).AddColumnUserSeq,
	"service_seq":        (*model.AuthorModel).AddColumnServiceSeq,
	"service_region_seq": (*model.AuthorModel).AddColumnServiceRegionSeq,
	"service_member_seq": (*model.AuthorModel).AddColumnServiceMemberSeq,
	"read_count":         (*model.AuthorModel).AddColumnReadCount,
	"like_count":         (*model.AuthorModel).AddColumnLikeCount,
	"uuid":               (*model.AuthorModel).AddColumnUuid,
}

// authorOrders is the table of the Author orders that a recipe may name, by column name: a name is ascending, and a name
// with a leading "-" is descending (FCV-4 model.query).
var authorOrders = map[string]func(*model.AuthorModel) *model.AuthorModel{
	"seq":   func(m *model.AuthorModel) *model.AuthorModel { return m.OrderBySeqAsc() },
	"name":  func(m *model.AuthorModel) *model.AuthorModel { return m.OrderByNameAsc() },
	"-seq":  func(m *model.AuthorModel) *model.AuthorModel { return m.OrderBySeqDesc() },
	"-name": func(m *model.AuthorModel) *model.AuthorModel { return m.OrderByNameDesc() },
}

// authorChain applies the equalities of where, then the projection of columns (empty keeps the default columns).
func authorChain(db *orm.DB, where map[string]any, columns []string) (*model.AuthorModel, error) {
	m := model.Author().Connect(db)
	// The int equalities come first in name order; each bool equality is AndIsClose after them, because the generated chain
	// has no bool condition that opens it. The equalities are ANDed, so the order of the conditions does not change the rows.
	names := sortedColumns(where)
	ordered := make([]string, 0, len(names))
	for _, column := range names {
		if _, isBool := where[column].(bool); !isBool {
			ordered = append(ordered, column)
		}
	}
	for _, column := range names {
		if _, isBool := where[column].(bool); isBool {
			ordered = append(ordered, column)
		}
	}
	for i, column := range ordered {
		if b, isBool := where[column].(bool); isBool {
			if column != "is_close" || i == 0 {
				return nil, fmt.Errorf("Author column %s: a bool equality needs the is_close column after an int equality", column)
			}
			m = m.AndIsClose(b)
			continue
		}
		condition, ok := authorConditions[column]
		if !ok {
			return nil, fmt.Errorf("Author column %s has no recipe condition", column)
		}
		n, ok := where[column].(int64)
		if !ok {
			return nil, fmt.Errorf("Author column %s: want an int wrapper", column)
		}
		if i > 0 {
			m = m.And()
		}
		m = condition(n)(m)
	}
	if len(columns) > 0 {
		m = m.RemoveAllColumns()
		for _, column := range columns {
			add, ok := authorColumns[column]
			if !ok {
				return nil, fmt.Errorf("Author column %s has no recipe column", column)
			}
			m = add(m)
		}
	}
	return m, nil
}

// rowCells is the recipe wrappers of the named columns of one Author row, in the order of columns.
func rowCells(row *model.AuthorModel, columns []string) []any {
	values := row.ToArray()
	cells := make([]any, len(columns))
	for i, column := range columns {
		cells[i] = wrapperOf(values[column])
	}
	return cells
}

// authorOp runs a model op on the Author model: the seeded read counter that the arithmetic op changes, and its reads.
func authorOp(s databaseStep, c *databaseContext, db *orm.DB) (outcome, error) {
	filterOf := func(raw []byte) (*model.AuthorModel, error) {
		filter, err := modelValues(raw, c)
		if err != nil {
			return nil, err
		}
		m := model.Author().Connect(db)
		for i, column := range sortedColumns(filter) {
			v := filter[column]
			if i > 0 {
				m = m.And()
			}
			switch column {
			case "seq":
				n, err := int64Of(v, column)
				if err != nil {
					return nil, err
				}
				m = m.Seq(n)
			case "name":
				t, err := stringOf(v, column)
				if err != nil {
					return nil, err
				}
				m = m.Name(t)
			default:
				return nil, fmt.Errorf("Author column %s has no recipe filter", column)
			}
		}
		return m, nil
	}
	switch s.Op {
	case "model.count":
		where, err := modelValues(s.Where, c)
		if err != nil {
			return outcome{}, err
		}
		m, err := authorChain(db, where, nil)
		if err != nil {
			return outcome{}, err
		}
		n, err := m.GetCount()
		if err != nil {
			return outcome{}, err
		}
		return outcome{fields: map[string]any{"value": wrapperOf(n)}}, nil
	case "model.query":
		where, err := modelValues(s.Where, c)
		if err != nil {
			return outcome{}, err
		}
		m, err := authorChain(db, where, s.Columns)
		if err != nil {
			return outcome{}, err
		}
		for _, column := range s.Order {
			order, ok := authorOrders[column]
			if !ok {
				return outcome{}, fmt.Errorf("Author column %s has no recipe order", column)
			}
			m = order(m)
		}
		if s.Limit > 0 || s.Offset > 0 {
			m = m.Limit(int(s.Offset), s.Limit)
		}
		collection, err := m.Gets()
		if err != nil {
			return outcome{}, err
		}
		rows := []any{}
		for _, row := range collection.Slice() {
			rows = append(rows, rowCells(row, s.Columns))
		}
		return outcome{fields: map[string]any{"rows": rows}}, nil
	case "model.get_by":
		// The key and the where are one chain: the equalities, the projection of columns, then the terminal Get.
		raw := s.Key
		if len(s.Where) > 0 {
			raw = s.Where
		}
		where, err := modelValues(raw, c)
		if err != nil {
			return outcome{}, err
		}
		m, err := authorChain(db, where, s.Columns)
		if err != nil {
			return outcome{}, err
		}
		row, err := m.Get()
		if err != nil {
			return outcome{}, err
		}
		rows := []any{}
		if row != nil {
			rows = append(rows, rowCells(row, s.Columns))
		}
		return outcome{fields: map[string]any{"rows": rows}}, nil
	case "model.update":
		key, err := modelValues(s.Key, c)
		if err != nil {
			return outcome{}, err
		}
		set, err := modelValues(s.Set, c)
		if err != nil {
			return outcome{}, err
		}
		m, err := authorChain(db, key, nil)
		if err != nil {
			return outcome{}, err
		}
		row, err := m.Get()
		if err != nil {
			return outcome{}, err
		}
		if row == nil {
			return outcome{}, fmt.Errorf("Author update: the key names no row")
		}
		for _, column := range sortedColumns(set) {
			switch v := set[column].(type) {
			case int64:
				if column != "like_count" {
					return outcome{}, fmt.Errorf("Author column %s has no recipe update", column)
				}
				row.SetLikeCount(int32(v))
			case string:
				if column != "uuid" {
					return outcome{}, fmt.Errorf("Author column %s has no recipe update", column)
				}
				row.SetUuid(&v)
			default:
				return outcome{}, fmt.Errorf("Author column %s: unsupported update value", column)
			}
		}
		_, err = row.Update()
		return outcome{fields: map[string]any{}}, err
	case "model.arithmetic":
		m, err := filterOf(s.Key)
		if err != nil {
			return outcome{}, err
		}
		rows, err := m.Gets()
		if err != nil {
			return outcome{}, err
		}
		if len(rows.Slice()) != 1 {
			return outcome{}, fmt.Errorf("arithmetic key names %d rows, want one", len(rows.Slice()))
		}
		row := rows.Slice()[0]
		if s.Column != "read_count" {
			return outcome{}, fmt.Errorf("Author column %s has no recipe arithmetic", s.Column)
		}
		value, err := assignmentValue(s.Amount, c)
		if err != nil {
			return outcome{}, err
		}
		amount, err := int32Of(value, s.Column)
		if err != nil {
			return outcome{}, err
		}
		switch s.Operation {
		case "plus":
			row.PlusReadCount(amount)
		case "minus":
			row.MinusReadCount(amount)
		default:
			return outcome{}, fmt.Errorf("unknown arithmetic operation %q", s.Operation)
		}
		_, err = row.Update()
		return outcome{fields: map[string]any{}}, err
	}
	return outcome{}, fmt.Errorf("OP_UNKNOWN %s", s.Op)
}

// userOp runs one model op of s on the User model; only model.delete names it (the referenced-user case).
func userOp(s databaseStep, c *databaseContext, db *orm.DB) (outcome, error) {
	where, err := modelValues(s.Where, c)
	if err != nil {
		return outcome{}, err
	}
	if s.Op != "model.delete" {
		return outcome{}, fmt.Errorf("op %s has no User entry", s.Op)
	}
	m := model.User().Connect(db)
	for i, column := range sortedColumns(where) {
		n, ok := where[column].(int64)
		if column != "seq" || !ok {
			return outcome{}, fmt.Errorf("User column %s has no recipe condition", column)
		}
		if i > 0 {
			m = m.And()
		}
		m = m.Seq(n)
	}
	rows, err := m.Gets()
	if err != nil {
		return outcome{}, err
	}
	for _, row := range rows.Slice() {
		if err := row.Delete(); err != nil {
			return outcome{}, err
		}
	}
	return outcome{fields: map[string]any{}}, nil
}

// noteReaderOp runs model.query on the NoteReader model with its relation to the external SharedNote model.
func noteReaderOp(s databaseStep, c *databaseContext, db *orm.DB) (outcome, error) {
	if s.Op != "model.query" || s.Relation == nil {
		return outcome{}, fmt.Errorf("op %s has no NoteReader entry", s.Op)
	}
	var relation struct {
		Model   string     `json:"model"`
		Match   [][]string `json:"match"`
		Columns []string   `json:"columns"`
	}
	if err := json.Unmarshal(s.Relation, &relation); err != nil {
		return outcome{}, err
	}
	if relation.Model != "SharedNote" || !slices.Equal(relation.Match[0], []string{"shared_note_seq", "seq"}) || len(relation.Match) != 1 {
		return outcome{}, fmt.Errorf("NoteReader relation %v has no recipe entry", relation.Match)
	}
	if len(s.Columns) != 1 || s.Columns[0] != "seq" || len(relation.Columns) != 1 || relation.Columns[0] != "title" {
		return outcome{}, fmt.Errorf("NoteReader columns %v with relation %v have no recipe entry", s.Columns, relation.Columns)
	}
	m := model.NoteReader().Connect(db).Relation(model.SharedNote().MatchSharedNoteSeqWithSeq()).OrderBySeqAsc()
	collection, err := m.Gets()
	if err != nil {
		return outcome{}, err
	}
	rows := []any{}
	for _, row := range collection.Slice() {
		parent := row.ToArray()
		child, err := row.GetSharedNoteModel()
		if err != nil {
			return outcome{}, err
		}
		if child == nil {
			continue
		}
		rows = append(rows, []any{wrapperOf(parent["seq"]), wrapperOf(child.ToArray()["title"])})
	}
	return outcome{fields: map[string]any{"rows": rows}}, nil
}
