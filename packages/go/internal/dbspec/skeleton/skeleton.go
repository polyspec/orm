// Package skeleton writes the part of a dbspec document that Mermaid carries, which the Go recipe helper and the dbspec
// compare runner both check a Mermaid round trip by.
package skeleton

import (
	"fmt"
	"slices"
	"strings"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
)

// Mermaid writes the tables, columns, primary keys and foreign keys that Mermaid carries, in table-name order; foreign key
// actions are left out, since Mermaid does not carry them.
func Mermaid(d *dbspec.Document) []string {
	tables := slices.Clone(d.Tables)
	slices.SortFunc(tables, func(a, b dbspec.Table) int { return strings.Compare(a.Name, b.Name) })
	var out []string
	for _, t := range tables {
		out = append(out, "table "+t.Name)
		for _, c := range t.Columns {
			dflt := "-"
			if c.Default != nil {
				dflt = c.Default.Literal
				if c.Default.Now {
					dflt = "now"
				}
			}
			out = append(out, fmt.Sprintf("column %s %s null=%t identity=%t default=%s", c.Name, c.Type, c.Null, c.Identity, dflt))
		}
		out = append(out, "primary key "+strings.Join(t.PrimaryKey.Columns, ", "))
		fks := slices.Clone(t.ForeignKeys)
		slices.SortFunc(fks, func(a, b dbspec.ForeignKey) int { return strings.Compare(a.Name, b.Name) })
		for _, f := range fks {
			out = append(out, "foreign key "+f.Name+" ("+strings.Join(f.Columns, ", ")+") references "+f.Table+" ("+strings.Join(f.References, ", ")+")")
		}
	}
	return out
}
