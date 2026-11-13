package recipe

import (
	"fmt"
	"slices"

	"github.com/polyspec/orm/legacy/packages/go/engine/dbspec"
	"github.com/polyspec/orm/legacy/packages/go/engine/runtimemodel"
)

// renderStatements runs one dbspec.render_statements step: it parses each document of the case against the others and
// renders the set for each dialect, in the given order and reversed, to exactly the statements of the case (FCV-4, DIA-113).
func renderStatements(s step, dir string) error {
	vector, err := ddlVectorCase(dir, s.k("vectors").Vectors, s.k("case").Case)
	if err != nil {
		return err
	}
	names := make([]string, 0, len(vector.Documents))
	for name := range vector.Documents {
		names = append(names, name)
	}
	slices.Sort(names)
	documents := make([]*dbspec.Document, 0, len(names))
	for _, name := range names {
		set := map[string]string{}
		for other, lines := range vector.Documents {
			if other != name {
				set[other] = linesText(lines)
			}
		}
		document, _, diagnostics := dbspec.Parse(linesText(vector.Documents[name]), set)
		if len(diagnostics) > 0 {
			return fmt.Errorf("%s: %s", name, runtimemodel.DiagnosticsError(diagnostics))
		}
		documents = append(documents, document)
	}
	reversed := slices.Clone(documents)
	slices.Reverse(reversed)
	for _, dialect := range []dbspec.Dialect{dbspec.DialectMySQL, dbspec.DialectPostgres, dbspec.DialectSQLite} {
		want, ok := vector.Statements[string(dialect)]
		if !ok || len(want) == 0 {
			return fmt.Errorf("the case %s has no statements for %s", vector.ID, dialect)
		}
		for _, given := range [][]*dbspec.Document{documents, reversed} {
			got, diagnostics := dbspec.Render(given, dialect)
			if len(diagnostics) > 0 {
				return fmt.Errorf("%s: %s", dialect, runtimemodel.DiagnosticsError(diagnostics))
			}
			if !slices.Equal(got, want) {
				return fmt.Errorf("%s statements\n got %q\nwant %q", dialect, got, want)
			}
		}
	}
	return nil
}
