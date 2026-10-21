package dbspec

import (
	"context"
	"database/sql"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// showCreateCannedQuerier is the Querier that answers the catalog queries readMySQL reads, from the canned
// catalog and cases of tests/dbspec/show-create.json. Answers are built with SQLite SELECT and returned as *sql.Rows (T62-4-8).
type showCreateCannedQuerier struct {
	db     *sql.DB
	cat    showCreateCatalog
	create string
	name   string
}

func (q showCreateCannedQuerier) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
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
		for j, v := range row {
			if j > 0 {
				b.WriteString(", ")
			}
			b.WriteString("?")
			params = append(params, v)
		}
	}
	if len(rows) == 0 {
		nulls := make([]string, width)
		for i := range nulls {
			nulls[i] = "NULL"
		}
		b.WriteString("SELECT " + strings.Join(nulls, ", ") + " WHERE 0")
	}
	return q.db.QueryContext(ctx, b.String(), params...)
}

// answer is the rows and column count of a query. An unknown query is an error.
func (q showCreateCannedQuerier) answer(query string) ([][]any, int, error) {
	t := q.cat.Table
	switch {
	case strings.Contains(query, "information_schema.TABLES"):
		return [][]any{{t, "BASE TABLE", ""}}, 3, nil
	case strings.Contains(query, "information_schema.COLUMNS"):
		var rows [][]any
		for _, c := range q.cat.Columns {
			rows = append(rows, []any{t, c.Name, c.Type, c.Nullable, nil, "", c.Charset, c.Collation, ""})
		}
		return rows, 9, nil
	case strings.Contains(query, "information_schema.STATISTICS"):
		return [][]any{{t, "PRIMARY", 0, q.cat.PrimaryKey, "A", 0, 0, "BTREE"}}, 8, nil
	case strings.Contains(query, "REFERENTIAL_CONSTRAINTS"):
		return nil, 8, nil
	case strings.Contains(query, "CHECK_CONSTRAINTS"):
		return [][]any{{q.name, q.cat.StoredClause}}, 2, nil
	case strings.Contains(query, "TABLE_CONSTRAINTS"):
		return [][]any{{t, q.name, "YES"}}, 3, nil
	case strings.Contains(query, "information_schema.TRIGGERS"):
		return nil, 5, nil
	case strings.Contains(query, "information_schema.ROUTINES"), strings.Contains(query, "information_schema.EVENTS"):
		return nil, 1, nil
	case strings.Contains(query, "SHOW CREATE TABLE"):
		return [][]any{{t, q.create}}, 2, nil
	}
	return nil, 0, fmt.Errorf("showCreateCannedQuerier has no answer for the query %q", query)
}

// TestMySQLIntrospectionOfShownChecks checks that Go's MySQL introspection yields the same predicate from the canned catalog
// and the same error.
// Requirements: DIA-84.
func TestMySQLIntrospectionOfShownChecks(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	v := loadShowCreate(t)
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("cannot open the in-memory SQLite database that answers the catalog: %v", err)
	}
	defer testcase.Close(t, db)
	db.SetMaxOpenConns(1)
	for _, c := range v.Cases {
		t.Run(c.ID, func(t *testing.T) {
			q := showCreateCannedQuerier{db: db, cat: v.Catalog, create: strings.Join(c.Create, "\n") + "\n", name: c.Name}
			doc, unsupported, err := Introspect(context.Background(), q, DialectMySQL, v.Catalog.Table)
			if c.Error != "" {
				if err == nil || err.Error() != c.Error {
					t.Fatalf("Introspect error = %v, want %q", err, c.Error)
				}
				return
			}
			if err != nil {
				t.Fatalf("Introspect: %v", err)
			}
			var checks []string
			for _, line := range strings.Split(Emit(doc), "\n") {
				if line = strings.TrimSpace(line); strings.HasPrefix(line, "check ") {
					checks = append(checks, line)
				}
			}
			var reasons []string
			for _, u := range unsupported {
				// The reason text differs between the clients; the rule before the first ": " is compared.
				rule, _, _ := strings.Cut(u.Reason, ": ")
				reasons = append(reasons, fmt.Sprintf("%s %s: %s", u.Kind, u.Name, rule))
			}
			if !slices.Equal(checks, c.Checks) {
				t.Fatalf("checks\n got: %q\nwant: %q", checks, c.Checks)
			}
			if !slices.Equal(reasons, c.Unsupported) {
				t.Fatalf("unsupported\n got: %q\nwant: %q", reasons, c.Unsupported)
			}
		})
	}
}
