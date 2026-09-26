package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

func openStateDatabase(driver, raw string) (*sql.DB, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	if u.Scheme != driver {
		return nil, fmt.Errorf("state DSN scheme %q differs from database %q", u.Scheme, driver)
	}
	switch driver {
	case "mysql":
		cfg := mysql.NewConfig()
		cfg.User = u.User.Username()
		cfg.Passwd, _ = u.User.Password()
		cfg.DBName = strings.TrimPrefix(u.Path, "/")
		cfg.Net, cfg.Addr = "tcp", u.Host
		if socket := u.Query().Get("socket"); socket != "" {
			cfg.Net, cfg.Addr = "unix", socket
		}
		if cfg.DBName == "" || cfg.Addr == "" {
			return nil, fmt.Errorf("state DSN must name a database and host or socket")
		}
		return sql.Open("mysql", cfg.FormatDSN())
	case "postgres":
		query := u.Query()
		query.Del("timezone")
		u.RawQuery = query.Encode()
		return sql.Open("pgx", u.String())
	case "sqlite":
		if !strings.HasPrefix(u.Path, "/") || u.Host != "" {
			return nil, fmt.Errorf("state SQLite DSN must use an absolute path")
		}
		query := u.Query()
		query.Del("timezone")
		name := u.Path
		if encoded := query.Encode(); encoded != "" {
			name += "?" + encoded
		}
		return sql.Open("sqlite", name)
	default:
		return nil, fmt.Errorf("unsupported state database %q", driver)
	}
}

func snapshotDatabase(db *sql.DB, driver string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	var namesQuery string
	switch driver {
	case "mysql":
		namesQuery = "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name"
	case "postgres":
		namesQuery = "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = current_schema() ORDER BY tablename"
	case "sqlite":
		namesQuery = "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
	default:
		return "", fmt.Errorf("unsupported state database %q", driver)
	}
	names, err := db.QueryContext(ctx, namesQuery)
	if err != nil {
		return "", err
	}
	tables := []string{}
	for names.Next() {
		var name string
		if err := names.Scan(&name); err != nil {
			names.Close()
			return "", err
		}
		tables = append(tables, name)
	}
	err = names.Err()
	names.Close()
	if err != nil {
		return "", err
	}
	if len(tables) == 0 {
		return "", fmt.Errorf("state database has no tables")
	}
	hash := sha256.New()
	for _, table := range tables {
		quoted := `"` + strings.ReplaceAll(table, `"`, `""`) + `"`
		if driver == "mysql" {
			quoted = "`" + strings.ReplaceAll(table, "`", "``") + "`"
		}
		rows, err := db.QueryContext(ctx, "SELECT * FROM "+quoted)
		if err != nil {
			return "", fmt.Errorf("read state table %s: %w", table, err)
		}
		columns, err := rows.Columns()
		if err != nil {
			rows.Close()
			return "", err
		}
		rowDigests := []string{}
		for rows.Next() {
			values := make([]any, len(columns))
			refs := make([]any, len(columns))
			for i := range values {
				refs[i] = &values[i]
			}
			if err := rows.Scan(refs...); err != nil {
				rows.Close()
				return "", err
			}
			encoded, err := json.Marshal(values)
			if err != nil {
				rows.Close()
				return "", err
			}
			digest := sha256.Sum256(encoded)
			rowDigests = append(rowDigests, hex.EncodeToString(digest[:]))
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return "", err
		}
		sort.Strings(rowDigests)
		encoded, err := json.Marshal([]any{table, columns, rowDigests})
		if err != nil {
			return "", err
		}
		if _, err := hash.Write(encoded); err != nil {
			return "", err
		}
	}
	counters, err := readCounters(db, driver)
	if err != nil {
		return "", err
	}
	keys := make([]string, 0, len(counters))
	for key := range counters {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		value := counters[key]
		fmt.Fprintf(hash, "counter:%s:%d:%t\n", key, value.value, value.called)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
