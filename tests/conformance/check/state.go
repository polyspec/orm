package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"slices"
	"sort"
	"strconv"
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
	ctx, cancel := context.WithTimeout(context.Background(), stateDeadline)
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
		// orm__row_lock은 SQLite client가 연결의 첫 transaction 전에 transaction 밖에서 만드는 ORM의 row lock
		// table이다(docs/usage.md). 그 table은 test가 바꾼 database 상태가 아니라 client가 처음 transaction을 연
		// 흔적이므로 상태에 넣지 않는다.
		if name == "orm__row_lock" {
			continue
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
		// row마다 값을 type과 함께 encode한 byte의 hash를 모으고 정렬해 row 순서와 상관없는 digest를
		// 만든다. 값 encoding은 같은 값에 같은 byte를, 다른 type이나 값에 다른 byte를 낸다.
		values := make([]any, len(columns))
		refs := make([]any, len(columns))
		for i := range values {
			refs[i] = &values[i]
		}
		var encoded []byte
		var rowDigests [][sha256.Size]byte
		for rows.Next() {
			if err := rows.Scan(refs...); err != nil {
				rows.Close()
				return "", err
			}
			encoded = encoded[:0]
			for _, value := range values {
				if encoded, err = appendStateValue(encoded, value); err != nil {
					rows.Close()
					return "", fmt.Errorf("read state table %s: %w", table, err)
				}
			}
			rowDigests = append(rowDigests, sha256.Sum256(encoded))
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return "", err
		}
		slices.SortFunc(rowDigests, func(a, b [sha256.Size]byte) int { return bytes.Compare(a[:], b[:]) })
		header, err := json.Marshal([]any{table, columns, len(rowDigests)})
		if err != nil {
			return "", err
		}
		hash.Write(header)
		for _, digest := range rowDigests {
			hash.Write(digest[:])
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

// appendStateValue는 state digest의 값 하나를 type 표시, 길이와 내용으로 encode한다. driver가
// 돌려주는 type(nil, 정수, 실수, bool, byte, 문자열, 시각)만 받고, 다른 type은 error다.
func appendStateValue(b []byte, value any) ([]byte, error) {
	switch v := value.(type) {
	case nil:
		return append(b, 'n'), nil
	case int64:
		b = append(b, 'i')
		b = strconv.AppendInt(b, v, 10)
		return append(b, ';'), nil
	case float64:
		b = append(b, 'f')
		b = strconv.AppendFloat(b, v, 'g', -1, 64)
		return append(b, ';'), nil
	case bool:
		if v {
			return append(b, 't'), nil
		}
		return append(b, 'F'), nil
	case []byte:
		b = append(b, 'b')
		b = strconv.AppendInt(b, int64(len(v)), 10)
		b = append(b, ':')
		return append(b, v...), nil
	case string:
		b = append(b, 's')
		b = strconv.AppendInt(b, int64(len(v)), 10)
		b = append(b, ':')
		return append(b, v...), nil
	case time.Time:
		b = append(b, 'T')
		b = v.AppendFormat(b, time.RFC3339Nano)
		return append(b, ';'), nil
	default:
		return nil, fmt.Errorf("unsupported state value type %T", value)
	}
}
