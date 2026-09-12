// seedaes fills the AES columns of the bench battle table on PostgreSQL and
// SQLite with the authenticated host format used by every client.
//
//	go run ./bench/seedaes -driver postgres -dsn 'postgres://maxkwon@localhost:5432/orm_bench?sslmode=disable'
//	go run ./bench/seedaes -driver sqlite -dsn 'file:/tmp/orm_bench.sqlite'
package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"os"

	_ "github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"

	"github.com/polyspec/orm/clients/go/orm"
)

func main() {
	driver := flag.String("driver", "postgres", "postgres|sqlite")
	dsn := flag.String("dsn", "", "database URL")
	key := flag.String("key", "bench-salt", "aes key")
	version := flag.Int("version", 1, "AES key version")
	flag.Parse()
	sqlDriver := map[string]string{"mysql": "mysql", "postgres": "pgx", "sqlite": "sqlite"}[*driver]
	if sqlDriver == "" || *dsn == "" {
		fmt.Fprintln(os.Stderr, "usage: seedaes -driver mysql|postgres|sqlite -dsn <url> [-key k] [-version n]")
		os.Exit(2)
	}
	db, err := sql.Open(sqlDriver, *dsn)
	if err != nil {
		fail(err)
	}
	ctx := context.Background()
	ph := func(n int) string {
		if *driver == "postgres" {
			return fmt.Sprintf("$%d", n)
		}
		return "?"
	}
	quote := func(name string) string {
		if *driver == "mysql" {
			return "`" + name + "`"
		}
		return `"` + name + `"`
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		fail(err)
	}
	st, err := tx.PrepareContext(ctx, fmt.Sprintf("UPDATE %s SET %s = %s, %s = %s, %s = %s WHERE %s = %s", quote("battle"), quote("aes_hex_email"), ph(1), quote("aes_hex_phone"), ph(2), quote("aes_key_version"), ph(3), quote("seq"), ph(4)))
	if err != nil {
		fail(err)
	}
	for i := 1; i <= 100000; i++ {
		email, err := orm.HostEncode(fmt.Sprintf("user%d@example.com", i), []string{"aes", "hex"}, *key)
		if err != nil {
			fail(err)
		}
		phone, err := orm.HostEncode(fmt.Sprintf("010-%08d", i), []string{"aes", "hex"}, *key)
		if err != nil {
			fail(err)
		}
		if _, err := st.ExecContext(ctx, email, phone, *version, i); err != nil {
			fail(err)
		}
	}
	if err := tx.Commit(); err != nil {
		fail(err)
	}
	fmt.Fprintln(os.Stderr, "seedaes: 100000 rows updated")
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "seedaes:", err)
	os.Exit(1)
}
