package engine

import (
	"testing"

	"github.com/polyspec/orm/packages/go/engine/dialect"
	"github.com/polyspec/orm/packages/go/engine/plan"
)

// TestFulltextSearch checks the full-text predicates (PRT-75): the boolean normalization of DIA-6 and the match each dialect
// renders over the columns, with SQLite refusing the predicate (DIA-187).
func TestFulltextSearch(t *testing.T) {
	cases := map[string]string{
		"alpha beta":           "+alpha +beta*",
		"  +a  (b) \"c\"  ":    "+a +b +c*",
		"one ~ two":            "+one +two*",
		"":                     "",
		"  \t ":                "",
		"+ - < > ( ) ~ * \" @": "",
	}
	for in, want := range cases {
		if got := plan.FulltextBoolean(in); got != want {
			t.Errorf("FulltextBoolean(%q) = %q, want %q", in, got, want)
		}
	}

	value := func(transform string) string { return "$[" + transform + "]" }
	cols := []string{"p.name", "p.description"}

	mysql, ok := dialect.MySQL{}.Fulltext(cols, value, true)
	if !ok || mysql != "MATCH (p.name, p.description) AGAINST ($[fulltext_boolean] IN BOOLEAN MODE)" {
		t.Errorf("MySQL boolean = %q, %v", mysql, ok)
	}
	mysql, ok = dialect.MySQL{}.Fulltext(cols, value, false)
	if !ok || mysql != "MATCH (p.name, p.description) AGAINST ($[] IN NATURAL LANGUAGE MODE)" {
		t.Errorf("MySQL natural = %q, %v", mysql, ok)
	}

	pg, ok := dialect.Postgres{}.Fulltext(cols, value, false)
	if !ok || pg != "to_tsvector('simple', coalesce(p.name, '') || ' ' || coalesce(p.description, '')) @@ plainto_tsquery('simple', $[])" {
		t.Errorf("PostgreSQL natural = %q, %v", pg, ok)
	}
	pg, ok = dialect.Postgres{}.Fulltext(cols, value, true)
	if !ok || pg != "to_tsvector('simple', coalesce(p.name, '') || ' ' || coalesce(p.description, '')) @@ websearch_to_tsquery('simple', $[])" {
		t.Errorf("PostgreSQL boolean = %q, %v", pg, ok)
	}

	if sql, ok := (dialect.SQLite{}).Fulltext(cols, value, true); ok || sql != "" {
		t.Errorf("SQLite must refuse the predicate, got %q, %v", sql, ok)
	}
}
