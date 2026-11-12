package recipe

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"slices"

	"github.com/polyspec/orm/packages/go/internal/dbspec/ddlcases"
	"github.com/polyspec/orm/packages/go/internal/testdb"
	"github.com/polyspec/orm/packages/go/testcase"
)

// ddlConnectionRules are the statements that every client runs on a new connection (docs/spec/dbspec.md "Types",
// docs/spec/dialects.md "Foreign keys").
var ddlConnectionRules = map[string]string{
	"mysql":    "SET time_zone = '+00:00'",
	"postgres": "SET TimeZone = 'UTC'",
	"sqlite":   "PRAGMA foreign_keys = ON",
}

// ddlVectorCase reads the case with the given id from the ddl vectors at the path under dir.
func ddlVectorCase(dir, path, id string) (ddlcases.Case, error) {
	vectors, err := ddlcases.Read(filepath.Join(dir, path))
	if err != nil {
		return ddlcases.Case{}, err
	}
	index := slices.IndexFunc(vectors.Cases, func(candidate ddlcases.Case) bool { return candidate.ID == id })
	if index < 0 {
		return ddlcases.Case{}, fmt.Errorf("the vectors have no case %s", id)
	}
	return vectors.Cases[index], nil
}

// execBehaviorStep runs the statement of a behavior step; a step with fails must fail.
func execBehaviorStep(ctx context.Context, raw *sql.DB, step ddlcases.Step) error {
	_, err := raw.ExecContext(ctx, step.SQL)
	if step.Fails && err == nil {
		return fmt.Errorf("%s must fail", step.SQL)
	}
	if !step.Fails && err != nil {
		return fmt.Errorf("%s: %w", step.SQL, err)
	}
	return nil
}

// ddlBehavior runs one dbspec.ddl_behavior step on one native connection of the case database: the connection rules, the
// statements of the case for the database, then its behavior steps. A step with dialects runs only on those; a step with
// fails must fail; a query compares its first value, as text, with want; a NULL or absent value fails it (DIA-113).
func ddlBehavior(s databaseStep, c *databaseContext) error {
	vector, err := ddlVectorCase(c.dir, s.k("vectors").Vectors, s.k("case").Case)
	if err != nil {
		return err
	}
	statements, ok := vector.Statements[c.dialect()]
	if !ok {
		return fmt.Errorf("the case %s has no statements for %s", s.k("case").Case, c.database)
	}
	raw := testdb.Open(c.t, c.database, c.dsn)
	defer testcase.Close(c.t, raw)
	// One connection, so that the connection rules hold for every statement after them.
	raw.SetMaxOpenConns(1)
	for _, statement := range append([]string{ddlConnectionRules[c.dialect()]}, statements...) {
		if _, err := raw.ExecContext(c.ctx, statement); err != nil {
			return fmt.Errorf("%s: %w", statement, err)
		}
	}
	for _, step := range vector.Behavior {
		if len(step.Dialects) > 0 && !slices.Contains(step.Dialects, c.dialect()) {
			continue
		}
		if step.SQL != "" {
			if err := execBehaviorStep(c.ctx, raw, step); err != nil {
				return err
			}
			continue
		}
		var got sql.NullString
		if err := raw.QueryRowContext(c.ctx, step.Query).Scan(&got); err != nil {
			return fmt.Errorf("%s: %w", step.Query, err)
		}
		if !got.Valid {
			return fmt.Errorf("%s: NULL value", step.Query)
		}
		if got.String != step.Want {
			return fmt.Errorf("%s: got %q, want %q", step.Query, got.String, step.Want)
		}
	}
	return nil
}
