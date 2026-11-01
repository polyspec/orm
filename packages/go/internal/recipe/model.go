package recipe

// The model ops of a database recipe (FCV-4): model.connect, model.creates, model.query and model.count call the public
// generic functions of the orm package (Gets, GetsPage, Creates, GetsCount and Core.GetCount) on the generated models of
// the recipe's fixture. The generated models have no registry by name, so modelTable maps a model name to its generated
// constructor and its primary key, in a plain switch.

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
)

// createsBatch is the batch of model.creates (INT-35), the same in every runtime of the recipe.
const createsBatch = 100

// modelTable is one generated model of the fixture as the model ops use it.
type modelTable struct {
	primaryKey []string
	fresh      func() orm.Model
	creates    func(c *orm.Core, rows []orm.Model) (int64, error)
	gets       func(c *orm.Core) (collectionView, error)
	page       func(c *orm.Core, page, perPage int) (pageView, error)
	count      func(c *orm.Core) (int64, error)
}

// collectionView is the part of a collection that a model op reads: the models of its keys and their columns, in order.
type collectionView struct {
	rows []map[string]any
}

// pageView is one page of a collection with its totals.
type pageView struct {
	page, perPage, totalCount, totalPages int64
	rows                                  []map[string]any
}

// table builds the modelTable of the generated model type T, whose constructor is fresh.
func table[T orm.Model](fresh func() T, primaryKey ...string) modelTable {
	return modelTable{
		primaryKey: primaryKey,
		fresh:      func() orm.Model { return fresh() },
		creates: func(c *orm.Core, rows []orm.Model) (int64, error) {
			typed := make([]T, len(rows))
			for i, row := range rows {
				model, ok := row.(T)
				if !ok {
					return 0, fmt.Errorf("creates: row %d is %T, not the model of this table", i, row)
				}
				typed[i] = model
			}
			return orm.Creates(c, typed, createsBatch)
		},
		gets: func(c *orm.Core) (collectionView, error) {
			all, err := orm.Gets[T](c)
			if err != nil {
				return collectionView{}, err
			}
			return collectionView{rows: all.ToArray()}, nil
		},
		page: func(c *orm.Core, page, perPage int) (pageView, error) {
			result, err := orm.GetsPage[T](c, page, perPage)
			if err != nil {
				return pageView{}, err
			}
			return pageView{
				page: int64(result.Page), perPage: int64(result.PerPage),
				totalCount: result.TotalCount, totalPages: result.TotalPages,
				rows: result.Items.ToArray(),
			}, nil
		},
		count: func(c *orm.Core) (int64, error) { return c.GetCount() },
	}
}

// modelNamed returns the table of the generated model that the name of a model op names.
func modelNamed(name string) (modelTable, error) {
	switch name {
	case "account":
		return table(model.Account, "seq"), nil
	case "author":
		return table(model.Author, "seq"), nil
	case "composite_account":
		return table(model.CompositeAccount, "tenant_id", "account_id"), nil
	}
	return modelTable{}, fmt.Errorf("MODEL_UNKNOWN %s", name)
}

// modelConnect opens the connection of a model.connect step on the case database; the model ops of the case use it.
func modelConnect(s databaseStep, c *databaseContext) (outcome, error) {
	db, err := model.Connect(c.dsn, orm.Config{PoolSize: s.PoolSize})
	if err != nil {
		return outcome{}, err
	}
	if c.model != nil {
		if err := c.model.Close(); err != nil {
			return outcome{}, err
		}
	}
	c.model = db
	return outcome{api: db}, nil
}

// modelOp runs one model op on the connection of the case and returns the fields that its expect compares.
func modelOp(s databaseStep, c *databaseContext) (outcome, error) {
	if c.model == nil {
		return outcome{}, fmt.Errorf("%s before model.connect", s.Op)
	}
	t, err := modelNamed(s.Model)
	if err != nil {
		return outcome{}, err
	}
	switch s.Op {
	case "model.creates":
		return createRows(t, s, c)
	case "model.query":
		return queryRows(t, s, c)
	case "model.count":
		return countRows(t, s, c)
	}
	return outcome{}, fmt.Errorf("OP_UNKNOWN %s", s.Op)
}

// createRows builds each row of the step on a fresh model, then inserts them with the default batch (INT-35).
func createRows(t modelTable, s databaseStep, c *databaseContext) (outcome, error) {
	var rows []json.RawMessage
	if err := json.Unmarshal(s.Rows, &rows); err != nil {
		return outcome{}, err
	}
	models := make([]orm.Model, 0, len(rows))
	for _, row := range rows {
		members, err := orderedMembers(row)
		if err != nil {
			return outcome{}, err
		}
		m := t.fresh()
		for _, member := range members {
			v, err := assignmentValue(member.value, c)
			if err != nil {
				return outcome{}, err
			}
			m.Orm_().Set(member.key, v)
		}
		models = append(models, m)
	}
	conn := t.fresh().Orm_()
	conn.Connect(c.model)
	n, err := t.creates(conn, models)
	if err != nil {
		return outcome{}, err
	}
	return outcome{fields: map[string]any{"value": map[string]any{"int": strconv.FormatInt(n, 10)}}}, nil
}

// queryRows reads the collection (gets) or the page (gets_page) of the model and keeps the columns of the step.
func queryRows(t modelTable, s databaseStep, c *databaseContext) (outcome, error) {
	conn := t.fresh().Orm_()
	conn.Connect(c.model)
	if s.Page == nil {
		view, err := t.gets(conn)
		if err != nil {
			return outcome{}, err
		}
		rows, keys, err := listRows(view.rows, t.primaryKey, s.Columns)
		if err != nil {
			return outcome{}, err
		}
		return outcome{api: view.rows, fields: map[string]any{"value": map[string]any{"keys": keys, "rows": rows}}}, nil
	}
	var page int
	if err := json.Unmarshal(s.Page, &page); err != nil {
		return outcome{}, err
	}
	view, err := t.page(conn, page, s.Limit)
	if err != nil {
		return outcome{}, err
	}
	rows, _, err := listRows(view.rows, t.primaryKey, s.Columns)
	if err != nil {
		return outcome{}, err
	}
	return outcome{api: view.rows, fields: map[string]any{"value": map[string]any{
		"page":        wrapInt(view.page),
		"per_page":    wrapInt(view.perPage),
		"total_count": wrapInt(view.totalCount),
		"total_pages": wrapInt(view.totalPages),
		"rows":        rows,
	}}}, nil
}

// countRows counts the rows of the model (get_count), or the rows of each group of the step (gets_count).
func countRows(t modelTable, s databaseStep, c *databaseContext) (outcome, error) {
	conn := t.fresh().Orm_()
	conn.Connect(c.model)
	if len(s.Group) == 0 {
		n, err := t.count(conn)
		if err != nil {
			return outcome{}, err
		}
		return outcome{fields: map[string]any{"value": wrapInt(n)}}, nil
	}
	for _, column := range s.Group {
		conn.GroupBy(column)
	}
	groups, err := orm.GetsCount(conn)
	if err != nil {
		return outcome{}, err
	}
	out := make([]any, 0, groups.Len())
	for row := range groups.All() {
		values := make([]any, 0, len(s.Group))
		for _, column := range s.Group {
			v, err := row.Value(column)
			if err != nil {
				return outcome{}, err
			}
			w, err := wrapValue(v)
			if err != nil {
				return outcome{}, err
			}
			values = append(values, w)
		}
		out = append(out, map[string]any{"values": values, "row_count": wrapInt(row.Count())})
	}
	return outcome{fields: map[string]any{"value": map[string]any{"groups": out}}}, nil
}

// listRows keeps the columns of each model in order and, when the primary key is known, its key values.
func listRows(models []map[string]any, primaryKey, columns []string) ([][]any, [][]any, error) {
	rows := make([][]any, 0, len(models))
	keys := make([][]any, 0, len(models))
	for _, m := range models {
		row := make([]any, 0, len(columns))
		for _, column := range columns {
			w, err := wrapValue(m[column])
			if err != nil {
				return nil, nil, err
			}
			row = append(row, w)
		}
		rows = append(rows, row)
		key := make([]any, 0, len(primaryKey))
		for _, column := range primaryKey {
			w, err := wrapValue(m[column])
			if err != nil {
				return nil, nil, err
			}
			key = append(key, w)
		}
		keys = append(keys, key)
	}
	return rows, keys, nil
}

// wrapInt is the recipe wrapper of an integer.
func wrapInt(n int64) map[string]any { return map[string]any{"int": strconv.FormatInt(n, 10)} }

// wrapValue is the recipe wrapper of a value of the Go API that a model op returns.
func wrapValue(v any) (any, error) {
	switch x := v.(type) {
	case int64:
		return wrapInt(x), nil
	case int32:
		return wrapInt(int64(x)), nil
	case int:
		return wrapInt(int64(x)), nil
	case string:
		return map[string]any{"text": x}, nil
	case bool:
		return map[string]any{"bool": x}, nil
	case []byte:
		return map[string]any{"bytes_hex": hex.EncodeToString(x)}, nil
	}
	return nil, fmt.Errorf("no recipe wrapper for %T", v)
}
