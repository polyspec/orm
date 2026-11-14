package dbspec

import (
	"fmt"
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// These cases cover rules and canonical forms that the recipes of tests/dbspec
// do not cover yet. Each document is written with LF line ends.

func errs(spec ...any) []vectorError {
	var out []vectorError
	for i := 0; i < len(spec); i += 3 {
		out = append(out, vectorError{Line: asFixture[int](spec[i]), Column: asFixture[int](spec[i+1]), Rule: asFixture[string](spec[i+2])})
	}
	return out
}

func docSet(set map[string][]string) map[string]string {
	out := map[string]string{}
	for name, lines := range set {
		out[name] = joinLines(lines, false)
	}
	return out
}

func with(lines ...[]string) []string {
	out := []string{"dbspec 1 shop", ""}
	for _, l := range lines {
		out = append(out, l...)
	}
	return out
}

func block(lines ...string) []string { return lines }

var core = map[string][]string{"core": {"dbspec 1 core", "", "table accounts {", "  id i64 identity", "  code varchar(8)", "  primary key (id)", "  unique uq_accounts_code (code)", "}"}}

// TestEncodingDiagnostics holds the texts that the line form of a JSON recipe cannot write: an empty text and one that is not a sequence of Unicode scalar values (FCV-2).
// Requirements: DBS-144.
func TestEncodingDiagnostics(t *testing.T) {
	testcase.Start(t)
	cases := []struct {
		id   string
		text string
		want []vectorError
	}{
		{"empty-document", "", errs(1, 1, RuleHeader)},
		{"invalid-utf8", "dbspec 1 shop\n# caf\xe9\n", errs(2, 6, RuleEncoding)},
		{"encoding-after-earlier-errors", "dbspec 1 shop\ntable T {\n  id i64 identity\n  bad\xff i32\n", errs(2, 7, RuleNameFormat, 4, 6, RuleEncoding)},
	}
	for _, c := range cases {
		t.Run(c.id, func(t *testing.T) {
			runTimed(t, c.id, func() error {
				return expectDiagnostics(c.text, nil, c.want)
			})
		})
	}
}

// TestParseReturnsModel checks the model fields of a parsed document.
func TestParseReturnsModel(t *testing.T) {
	testcase.Start(t)
	runTimed(t, "model", func() error {
		text := joinLines(with(block("use core { accounts }", ""), block("table orders {", "  id i64 identity", "  account_id i64 null",
			"  total decimal(13,2) default 1", "  primary key (id)", "  index ix_account (account_id desc)",
			"  foreign key fk_account (account_id) references accounts (id) on delete set_null", "}")), false)
		document, _, diagnostics := Parse(text, docSet(core))
		if err := expectDocument(document, diagnostics); err != nil {
			return err
		}
		table := document.Tables[0]
		total := table.Columns[2]
		fk := table.ForeignKeys[0]
		switch {
		case document.Name != "shop" || len(document.Uses) != 1 || document.Uses[0].Document != "core":
			return fmt.Errorf("document = %+v", document)
		case total.Type != (Type{Kind: TypeDecimal, Precision: 13, Scale: 2}) || total.Default == nil || total.Default.Literal != "1.00":
			return fmt.Errorf("total column = %+v default %+v", total, total.Default)
		case !table.Columns[0].Identity || !table.Columns[1].Null || !table.Indexes[0].Columns[0].Descending:
			return fmt.Errorf("table = %+v", table)
		case fk.Table != "accounts" || fk.OnDelete != ActionSetNull || fk.OnUpdate != ActionRestrict:
			return fmt.Errorf("foreign key = %+v", fk)
		}
		return nil
	})
}

// markdown: the manifest trait that names a markdown prose column.
func TestMarkdownSetting(t *testing.T) {
	testcase.Start(t)
	text := joinLines(with(block(
		"table pages {",
		"  id i64 identity",
		"  body text null",
		"  note varchar(200)",
		"  primary key (id)",
		"  settings {",
		"    markdown body",
		"    markdown note",
		"  }",
		"}",
	)), false)
	document := parseStable(t, text)
	trait := document.Tables[0].Settings.Marks
	if len(trait) != 2 || trait[0].Column != "body" || trait[1].Column != "note" {
		t.Fatalf("marks: %+v", trait)
	}
}

// markdownColumns are the columns of the tickets table shared by the markdown storage cases.
var markdownColumns = []string{
	"  id varchar(32)",
	"  title varchar(255)",
	"  body text",
	"  position i64",
	"  status varchar(1)",
	"  reason varchar(200) null",
}

// ticketHistory is the ticket_history table, an ordinary child table of tickets.
var ticketHistory = []string{
	"table ticket_history {",
	"  id i64 identity",
	"  ticket_id varchar(32)",
	"  from_status varchar(16)",
	"  to_status varchar(16)",
	"  changed_at datetime(6)",
	"  reason varchar(200) null",
	"  primary key (id)",
	"  index ix_ticket_history_ticket (ticket_id)",
	"  foreign key fk_ticket_history_ticket (ticket_id) references tickets (id) on delete restrict on update restrict",
	"}",
}

// markdownDoc writes the tickets table with the given columns, key lines, and settings, and then the ticket_history
// table. Each setting is indented inside the settings block.
func markdownDoc(columns, key []string, settings ...string) []string {
	body := []string{"table tickets {"}
	body = append(body, columns...)
	body = append(body, key...)
	body = append(body, "  settings {")
	for _, s := range settings {
		body = append(body, "    "+s)
	}
	body = append(body, "  }", "}")
	return with(body, []string{""}, ticketHistory)
}

var (
	pkID             = []string{"  primary key (id)"}
	markdownSettings = []string{
		"store document list",
		"title title",
		"body body",
		"order position",
		"task_marker status",
	}
)

// TestMarkdownStorageSetting: the storage, title, body, order, and task_marker settings of markdown storage are parsed, emitted canonically, and reach the settings model.
func TestMarkdownStorageSetting(t *testing.T) {
	testcase.Start(t)
	text := joinLines(markdownDoc(markdownColumns, pkID, markdownSettings...), false)
	document := parseStable(t, text)
	s := document.Tables[0].Settings
	if s.Store == nil || s.Store.Kind != "document" || s.Store.Shape != "list" {
		t.Fatalf("store: %+v", s.Store)
	}
	if s.Title == nil || s.Title.Column != "title" ||
		s.Body == nil || s.Body.Column != "body" || s.Order == nil || s.Order.Column != "position" {
		t.Fatalf("title, body or order: %+v %+v %+v", s.Title, s.Body, s.Order)
	}
	if s.TaskMarker == nil || s.TaskMarker.Column != "status" {
		t.Fatalf("task_marker: %+v", s.TaskMarker)
	}
}

// parseStable parses text, which must be a document without diagnostics, and
// checks that its emission is text itself.
func parseStable(t *testing.T, text string) *Document {
	t.Helper()
	document, _, diagnostics := Parse(text, nil)
	if document == nil || len(diagnostics) != 0 {
		t.Fatalf("diagnostics: %+v", diagnostics)
	}
	if got, err := emitStable(text, nil); err != nil || got != text {
		t.Fatalf("emission: %v\n%s", err, got)
	}
	return document
}
