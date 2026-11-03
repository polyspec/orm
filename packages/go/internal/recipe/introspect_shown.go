package recipe

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
)

// shownVectors is the file that a dbspec.introspect_shown step names: the canned catalog and the SHOW CREATE TABLE text of each case.
type shownVectors struct {
	Catalog struct {
		Table   string `json:"table"`
		Columns []struct {
			Name      string `json:"name"`
			Type      string `json:"type"`
			Nullable  string `json:"nullable"`
			Charset   string `json:"charset"`
			Collation string `json:"collation"`
		} `json:"columns"`
		PrimaryKey   string `json:"primary_key"`
		StoredClause string `json:"stored_clause"`
	} `json:"catalog"`
	Cases []struct {
		ID     string   `json:"id"`
		Create []string `json:"create"`
		Name   string   `json:"name"`
	} `json:"cases"`
}

// shownQuerier is the public Querier that answers the catalog queries of the MySQL introspection from a case of the vectors. Its
// answers are SQLite SELECTs, since a Querier returns *sql.Rows.
type shownQuerier struct {
	db      *sql.DB
	vectors *shownVectors
	create  string
	name    string
}

// QueryContext answers one catalog query; an unknown query is an error.
func (q shownQuerier) QueryContext(ctx context.Context, query string, _ ...any) (*sql.Rows, error) {
	rows, width, err := q.answer(query)
	if err != nil {
		return nil, err
	}
	var b strings.Builder
	var params []any
	for i, row := range rows {
		if i > 0 {
			b.WriteString(" UNION ALL ")
		}
		b.WriteString("SELECT ")
		b.WriteString(strings.TrimSuffix(strings.Repeat("?, ", len(row)), ", "))
		params = append(params, row...)
	}
	if len(rows) == 0 {
		b.WriteString("SELECT " + strings.TrimSuffix(strings.Repeat("NULL, ", width), ", ") + " WHERE 0")
	}
	return q.db.QueryContext(ctx, b.String(), params...)
}

// answer is the rows and the column count of a catalog query.
func (q shownQuerier) answer(query string) ([][]any, int, error) {
	catalog := q.vectors.Catalog
	t := catalog.Table
	switch {
	case strings.Contains(query, "information_schema.TABLES"):
		return [][]any{{t, "BASE TABLE", ""}}, 3, nil
	case strings.Contains(query, "information_schema.COLUMNS"):
		var rows [][]any
		for _, c := range catalog.Columns {
			rows = append(rows, []any{t, c.Name, c.Type, c.Nullable, nil, "", c.Charset, c.Collation, ""})
		}
		return rows, 9, nil
	case strings.Contains(query, "information_schema.STATISTICS"):
		return [][]any{{t, "PRIMARY", 0, catalog.PrimaryKey, "A", 0, 0, "BTREE"}}, 8, nil
	case strings.Contains(query, "REFERENTIAL_CONSTRAINTS"):
		return nil, 8, nil
	case strings.Contains(query, "CHECK_CONSTRAINTS"):
		return [][]any{{q.name, catalog.StoredClause}}, 2, nil
	case strings.Contains(query, "TABLE_CONSTRAINTS"):
		return [][]any{{t, q.name, "YES"}}, 3, nil
	case strings.Contains(query, "information_schema.TRIGGERS"):
		return nil, 5, nil
	case strings.Contains(query, "information_schema.ROUTINES"), strings.Contains(query, "information_schema.EVENTS"):
		return nil, 1, nil
	case strings.Contains(query, "SHOW CREATE TABLE"):
		return [][]any{{t, q.create}}, 2, nil
	}
	return nil, 0, fmt.Errorf("the canned catalog has no answer for the query %q", query)
}

// checkIntrospectShown runs one dbspec.introspect_shown step: the public Introspect on the canned catalog of a case of the vectors
// file, whose check lines and unsupported objects, or error, it compares with the expect of database (DIA-84). A reason compares by
// its rule, the text before the first ": ", since its text differs between the clients.
func checkIntrospectShown(t *testing.T, dir string, s step, database string) error {
	text, err := os.ReadFile(filepath.Join(dir, s.k("vectors").Vectors))
	if err != nil {
		return err
	}
	var vectors shownVectors
	if err := json.Unmarshal(text, &vectors); err != nil {
		return err
	}
	var want struct {
		Checks      []string `json:"checks"`
		Unsupported []string `json:"unsupported"`
		Error       string   `json:"error"`
	}
	if err := json.Unmarshal(s.k("expect").Expect[database], &want); err != nil {
		return err
	}
	at := slices.IndexFunc(vectors.Cases, func(c struct {
		ID     string   `json:"id"`
		Create []string `json:"create"`
		Name   string   `json:"name"`
	}) bool {
		return c.ID == s.k("case").Case
	})
	if at < 0 {
		return fmt.Errorf("%s has no case %s", s.k("vectors").Vectors, s.k("case").Case)
	}
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		return err
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Errorf("close the SQLite connection of the canned answers: %v", err)
		}
	}()
	db.SetMaxOpenConns(1)
	found := vectors.Cases[at]
	querier := shownQuerier{db: db, vectors: &vectors, create: strings.Join(found.Create, "\n") + "\n", name: found.Name}
	document, unsupported, err := dbspec.Introspect(context.Background(), querier, dbspec.DialectMySQL, "introspected")
	if want.Error != "" {
		if err == nil || err.Error() != want.Error {
			return fmt.Errorf("the introspection returned %v, want the error %q", err, want.Error)
		}
		return nil
	}
	if err != nil {
		return err
	}
	checks := []string{}
	for _, line := range strings.Split(dbspec.Emit(document), "\n") {
		if line = strings.TrimSpace(line); strings.HasPrefix(line, "check ") {
			checks = append(checks, line)
		}
	}
	reasons := []string{}
	for _, item := range unsupported {
		rule, _, _ := strings.Cut(item.Reason, ": ")
		reasons = append(reasons, fmt.Sprintf("%s %s: %s", item.Kind, item.Name, rule))
	}
	if !slices.Equal(checks, want.Checks) || !slices.Equal(reasons, want.Unsupported) {
		return fmt.Errorf("checks %q and unsupported %q, want %q and %q", checks, reasons, want.Checks, want.Unsupported)
	}
	return nil
}
