package main

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type counterValue struct {
	value  int64
	called bool
	// owner is the table that owns a PostgreSQL sequence (pg_depend), empty
	// when no table owns it.
	owner string
}

var conformanceWriteTables = map[string]bool{
	"author":         true,
	"service":        true,
	"service_member": true,
	"soft_record":    true,
	"task":           true,
}

var mysqlAutoOption = regexp.MustCompile(`(?:^|\s)AUTO_INCREMENT=([0-9]+)(?:\s|$)`)

func readCounters(db *sql.DB, driver string) (map[string]counterValue, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	values := map[string]counterValue{}
	switch driver {
	case "sqlite":
		var exists bool
		if err := db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence')").Scan(&exists); err != nil {
			return nil, err
		}
		if !exists {
			return values, nil
		}
		rows, err := db.QueryContext(ctx, "SELECT name, seq FROM sqlite_sequence ORDER BY name")
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var name string
			var value int64
			if err := rows.Scan(&name, &value); err != nil {
				return nil, err
			}
			values[name] = counterValue{value: value, called: true}
		}
		return values, rows.Err()
	case "mysql":
		rows, err := db.QueryContext(ctx, "SELECT DISTINCT c.table_name FROM information_schema.columns c WHERE c.table_schema = DATABASE() AND c.extra LIKE '%auto_increment%' ORDER BY c.table_name")
		if err != nil {
			return nil, err
		}
		tables := []string{}
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				rows.Close()
				return nil, err
			}
			tables = append(tables, name)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		for _, name := range tables {
			var returned, ddl string
			quoted := "`" + strings.ReplaceAll(name, "`", "``") + "`"
			if err := db.QueryRowContext(ctx, "SHOW CREATE TABLE "+quoted).Scan(&returned, &ddl); err != nil {
				return nil, err
			}
			if returned != name {
				return nil, fmt.Errorf("SHOW CREATE TABLE returned %q for %q", returned, name)
			}
			value := int64(1)
			if found := mysqlAutoOption.FindStringSubmatch(ddl); found != nil {
				value, err = strconv.ParseInt(found[1], 10, 64)
				if err != nil {
					return nil, fmt.Errorf("MySQL auto-increment value for %s: %w", name, err)
				}
			}
			values[name] = counterValue{value: value, called: true}
		}
		return values, nil
	case "postgres":
		// The owning table comes from pg_depend: a serial column's sequence
		// depends on its table with deptype 'a', an identity column's with 'i'.
		// The sequence name cannot tell, because PostgreSQL truncates it to 63
		// bytes.
		rows, err := db.QueryContext(ctx, `SELECT s.schemaname, s.sequencename, COALESCE(t.relname, '')
			FROM pg_catalog.pg_sequences s
			JOIN pg_catalog.pg_namespace n ON n.nspname = s.schemaname
			JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = s.sequencename
			LEFT JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid
				AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.deptype IN ('a', 'i')
			LEFT JOIN pg_catalog.pg_class t ON t.oid = d.refobjid
			WHERE s.schemaname = current_schema() ORDER BY s.sequencename`)
		if err != nil {
			return nil, err
		}
		sequences := [][3]string{}
		for rows.Next() {
			var schema, name, owner string
			if err := rows.Scan(&schema, &name, &owner); err != nil {
				rows.Close()
				return nil, err
			}
			sequences = append(sequences, [3]string{schema, name, owner})
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		for _, sequence := range sequences {
			qualified := quoteIdentifier(sequence[0]) + "." + quoteIdentifier(sequence[1])
			var value int64
			var called bool
			if err := db.QueryRowContext(ctx, "SELECT last_value, is_called FROM "+qualified).Scan(&value, &called); err != nil {
				return nil, fmt.Errorf("read PostgreSQL sequence %s: %w", qualified, err)
			}
			values[qualified] = counterValue{value: value, called: called, owner: sequence[2]}
		}
		return values, nil
	default:
		return nil, fmt.Errorf("unsupported counter database %q", driver)
	}
}

func quoteIdentifier(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

func restoreCounters(db *sql.DB, driver string, before map[string]counterValue) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	after, err := readCounters(db, driver)
	if err != nil {
		return err
	}
	names := map[string]bool{}
	for name := range before {
		names[name] = true
	}
	for name := range after {
		names[name] = true
	}
	ordered := make([]string, 0, len(names))
	for name := range names {
		ordered = append(ordered, name)
	}
	sort.Strings(ordered)
	for _, name := range ordered {
		old, existed := before[name]
		current, existsNow := after[name]
		if existed == existsNow && old == current {
			continue
		}
		table := name
		if driver == "postgres" {
			// A sequence belongs to the table that owns it; the conformance
			// vectors change no sequence that no table owns.
			table = old.owner
			if !existed {
				table = current.owner
			}
			if table == "" {
				return fmt.Errorf("PostgreSQL sequence owned by no table changed: %s", name)
			}
		}
		if !conformanceWriteTables[table] {
			return fmt.Errorf("undeclared %s counter changed: %s", driver, name)
		}
		if driver != "sqlite" && (!existed || !existsNow) {
			return fmt.Errorf("%s counter appeared or disappeared: %s", driver, name)
		}
		fmt.Printf("check: restore %s counter %s from %d to %d\n", driver, name, current.value, old.value)
		switch driver {
		case "sqlite":
			if existed {
				_, err = db.ExecContext(ctx, "UPDATE sqlite_sequence SET seq = ? WHERE name = ?", old.value, name)
			} else {
				_, err = db.ExecContext(ctx, "DELETE FROM sqlite_sequence WHERE name = ?", name)
			}
		case "mysql":
			_, err = db.ExecContext(ctx, "ALTER TABLE `"+strings.ReplaceAll(name, "`", "``")+"` AUTO_INCREMENT = "+fmt.Sprint(old.value))
		case "postgres":
			_, err = db.ExecContext(ctx, "SELECT setval($1::regclass, $2, $3)", name, old.value, old.called)
		default:
			return fmt.Errorf("unsupported counter database %q", driver)
		}
		if err != nil {
			return fmt.Errorf("restore %s counter %s: %w", driver, name, err)
		}
	}
	return nil
}
