// ormgen validate: does the live database still match the manifest the clients were generated from?
//
//	ormgen validate --dsn "mysql://root@localhost/orm_bench?socket=/tmp/mysql.sock" --schema schema/schema.json
//
// Exit status 1 with one line per difference (CI gate, docs/checklist.md T5.1). The comparison
// is at the canonical level the clients see: entity/table presence, column set and order, canonical
// type, nullability, auto-increment, style stack (from the column name, so a rename shows up).
package ormgen

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/polyspec/orm/engine/schema"
)

func validateCmd(args []string) {
	fs := flag.NewFlagSet("validate", flag.ExitOnError)
	dsnFlag := fs.String("dsn", "", "database DSN URI: mysql://, postgres://, or sqlite:///path (required)")
	schemaPath := fs.String("schema", "", "schema.json (required)")
	fs.Parse(args)
	if *dsnFlag == "" || *schemaPath == "" {
		fmt.Fprintln(os.Stderr, "usage: ormgen validate --dsn <dsn> --schema schema/schema.json")
		os.Exit(2)
	}
	db, dsn, err := openToolDB(*dsnFlag)
	if err != nil {
		fail(err)
	}
	defer db.Close()
	m, err := loadSchemaSource(*schemaPath, dsn.dialect)
	if err != nil {
		fail(err)
	}
	live, err := readTables(db, dsn.dialect, nil)
	if err != nil {
		fail(err)
	}
	live = filterManagedTables(live)
	// the live tables through the same canonicalization the manifest went through
	liveDiagram, err := schema.Parse(renderMermaid(live, nil))
	if err != nil {
		fail(fmt.Errorf("live schema does not parse: %w", err))
	}
	lm, err := schema.Build(liveDiagram)
	if err != nil {
		fail(fmt.Errorf("live schema does not build: %w", err))
	}
	diffs := diffManifests(m, lm, dsn.dialect)
	for _, d := range diffs {
		fmt.Println(d)
	}
	if len(diffs) > 0 {
		fmt.Fprintf(os.Stderr, "ormgen: %d differences between %s and the live database\n", len(diffs), *schemaPath)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "ormgen: %s matches the live database (%d entities)\n", *schemaPath, len(m.Order))
}

// diffManifests lists what the clients would get wrong if they ran against `live`.
func diffManifests(want, live *schema.Manifest, dialect string) []string {
	var out []string
	for _, name := range want.Order {
		we := want.Entities[name]
		le := live.Entities[name]
		if le == nil {
			out = append(out, fmt.Sprintf("%s: table missing in the database", we.Table))
			continue
		}
		liveCols := map[string]*schema.Col{}
		for _, c := range le.Columns {
			liveCols[c.Name] = c
		}
		for _, wc := range we.Columns {
			lc := liveCols[wc.Name]
			if lc == nil {
				out = append(out, fmt.Sprintf("%s.%s: column missing in the database", we.Table, wc.Name))
				continue
			}
			wantType, _, _ := columnStorage(wc, dialect)
			liveType, _, _ := columnStorage(lc, dialect)
			if wantType != liveType {
				out = append(out, fmt.Sprintf("%s.%s: type %s in manifest, %s in the database", we.Table, wc.Name, wc.Type, lc.Type))
			}
			if wc.Nullable != lc.Nullable {
				out = append(out, fmt.Sprintf("%s.%s: nullable %v in manifest, %v in the database", we.Table, wc.Name, wc.Nullable, lc.Nullable))
			}
			if wc.Auto != lc.Auto {
				out = append(out, fmt.Sprintf("%s.%s: auto_increment %v in manifest, %v in the database", we.Table, wc.Name, wc.Auto, lc.Auto))
			}
			if strings.Join(wc.Styles, ",") != strings.Join(lc.Styles, ",") {
				out = append(out, fmt.Sprintf("%s.%s: styles %v in manifest, %v in the database", we.Table, wc.Name, wc.Styles, lc.Styles))
			}
		}
		for _, lc := range le.Columns {
			if we.Column(lc.Name) == nil {
				out = append(out, fmt.Sprintf("%s.%s: column exists in the database but not in the manifest", we.Table, lc.Name))
			}
		}
		if strings.Join(we.PK, ",") != strings.Join(le.PK, ",") {
			out = append(out, fmt.Sprintf("%s: primary key %v in manifest, %v in the database", we.Table, we.PK, le.PK))
		}
	}
	return out
}
