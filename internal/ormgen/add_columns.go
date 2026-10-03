package ormgen

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/schema"
)

// Catalog runs the catalog reads of PlanAddColumns on the connection of the
// call: a database, a transaction or one connection of the client.
type Catalog interface {
	Query(query string, args ...any) (*sql.Rows, error)
}

func schemaDiffers(format string, a ...any) error {
	return &ir.Error{Code: "SCHEMA_DIFFERS", Msg: fmt.Sprintf(format, a...)}
}

// PlanAddColumns returns the statements of `utils().schema().addColumns()`:
// they add the missing nullable or defaulted columns of the existing tables of
// a manifest and replace the audit triggers of each changed table. It also
// returns the added columns as table.column in manifest order. The live tables
// of the manifest are read through the import on q, with the column facts that
// the catalog does not hold (bool, int, lazy and styles) taken from the
// manifest; pool runs the CHECK expression probes. Every other difference
// between those tables and the manifest returns SCHEMA_DIFFERS.
func PlanAddColumns(ctx context.Context, q Catalog, pool *sql.DB, driver string, want *schema.Manifest) ([]string, []string, error) {
	physical := map[string]string{}
	only := map[string]bool{}
	for _, name := range want.Order {
		table := want.Entities[name].Table
		if driver != "sqlite" && strings.Contains(table, ".") {
			return nil, nil, &ir.Error{Code: "CAPABILITY_UNSUPPORTED", Msg: "addColumns reads the tables of the connected schema; table " + table + " is qualified"}
		}
		physical[name] = ddlTable(table, driver)
		only[physical[name]] = true
	}
	live, err := readTables(q, driver, only)
	if err != nil {
		return nil, nil, err
	}
	if len(live) == 0 {
		return nil, nil, nil
	}
	d, err := schema.Parse(renderMermaid(live, addColumnsFacts(want, physical)))
	if err != nil {
		return nil, nil, schemaDiffers("the existing tables of the manifest cannot be read as a manifest: %v", err)
	}
	read, err := schema.BuildMigrationSource(d)
	if err != nil {
		return nil, nil, schemaDiffers("the existing tables of the manifest cannot be read as a manifest: %v", err)
	}
	byTable := map[string]*schema.Entity{}
	for _, e := range read.Entities {
		byTable[e.Table] = e
	}
	current := addColumnsTables(read)
	declared := addColumnsTables(want)
	for _, name := range want.Order {
		e := byTable[physical[name]]
		if e == nil {
			continue
		}
		e.Name, e.Table = name, want.Entities[name].Table
		current.Order = append(current.Order, name)
		current.Entities[name] = e
		declared.Order = append(declared.Order, name)
		declared.Entities[name] = want.Entities[name]
	}
	if current, err = addColumnsReload(current); err != nil {
		return nil, nil, err
	}
	if declared, err = addColumnsReload(declared); err != nil {
		return nil, nil, err
	}
	if err := alignLiveChecks(ctx, pool, driver, current, declared); err != nil {
		var coded *ir.Error
		if errors.As(err, &coded) {
			return nil, nil, err
		}
		return nil, nil, schemaDiffers("compare the checks of the existing tables: %v", err)
	}
	addColumnsAlignDefaults(current, declared)
	addColumnsAlignTypes(current, declared, driver)
	addColumnsAlignIndexes(current, declared, driver)
	expanded := addColumnsTables(current)
	var added, missing []string
	changed := map[string]bool{}
	for _, name := range declared.Order {
		we := declared.Entities[name]
		liveColumns := map[string]*schema.Col{}
		for _, c := range current.Entities[name].Columns {
			liveColumns[c.Name] = c
		}
		var columns []*schema.Col
		for _, wc := range we.Columns {
			switch lc := liveColumns[wc.Name]; {
			case lc != nil:
				columns = append(columns, lc)
				delete(liveColumns, wc.Name)
			case wc.Auto || (!wc.Nullable && wc.Default == nil):
				missing = append(missing, we.Table+"."+wc.Name)
			default:
				columns = append(columns, wc)
				added = append(added, we.Table+"."+wc.Name)
				changed[we.Table] = true
			}
		}
		for _, c := range current.Entities[name].Columns {
			if liveColumns[c.Name] != nil {
				columns = append(columns, c)
			}
		}
		e := *current.Entities[name]
		e.Columns = columns
		expanded.Order = append(expanded.Order, name)
		expanded.Entities[name] = &e
	}
	if len(missing) > 0 {
		return nil, nil, schemaDiffers("addColumns adds only nullable or defaulted columns; required columns: %s", strings.Join(missing, ", "))
	}
	if expanded, err = addColumnsReload(expanded); err != nil {
		return nil, nil, err
	}
	text, err := renderDiff(expanded, declared, driver, true)
	if err != nil {
		return nil, nil, schemaDiffers("the existing tables differ from the manifest: %v", err)
	}
	if differences := splitSQL(text); len(differences) > 0 {
		return nil, nil, schemaDiffers("the existing tables differ from the manifest beyond missing columns: %s", strings.Join(differences, " "))
	}
	if len(added) == 0 {
		return nil, nil, nil
	}
	text, err = renderDiff(current, expanded, driver, false)
	if err != nil {
		return nil, nil, schemaDiffers("add columns: %v", err)
	}
	statements := splitSQL(text)
	objects, err := triggerObjects(want, driver)
	if err != nil {
		return nil, nil, err
	}
	for _, o := range objects {
		if o.kind == "audit" && changed[o.table] {
			statements = append(statements, o.create...)
		}
	}
	return statements, added, nil
}

// addColumnsTables returns a manifest with no tables and no triggers that
// keeps the ORM directives and external keys of m.
func addColumnsTables(m *schema.Manifest) *schema.Manifest {
	return &schema.Manifest{Entities: map[string]*schema.Entity{}, ORM: m.ORM, ExternalFKs: m.ExternalFKs}
}

// addColumnsReload gives a derived manifest the hash of its content and the
// column index of a loaded manifest.
func addColumnsReload(m *schema.Manifest) (*schema.Manifest, error) {
	m.Rehash()
	b, err := json.Marshal(m)
	if err != nil {
		return nil, &ir.Error{Code: "INTERNAL", Msg: err.Error()}
	}
	out, err := schema.Load(b)
	if err != nil {
		return nil, &ir.Error{Code: "INTERNAL", Msg: err.Error()}
	}
	return out, nil
}

// addColumnsFacts returns the column facts of the manifest that the catalog
// does not hold, as the previous diagram of the import; entities are named by
// their tables.
func addColumnsFacts(want *schema.Manifest, physical map[string]string) *schema.Diagram {
	d := &schema.Diagram{}
	for _, name := range want.Order {
		e := &schema.DEntity{Name: physical[name]}
		for _, c := range want.Entities[name].Columns {
			e.Columns = append(e.Columns, &schema.DColumn{
				Name: c.Name, Lazy: c.Lazy, Bool: c.Type == "bool", Styles: append([]string(nil), c.Styles...),
				Int: strings.HasPrefix(strings.ToLower(c.Raw), "tinyint") && c.Type != "bool" && strings.HasPrefix(c.Name, "is_"),
			})
		}
		d.Entities = append(d.Entities, e)
	}
	return d
}

var addColumnsDecimal = regexp.MustCompile(`^-?[0-9]+\.[0-9]+$`)

// addColumnsDefaultText returns a default without its string quotes, and a
// number without trailing fraction zeros.
func addColumnsDefaultText(d string) string {
	if len(d) >= 2 && strings.HasPrefix(d, "'") && strings.HasSuffix(d, "'") {
		d = strings.ReplaceAll(d[1:len(d)-1], "''", "'")
	}
	if addColumnsDecimal.MatchString(d) {
		d = strings.TrimSuffix(strings.TrimRight(d, "0"), ".")
	}
	if d == "-0" {
		return "0"
	}
	return d
}

// addColumnsAlignDefaults replaces the default of every live column whose
// catalog text is equivalent to the declared default with the declared text:
// the import reads a string default with its quotes and a decimal default with
// the digits of its scale, so a diff reports only real changes.
func addColumnsAlignDefaults(current, declared *schema.Manifest) {
	for _, name := range declared.Order {
		for _, c := range current.Entities[name].Columns {
			d := declared.Entities[name].Column(c.Name)
			if d == nil || c.Default == nil || d.Default == nil || *c.Default == *d.Default {
				continue
			}
			if addColumnsDefaultText(*c.Default) == addColumnsDefaultText(*d.Default) {
				value := *d.Default
				c.Default = &value
			}
		}
	}
}

// addColumnsAlignTypes gives every live column whose type the dialect stores
// as the declared type the declared type: PostgreSQL stores char(n) as
// varchar(n) and every blob type as bytea, so the import cannot read the
// declared raw type back. SQLite compares storage classes in the diff itself.
func addColumnsAlignTypes(current, declared *schema.Manifest, driver string) {
	if driver == "sqlite" {
		return
	}
	for _, name := range declared.Order {
		for _, c := range current.Entities[name].Columns {
			d := declared.Entities[name].Column(c.Name)
			if d == nil {
				continue
			}
			lt, lr, ll := columnStorage(c, driver)
			dt, dr, dl := columnStorage(d, driver)
			if lt == dt && lr == dr && ll == dl {
				continue
			}
			live, err := ddlType(c, driver)
			if err != nil {
				continue
			}
			want, err := ddlType(d, driver)
			if err != nil || live != want {
				continue
			}
			c.Type, c.Raw, c.Len, c.Precision, c.Scale, c.Unsigned = d.Type, d.Raw, d.Len, d.Precision, d.Scale, d.Unsigned
			c.Enum = append([]string(nil), d.Enum...)
		}
	}
}

// addColumnsAlignIndexes gives every live index whose physical name is the
// physical name of a declared index the declared name: a name longer than the
// identifier limit of the dialect is stored cut with a digest, which the import
// cannot read back.
func addColumnsAlignIndexes(current, declared *schema.Manifest, driver string) {
	for _, name := range declared.Order {
		e := current.Entities[name]
		if len(e.Indexes) == 0 {
			continue
		}
		table := declared.Entities[name].Table
		byPhysical := map[string]string{}
		for index := range declared.Entities[name].Indexes {
			byPhysical[ddlIndexName(table, index, driver)] = index
		}
		named := map[string][]string{}
		for index, columns := range e.Indexes {
			if declaredName, ok := byPhysical[ddlIndexName(table, index, driver)]; ok {
				index = declaredName
			}
			named[index] = columns
		}
		e.Indexes = named
	}
}
