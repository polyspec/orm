package ormgen

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/polyspec/orm/engine/schema"
)

// MySQL and PostgreSQL store a CHECK expression in their own normalized form,
// so the text read from the catalog differs from the declared expression. To
// compare them, the declared expression is created on a temporary table of
// the same database and read back through the same catalog path; SQLite
// keeps the text it was given, so its form is the rendered DDL text.
//
// alignLiveChecks replaces the expression of every live check that is
// equivalent to the declared check of the same name with the declared text,
// so a diff reports only real changes. A changed live manifest gets the hash
// of its new content, so a plan that stores it stays self-consistent.
func alignLiveChecks(ctx context.Context, db *sql.DB, driver string, live, want *schema.Manifest) error {
	changed := false
	for name, declared := range want.Entities {
		if len(declared.Checks) == 0 {
			continue
		}
		current := live.Entities[name]
		if current == nil {
			for _, candidate := range live.Entities {
				if candidate.Table == ddlTable(declared.Table, driver) {
					current = candidate
				}
			}
		}
		if current == nil || len(current.Checks) == 0 {
			continue
		}
		canonical, err := canonicalChecks(ctx, db, driver, declared)
		if err != nil {
			return fmt.Errorf("table %s: normalize CHECK expressions: %w", declared.Table, err)
		}
		for i := range current.Checks {
			for j, check := range declared.Checks {
				if check.Name == current.Checks[i].Name && canonical[j] == current.Checks[i].Expr && current.Checks[i].Expr != check.Expr {
					current.Checks[i].Expr = check.Expr
					changed = true
				}
			}
		}
	}
	if changed {
		live.Rehash()
	}
	return nil
}

// canonicalChecks returns the catalog form of each declared check of e, in
// declaration order.
func canonicalChecks(ctx context.Context, db *sql.DB, driver string, e *schema.Entity) ([]string, error) {
	quote := func(s string) string { return `"` + s + `"` }
	if driver == "mysql" {
		quote = func(s string) string { return "`" + s + "`" }
	}
	exprs := make([]string, len(e.Checks))
	for i, check := range e.Checks {
		expr, err := quotedCheckExpression(check.Expr, quote)
		if err != nil {
			return nil, err
		}
		exprs[i] = expr
	}
	if driver == "sqlite" {
		return exprs, nil
	}
	const probe = "__orm_check_probe"
	lines := make([]string, 0, len(e.Columns)+len(exprs))
	for _, c := range e.Columns {
		plain := *c
		plain.Auto = false
		def, err := ddlColumn(&plain, driver, quote)
		if err != nil {
			return nil, err
		}
		lines = append(lines, def)
	}
	for i, expr := range exprs {
		lines = append(lines, fmt.Sprintf("CONSTRAINT %s CHECK (%s)", quote(probeCheckName(i)), expr))
	}
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	create := "CREATE TEMPORARY TABLE " + quote(probe) + " (" + strings.Join(lines, ", ") + ")"
	if _, err := conn.ExecContext(ctx, create); err != nil {
		return nil, err
	}
	defer conn.ExecContext(context.Background(), "DROP TABLE IF EXISTS "+quote(probe))
	byName := map[string]string{}
	if driver == "mysql" {
		var table, text string
		if err := conn.QueryRowContext(ctx, "SHOW CREATE TABLE "+quote(probe)).Scan(&table, &text); err != nil {
			return nil, err
		}
		for i := range exprs {
			marker := "CONSTRAINT " + quote(probeCheckName(i)) + " CHECK "
			at := strings.Index(text, marker)
			if at < 0 {
				return nil, fmt.Errorf("check %s is missing from the probe table", e.Checks[i].Name)
			}
			open := at + len(marker)
			end, err := sqliteBalancedParen(text, open)
			if err != nil {
				return nil, err
			}
			byName[probeCheckName(i)] = text[open+1 : end]
		}
	} else {
		rows, err := conn.QueryContext(ctx, `SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'pg_temp.`+probe+`'::regclass AND contype = 'c'`)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var name, definition string
			if err := rows.Scan(&name, &definition); err != nil {
				return nil, err
			}
			byName[name] = postgresCheckExpr(definition)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	out := make([]string, len(exprs))
	for i := range exprs {
		text, ok := byName[probeCheckName(i)]
		if !ok {
			return nil, fmt.Errorf("check %s is missing from the probe table", e.Checks[i].Name)
		}
		out[i] = text
	}
	return out, nil
}

func probeCheckName(i int) string { return fmt.Sprintf("__orm_check_probe_%d", i+1) }

// postgresCheckExpr strips the CHECK keyword from pg_get_constraintdef.
func postgresCheckExpr(definition string) string {
	expr := strings.TrimSpace(definition)
	if len(expr) >= 5 && strings.EqualFold(expr[:5], "CHECK") {
		expr = strings.TrimSpace(expr[5:])
	}
	return expr
}

// alignSourceChecks aligns the checks of a db: source with the other side of
// a diff, which is compared in that database.
func alignSourceChecks(fromPath, toPath string, from, to *schema.Manifest) error {
	align := func(source string, live, want *schema.Manifest) error {
		if !strings.HasPrefix(source, "db:") {
			return nil
		}
		db, dsn, err := openToolDB(strings.TrimPrefix(source, "db:"))
		if err != nil {
			return err
		}
		defer db.Close()
		return alignLiveChecks(context.Background(), db, dsn.dialect, live, want)
	}
	if err := align(fromPath, from, to); err != nil {
		return err
	}
	return align(toPath, to, from)
}
