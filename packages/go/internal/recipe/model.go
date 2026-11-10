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

	"github.com/polyspec/orm/packages/go/engine"
	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/engine/plan"
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
	if s.k("op").Op == "model.connect" {
		cfg, err := connectConfig(s, c)
		if err != nil {
			return outcome{}, err
		}
		var named string
		if s.k("dsn").DSN != nil {
			if err := json.Unmarshal(s.k("dsn").DSN, &named); err != nil {
				return outcome{}, fmt.Errorf("model.connect dsn is not text: %w", err)
			}
		}
		dsn, err := connectDSN(named, c.database, c.dsn)
		if err != nil {
			return outcome{}, err
		}
		db, err := orm.ConnectSchema(dsn, c.schema, cfg)
		if err != nil {
			return outcome{}, err
		}
		c.closers = append(c.closers, func() error { return db.Close() })
		return outcome{api: db, fields: map[string]any{}}, nil
	}
	if s.k("unconnected").Unconnected {
		return unconnectedAccountOp(s, c)
	}
	bound, ok := c.bound[s.k("connection").Connection]
	db, isDB := bound.api.(*orm.DB)
	if !ok || !isDB {
		return outcome{}, fmt.Errorf("model op %s: connection %q is not bound by model.connect", s.k("op").Op, s.k("connection").Connection)
	}
	switch s.k("model").Model {
	case "CompositeAccount":
		return compositeAccountOp(s, c, db)
	case "CompositeMembership":
		return compositeMembershipOp(s, c, db)
	case "Author":
		return authorOp(s, c, db)
	case "User":
		return userOp(s, c, db)
	case "NoteReader":
		return noteReaderOp(s, c, db)
	case "RankedTask":
		return rankedTaskOp(s, c, db)
	}
	return outcome{}, fmt.Errorf("model %s has no recipe entry", s.k("model").Model)
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

// columnSetter sets one column of a model from the recipe value v of column.
type columnSetter func(v any, column string) error

// int64Setter is the columnSetter of a model setter of an integer column.
func int64Setter[R any](set func(int64) R) columnSetter {
	return func(v any, column string) error {
		n, err := int64Of(v, column)
		if err == nil {
			set(n)
		}
		return err
	}
}

// int32Setter is the columnSetter of a model setter of an i32 column.
func int32Setter[R any](set func(int32) R) columnSetter {
	return func(v any, column string) error {
		n, err := int32Of(v, column)
		if err == nil {
			set(n)
		}
		return err
	}
}

// stringSetter is the columnSetter of a model setter of a text column.
func stringSetter[R any](set func(string) R) columnSetter {
	return func(v any, column string) error {
		text, err := stringOf(v, column)
		if err == nil {
			set(text)
		}
		return err
	}
}

// setColumns sets each column of values, in column order, with its setter; a column with no setter is refused.
func setColumns(name string, values map[string]any, setters map[string]columnSetter) error {
	for _, column := range sortedColumns(values) {
		set, ok := setters[column]
		if !ok {
			return fmt.Errorf("%s column %s has no recipe setter", name, column)
		}
		if err := set(values[column], column); err != nil {
			return err
		}
	}
	return nil
}

// keyAndSet reads the key and the set of a model.update step.
func keyAndSet(s databaseStep, c *databaseContext) (map[string]any, map[string]any, error) {
	key, err := modelValues(s.k("key").Key, c)
	if err != nil {
		return nil, nil, err
	}
	set, err := modelValues(s.k("set").Set, c)
	return key, set, err
}

// deleteRows deletes each row of rows.
func deleteRows[R interface{ Delete(...bool) error }](rows []R) (outcome, error) {
	for _, row := range rows {
		if err := row.Delete(); err != nil {
			return outcome{}, err
		}
	}
	return outcome{fields: map[string]any{}}, nil
}

// compositeAccount is a CompositeAccount model set from the values of a model op.
func compositeAccount(db *orm.DB, values map[string]any) (*model.CompositeAccountModel, error) {
	return setCompositeAccount(model.CompositeAccount().Connect(db), values)
}

// unconnectedAccountOp runs model.create and model.count of a CompositeAccount built with no connection (PLN-16).
func unconnectedAccountOp(s databaseStep, c *databaseContext) (outcome, error) {
	if s.k("model").Model != "CompositeAccount" {
		return outcome{}, fmt.Errorf("model op %s: %s has no unconnected recipe op", s.k("op").Op, s.k("model").Model)
	}
	switch s.k("op").Op {
	case "model.create":
		values, err := modelValues(s.k("values").Values, c)
		if err != nil {
			return outcome{}, err
		}
		m, err := setCompositeAccount(model.CompositeAccount(), values)
		if err != nil {
			return outcome{}, err
		}
		_, err = m.Create()
		return outcome{fields: map[string]any{}}, err
	case "model.count":
		m, err := compositeAccountWhere(s, c, model.CompositeAccount())
		if err != nil {
			return outcome{}, err
		}
		return modelCount(m)
	}
	return outcome{}, fmt.Errorf("model op %s has no unconnected form", s.k("op").Op)
}

// setCompositeAccount sets the columns of values on m.
func setCompositeAccount(m *model.CompositeAccountModel, values map[string]any) (*model.CompositeAccountModel, error) {
	err := setColumns("CompositeAccount", values, map[string]columnSetter{
		"tenant_id":  int64Setter(m.SetTenantId),
		"account_id": int64Setter(m.SetAccountId),
		"name":       stringSetter(m.SetName),
	})
	if err != nil {
		return nil, err
	}
	return m, nil
}

// modelCount is the outcome of a model.count step on the chain m.
func modelCount(m interface{ GetCount() (int64, error) }) (outcome, error) {
	n, err := m.GetCount()
	if err != nil {
		return outcome{}, err
	}
	return outcome{fields: map[string]any{"value": wrapperOf(n)}}, nil
}

// compositeAccountWhere is the CompositeAccount chain m narrowed by the where of s.
func compositeAccountWhere(s databaseStep, c *databaseContext, m *model.CompositeAccountModel) (*model.CompositeAccountModel, error) {
	where, err := modelValues(s.k("where").Where, c)
	if err != nil {
		return nil, err
	}
	return compositeAccountFilter(m, where)
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
	switch s.k("op").Op {
	case "model.create", "model.save":
		values, err := modelValues(s.k("values").Values, c)
		if err != nil {
			return outcome{}, err
		}
		m, err := compositeAccount(db, values)
		if err != nil {
			return outcome{}, err
		}
		if s.k("op").Op == "model.save" {
			_, err = m.Save()
		} else {
			_, err = m.Create()
		}
		return outcome{api: m, fields: map[string]any{}}, err
	case "model.duplicate_create":
		values, err := modelValues(s.k("values").Values, c)
		if err != nil {
			return outcome{}, err
		}
		duplication, err := modelValues(s.k("duplication").Duplication, c)
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
		if err := json.Unmarshal(s.k("rows").Rows, &raw); err != nil {
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
		n, err := model.CompositeAccount().Connect(db).Creates(rows, s.k("batch").Batch)
		return outcome{fields: map[string]any{"value": map[string]any{"int": strconv.FormatInt(n, 10)}}}, err
	case "model.update":
		key, set, err := keyAndSet(s, c)
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
		return outcome{fields: affectedFields(db)}, err
	case "model.delete":
		m, err := compositeAccountWhere(s, c, model.CompositeAccount().Connect(db))
		if err != nil {
			return outcome{}, err
		}
		rows, err := m.Gets()
		if err != nil {
			return outcome{}, err
		}
		out, err := deleteRows(rows.Slice())
		if err == nil {
			out.fields = affectedFields(db)
		}
		return out, err
	case "model.count":
		m, err := compositeAccountWhere(s, c, model.CompositeAccount().Connect(db))
		if err != nil {
			return outcome{}, err
		}
		return modelCount(m)
	case "model.get_by", "model.query":
		where := s.k("key").Key
		if s.k("op").Op == "model.query" {
			where = s.k("where").Where
		}
		filter, err := modelValues(where, c)
		if err != nil {
			return outcome{}, err
		}
		m, err := compositeAccountFilter(model.CompositeAccount().Connect(db), filter)
		if err != nil {
			return outcome{}, err
		}
		if s.k("tuples").Tuples != nil {
			if m, err = compositeAccountTuples(m, s.k("tuples").Tuples, len(filter) > 0, c); err != nil {
				return outcome{}, err
			}
		}
		for _, column := range s.k("order").Order {
			switch column {
			case "tenant_id":
				m = m.OrderByTenantIdAsc()
			case "account_id":
				m = m.OrderByAccountIdAsc()
			default:
				return outcome{}, fmt.Errorf("CompositeAccount column %s has no recipe order", column)
			}
		}
		var relation *compositeRelation
		if s.k("relation").Relation != nil {
			if relation, err = compositeMembershipRelation(s.k("relation").Relation, db); err != nil {
				return outcome{}, err
			}
			// The alias is on the call itself: the generator scan attaches a getter from the call it can read.
			switch {
			case relation.many && relation.alias == "memberships":
				m = m.Relations(relation.child.AliasMemberships())
			case relation.many:
				m = m.Relations(relation.child)
			case relation.alias == "memberships":
				return outcome{}, fmt.Errorf("the alias memberships has no recipe entry on a one-row relation")
			default:
				m = m.Relation(relation.child)
			}
		}
		// The lock of a model.query (INT-47): a lock outside a transaction is refused with CONFIG.
		switch s.k("lock").Lock {
		case "":
		case "update":
			m = m.ForUpdate()
		case "share":
			m = m.ForShare()
		case "update_nowait":
			m = m.ForUpdateNoWait()
		case "share_nowait":
			m = m.ForShareNoWait()
		default:
			return outcome{}, fmt.Errorf("lock %q is not a lock of the recipe", s.k("lock").Lock)
		}
		rows, err := m.Gets()
		if err != nil {
			return outcome{}, err
		}
		out := [][]any{}
		columns := s.k("columns").Columns
		for _, row := range rows.Slice() {
			var cells []any
			for _, column := range columns {
				var v any
				var err error
				switch column {
				case "account_id":
					v, err = row.GetAccountId()
				case "name":
					v, err = row.GetName()
				case "tenant_id":
					v, err = row.GetTenantId()
				default:
					return outcome{}, fmt.Errorf("CompositeAccount column %s has no recipe getter", column)
				}
				if err != nil {
					return outcome{}, err
				}
				cells = append(cells, wrapperOf(v))
			}
			if relation == nil {
				out = append(out, cells)
				continue
			}
			children, err := relation.children(row)
			if err != nil {
				return outcome{}, err
			}
			for _, child := range children {
				more, err := compositeMembershipCells(child, relation.columns)
				if err != nil {
					return outcome{}, err
				}
				out = append(out, append(slices.Clone(cells), more...))
			}
		}
		return outcome{fields: map[string]any{"rows": out}}, nil
	}
	return outcome{}, fmt.Errorf("OP_UNKNOWN %s", s.k("op").Op)
}

// compositeAccountTuples narrows a CompositeAccount chain by the tuples of a model.query through the generated tuple filter
// of its composite key (DSL-82), joined by and to the equalities that come before it.
func compositeAccountTuples(m *model.CompositeAccountModel, raw json.RawMessage, after bool, c *databaseContext) (*model.CompositeAccountModel, error) {
	var tuples struct {
		Columns []string            `json:"columns"`
		Values  [][]json.RawMessage `json:"values"`
	}
	if err := json.Unmarshal(raw, &tuples); err != nil {
		return nil, err
	}
	if !slices.Equal(tuples.Columns, []string{"tenant_id", "account_id"}) {
		return nil, fmt.Errorf("CompositeAccount tuple %v has no recipe filter", tuples.Columns)
	}
	groups := make([]model.CompositeAccountTenantIdWithAccountId, 0, len(tuples.Values))
	for _, tuple := range tuples.Values {
		if len(tuple) != 2 {
			return nil, fmt.Errorf("a CompositeAccount tuple has %d values, not 2", len(tuple))
		}
		tenant, err := wrappedInt64(tuple[0], c)
		if err != nil {
			return nil, err
		}
		account, err := wrappedInt64(tuple[1], c)
		if err != nil {
			return nil, err
		}
		groups = append(groups, model.CompositeAccountTenantIdWithAccountId{TenantId: tenant, AccountId: account})
	}
	if after {
		m = m.And()
	}
	return m.TupleTenantIdWithAccountId(groups), nil
}

// wrappedInt64 reads one integer value wrapper of a recipe.
func wrappedInt64(raw json.RawMessage, c *databaseContext) (int64, error) {
	values, err := modelValues([]byte(`{"v":`+string(raw)+`}`), c)
	if err != nil {
		return 0, err
	}
	return int64Of(values["v"], "tuple")
}

// compositeRelation is the CompositeMembership relation of a CompositeAccount query and the child columns it reads.
type compositeRelation struct {
	child   *model.CompositeMembershipModel
	columns []string
	many    bool
	alias   string
}

// children reads the CompositeMembership rows of one parent row: through the generated getter of the alias, or by the
// result name of a relation without one (<table>_model, <table>_models). A parent without a child gives none.
func (r *compositeRelation) children(row *model.CompositeAccountModel) ([]*model.CompositeMembershipModel, error) {
	switch {
	case r.alias == "memberships":
		collection, err := row.GetMemberships()
		if err != nil {
			return nil, err
		}
		return collection.Slice(), nil
	case r.many:
		collection, ok := row.Orm_().Related("composite_membership_models").(*orm.Collection[*model.CompositeMembershipModel])
		if !ok {
			return nil, nil
		}
		return collection.Slice(), nil
	}
	child, ok := row.Orm_().Related("composite_membership_model").(*model.CompositeMembershipModel)
	if !ok {
		return nil, nil
	}
	return []*model.CompositeMembershipModel{child}, nil
}

// compositeMembershipRelation reads the relation of a model.query on CompositeAccount: CompositeMembership matched by its
// composite key, one match call per pair in the written order, connected to the connection of the query when connect is
// true (INT-87).
func compositeMembershipRelation(raw json.RawMessage, db *orm.DB) (*compositeRelation, error) {
	var relation struct {
		Model   string     `json:"model"`
		Match   [][]string `json:"match"`
		Connect bool       `json:"connect"`
		Many    bool       `json:"many"`
		Alias   string     `json:"alias"`
		Columns []string   `json:"columns"`
	}
	if err := json.Unmarshal(raw, &relation); err != nil {
		return nil, err
	}
	if relation.Model != "CompositeMembership" {
		return nil, fmt.Errorf("CompositeAccount relation %s has no recipe entry", relation.Model)
	}
	child := model.CompositeMembership()
	for _, pair := range relation.Match {
		switch {
		case slices.Equal(pair, []string{"tenant_id", "tenant_id"}):
			child = child.MatchTenantIdWithTenantId()
		case slices.Equal(pair, []string{"account_id", "account_id"}):
			child = child.MatchAccountIdWithAccountId()
		default:
			return nil, fmt.Errorf("CompositeMembership match %v has no recipe entry", pair)
		}
	}
	switch relation.Alias {
	case "", "memberships":
	default:
		return nil, fmt.Errorf("CompositeMembership alias %s has no recipe entry", relation.Alias)
	}
	if relation.Connect {
		child = child.Connect(db)
	}
	return &compositeRelation{child: child, columns: relation.Columns, many: relation.Many, alias: relation.Alias}, nil
}

// compositeMembershipCells reads the columns of one CompositeMembership row as value wrappers.
func compositeMembershipCells(row *model.CompositeMembershipModel, columns []string) ([]any, error) {
	cells := make([]any, 0, len(columns))
	for _, column := range columns {
		var v any
		var err error
		switch column {
		case "tenant_id":
			v, err = row.GetTenantId()
		case "account_id":
			v, err = row.GetAccountId()
		case "role":
			v, err = row.GetRole()
		default:
			return nil, fmt.Errorf("CompositeMembership column %s has no recipe getter", column)
		}
		if err != nil {
			return nil, err
		}
		cells = append(cells, wrapperOf(v))
	}
	return cells, nil
}

// compositeMembership is a CompositeMembership model set from the values of a model op.
func compositeMembership(db *orm.DB, values map[string]any) (*model.CompositeMembershipModel, error) {
	m := model.CompositeMembership().Connect(db)
	err := setColumns("CompositeMembership", values, map[string]columnSetter{
		"tenant_id":  int64Setter(m.SetTenantId),
		"account_id": int64Setter(m.SetAccountId),
		"role":       stringSetter(m.SetRole),
	})
	if err != nil {
		return nil, err
	}
	return m, nil
}

// compositeMembershipOp runs the model ops of the composite keys recipe on the CompositeMembership model: model.creates
// and model.count by tenant_id.
func compositeMembershipOp(s databaseStep, c *databaseContext, db *orm.DB) (outcome, error) {
	switch s.k("op").Op {
	case "model.creates":
		var raw []json.RawMessage
		if err := json.Unmarshal(s.k("rows").Rows, &raw); err != nil {
			return outcome{}, err
		}
		rows := make([]*model.CompositeMembershipModel, 0, len(raw))
		for _, row := range raw {
			values, err := modelValues(row, c)
			if err != nil {
				return outcome{}, err
			}
			m, err := compositeMembership(db, values)
			if err != nil {
				return outcome{}, err
			}
			rows = append(rows, m)
		}
		n, err := model.CompositeMembership().Connect(db).Creates(rows, s.k("batch").Batch)
		return outcome{fields: map[string]any{"value": map[string]any{"int": strconv.FormatInt(n, 10)}}}, err
	case "model.count":
		where, err := modelValues(s.k("where").Where, c)
		if err != nil {
			return outcome{}, err
		}
		m := model.CompositeMembership().Connect(db)
		for i, column := range sortedColumns(where) {
			if column != "tenant_id" {
				return outcome{}, fmt.Errorf("CompositeMembership column %s has no recipe filter", column)
			}
			n, err := int64Of(where[column], column)
			if err != nil {
				return outcome{}, err
			}
			if i > 0 {
				m = m.And()
			}
			m = m.TenantId(n)
		}
		n, err := m.GetCount()
		return outcome{fields: map[string]any{"value": map[string]any{"int": strconv.FormatInt(n, 10)}}}, err
	}
	return outcome{}, fmt.Errorf("op %s has no CompositeMembership entry", s.k("op").Op)
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
	"aes_key_version":    (*model.AuthorModel).AddColumnAesKeyVersion,
	"aes_hex_email":      (*model.AuthorModel).AddColumnAesHexEmail,
	"aes_hex_phone":      (*model.AuthorModel).AddColumnAesHexPhone,
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
	switch s.k("op").Op {
	case "model.save":
		// A set of the key and the named columns, with no read before it, then one Save.
		values, err := modelValues(s.k("values").Values, c)
		if err != nil {
			return outcome{}, err
		}
		m := model.Author().Connect(db)
		err = setColumns("Author", values, map[string]columnSetter{
			"seq":  int64Setter(m.SetSeq),
			"name": stringSetter(m.SetName),
		})
		if err != nil {
			return outcome{}, err
		}
		_, err = m.Save()
		return outcome{api: m, fields: map[string]any{}}, err
	case "model.count":
		where, err := modelValues(s.k("where").Where, c)
		if err != nil {
			return outcome{}, err
		}
		m, err := authorChain(db, where, nil)
		if err != nil {
			return outcome{}, err
		}
		return modelCount(m)
	case "model.query":
		where, err := modelValues(s.k("where").Where, c)
		if err != nil {
			return outcome{}, err
		}
		m, err := authorChain(db, where, s.k("columns").Columns)
		if err != nil {
			return outcome{}, err
		}
		for _, column := range s.k("order").Order {
			order, ok := authorOrders[column]
			if !ok {
				return outcome{}, fmt.Errorf("Author column %s has no recipe order", column)
			}
			m = order(m)
		}
		if s.k("limit").Limit > 0 || s.k("offset").Offset > 0 {
			m = m.Limit(int(s.k("offset").Offset), s.k("limit").Limit)
		}
		collection, err := m.Gets()
		if err != nil {
			return outcome{}, err
		}
		rows := []any{}
		for _, row := range collection.Slice() {
			rows = append(rows, rowCells(row, s.k("columns").Columns))
		}
		return outcome{fields: map[string]any{"rows": rows}}, nil
	case "model.get_by":
		// The key and the where are one chain: the equalities, the projection of columns, then the terminal Get.
		raw := s.k("key").Key
		if len(s.k("where").Where) > 0 {
			raw = s.k("where").Where
		}
		where, err := modelValues(raw, c)
		if err != nil {
			return outcome{}, err
		}
		m, err := authorChain(db, where, s.k("columns").Columns)
		if err != nil {
			return outcome{}, err
		}
		row, err := m.Get()
		if err != nil {
			return outcome{}, err
		}
		rows := []any{}
		if row != nil {
			rows = append(rows, rowCells(row, s.k("columns").Columns))
		}
		return outcome{fields: map[string]any{"rows": rows}}, nil
	case "model.update":
		key, set, err := keyAndSet(s, c)
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
		m, err := filterOf(s.k("key").Key)
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
		if s.k("column").Column != "read_count" {
			return outcome{}, fmt.Errorf("Author column %s has no recipe arithmetic", s.k("column").Column)
		}
		value, err := assignmentValue(s.k("amount").Amount, c)
		if err != nil {
			return outcome{}, err
		}
		amount, err := int32Of(value, s.k("column").Column)
		if err != nil {
			return outcome{}, err
		}
		switch s.k("operation").Operation {
		case "plus":
			row.PlusReadCount(amount)
		case "minus":
			row.MinusReadCount(amount)
		default:
			return outcome{}, fmt.Errorf("unknown arithmetic operation %q", s.k("operation").Operation)
		}
		_, err = row.Update()
		return outcome{fields: map[string]any{}}, err
	}
	return outcome{}, fmt.Errorf("OP_UNKNOWN %s", s.k("op").Op)
}

// userOp runs one model op of s on the User model; only model.delete names it (the referenced-user case).
func userOp(s databaseStep, c *databaseContext, db *orm.DB) (outcome, error) {
	where, err := modelValues(s.k("where").Where, c)
	if err != nil {
		return outcome{}, err
	}
	if s.k("op").Op != "model.delete" {
		return outcome{}, fmt.Errorf("op %s has no User entry", s.k("op").Op)
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
	return deleteRows(rows.Slice())
}

// noteReaderOp runs model.query on the NoteReader model with its relation to the external SharedNote model.
func noteReaderOp(s databaseStep, c *databaseContext, db *orm.DB) (outcome, error) {
	if s.k("op").Op != "model.query" || s.k("relation").Relation == nil {
		return outcome{}, fmt.Errorf("op %s has no NoteReader entry", s.k("op").Op)
	}
	var relation struct {
		Model   string     `json:"model"`
		Match   [][]string `json:"match"`
		Columns []string   `json:"columns"`
	}
	if err := json.Unmarshal(s.k("relation").Relation, &relation); err != nil {
		return outcome{}, err
	}
	if relation.Model != "SharedNote" || !slices.Equal(relation.Match[0], []string{"shared_note_seq", "seq"}) || len(relation.Match) != 1 {
		return outcome{}, fmt.Errorf("NoteReader relation %v has no recipe entry", relation.Match)
	}
	if len(s.k("columns").Columns) != 1 || s.k("columns").Columns[0] != "seq" || len(relation.Columns) != 1 || relation.Columns[0] != "title" {
		return outcome{}, fmt.Errorf("NoteReader columns %v with relation %v have no recipe entry", s.k("columns").Columns, relation.Columns)
	}
	if len(s.k("where").Where) > 0 && string(s.k("where").Where) != "{}" {
		return outcome{}, fmt.Errorf("NoteReader where %s has no recipe entry", s.k("where").Where)
	}
	if !slices.Equal(s.k("order").Order, []string{"seq"}) {
		return outcome{}, fmt.Errorf("NoteReader order %v has no recipe entry", s.k("order").Order)
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

// rankedTaskOp runs model.create and model.count of RankedTask, whose order column the application writes (DBS-79).
func rankedTaskOp(s databaseStep, c *databaseContext, db *orm.DB) (outcome, error) {
	switch s.k("op").Op {
	case "model.create":
		values, err := modelValues(s.k("values").Values, c)
		if err != nil {
			return outcome{}, err
		}
		m := model.RankedTask().Connect(db)
		err = setColumns("RankedTask", values, map[string]columnSetter{
			"title":    stringSetter(m.SetTitle),
			"position": int32Setter(m.SetPosition),
		})
		if err != nil {
			return outcome{}, err
		}
		_, err = m.Create()
		return outcome{fields: map[string]any{}}, err
	case "model.count":
		if len(s.k("where").Where) > 0 && string(s.k("where").Where) != "{}" {
			return outcome{}, fmt.Errorf("RankedTask where %s has no recipe entry", s.k("where").Where)
		}
		return modelCount(model.RankedTask().Connect(db))
	}
	return outcome{}, fmt.Errorf("op %s has no RankedTask entry", s.k("op").Op)
}

// searchEntity is the runtime-model entity of the model Author: an entity without an `entity` setting is named by its table
// (runtimemodel.Entity.Name), and the IR looks entities up by that name (ir.go query).
const searchEntity = "author"

// searchOp is query.search (FCV-4, PRT-75): the IR of a count with a fulltext_boolean predicate over the columns of the
// model. The request is compiled with the engine of the case dialect, which refuses SQLite (DIA-187), and the expect is
// the statement text and the bind value after the DIA-6 transform. A text with no term is run on the case connection
// through the generated model, so that the bind check refuses it with IR_INVALID.
func searchOp(s databaseStep, c *databaseContext) (outcome, error) {
	if s.k("model").Model != "Author" {
		return outcome{}, fmt.Errorf("model %s has no query.search entry", s.k("model").Model)
	}
	bound, ok := c.bound[s.k("connection").Connection]
	db, isDB := bound.api.(*orm.DB)
	if !ok || !isDB {
		return outcome{}, fmt.Errorf("query.search: connection %q is not bound by model.connect", s.k("connection").Connection)
	}
	if c.schema == nil {
		return outcome{}, fmt.Errorf("query.search needs the schema of the case")
	}
	e, err := engine.Load(c.schema.Text, c.schema.External, c.dialect())
	if err != nil {
		return outcome{}, err
	}
	position := 0
	request, err := json.Marshal(ir.Request{
		IRVersion:    ir.Version,
		ManifestHash: c.schema.Hash,
		Kind:         "count",
		Query: ir.Query{
			Entity: searchEntity,
			Where:  &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Op: "fulltext_boolean", Cols: s.k("columns").Columns, P: &position}}}},
		},
		NParams: 1,
	})
	if err != nil {
		return outcome{}, err
	}
	out, err := e.Compile(request)
	if err != nil {
		return outcome{}, err
	}
	var compiled plan.Plan
	if err := json.Unmarshal(out, &compiled); err != nil {
		return outcome{}, err
	}
	if len(compiled.Steps) != 1 {
		return outcome{}, fmt.Errorf("query.search compiled %d statements, want 1", len(compiled.Steps))
	}
	// The value is the one the statement binds: the transform that the plan declares for its slot (DIA-6 declares
	// fulltext_boolean on MySQL only; PostgreSQL binds the text as it is).
	boolean := len(compiled.Steps[0].BindSlots) > 0 && compiled.Steps[0].BindSlots[0].Transform == "fulltext_boolean"
	value := s.k("text").Text
	if boolean {
		value = plan.FulltextBoolean(s.k("text").Text)
	}
	if boolean && value == "" {
		m := model.Author().Connect(db)
		m.Orm_().Where("", []orm.ChainKey{{Op: "fulltext_boolean", Columns: s.k("columns").Columns}}, s.k("text").Text)
		if _, err := m.GetCount(); err != nil {
			return outcome{}, err
		}
		return outcome{}, fmt.Errorf("query.search ran a blank text without a bind-check error")
	}
	return outcome{fields: map[string]any{"sql": compiled.Steps[0].SQL, "params": []any{wrapperOf(value)}}}, nil
}

// searchChainOp is query.search_chain (FCV-4): the statement of the generated fulltext method of the mode, read through
// GetQuery on the case connection.
func searchChainOp(s databaseStep, c *databaseContext) (outcome, error) {
	if s.k("model").Model != "Author" {
		return outcome{}, fmt.Errorf("model %s has no query.search_chain entry", s.k("model").Model)
	}
	bound, ok := c.bound[s.k("connection").Connection]
	db, isDB := bound.api.(*orm.DB)
	if !ok || !isDB {
		return outcome{}, fmt.Errorf("query.search_chain: connection %q is not bound by model.connect", s.k("connection").Connection)
	}
	m := model.Author().Connect(db)
	switch s.k("mode").Mode {
	case "fulltext_boolean":
		m = m.FulltextBooleanNameWithDescription(s.k("text").Text)
	case "fulltext":
		m = m.FulltextNameWithDescription(s.k("text").Text)
	default:
		return outcome{}, fmt.Errorf("query.search_chain: mode %q has no generated method", s.k("mode").Mode)
	}
	statement, err := m.GetQuery()
	if err != nil {
		return outcome{}, err
	}
	params := make([]any, 0, len(statement.Binds))
	for _, bind := range statement.Binds {
		params = append(params, wrapperOf(bind))
	}
	return outcome{fields: map[string]any{"sql": statement.SQL, "params": params}}, nil
}
