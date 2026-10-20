// Command go introspects one database with the Go engine and writes it in the output format of tests/dbspec/introspect:
// the canonical document on stdout and the unsupported object lines
// "! kind<TAB>table<TAB>name", and on stderr a "reason ..." line per unsupported object and an "elapsed <ms>" line.
//
// Usage: go run ./packages/go/internal/dbspec/introspect <mysql|postgres|sqlite> <uri>
package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
	"github.com/polyspec/orm/packages/go/internal/dbspec/database"
	"github.com/polyspec/orm/packages/go/testcase"
)

// main ends with the exit code of run. os.Exit does not run defers, so it is not called inside run: a failed
// fail is raised up to run as an exit panic, and the defers in between (closing connections) run.
func main() {
	os.Exit(run())
}

func run() (code int) {
	defer testcase.CatchExit(&code)
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: go run ./packages/go/internal/dbspec/introspect <mysql|postgres|sqlite> <uri>")
		return 2
	}
	dialect, uri := os.Args[1], os.Args[2]
	db, err := database.Open(dialect, uri)
	if err != nil {
		fail(err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			fail(err)
		}
	}()
	start := time.Now()
	document, unsupported, err := dbspec.Introspect(context.Background(), db, dbspec.Dialect(dialect), "introspected")
	if err != nil {
		fail(err)
	}
	elapsed := time.Since(start)
	var b strings.Builder
	b.WriteString(dbspec.Emit(document))
	for _, u := range unsupported {
		fmt.Fprintf(&b, "! %s\t%s\t%s\n", u.Kind, u.Table, u.Name)
		fmt.Fprintf(os.Stderr, "reason %s %s %s: %s\n", u.Kind, u.Table, u.Name, u.Reason)
	}
	if _, err := os.Stdout.WriteString(b.String()); err != nil {
		fail(err)
	}
	fmt.Fprintf(os.Stderr, "elapsed %.1f\n", float64(elapsed.Microseconds())/1000)
	return 0
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "introspect:", err)
	panic(testcase.Exit(1))
}
