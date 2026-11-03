package dbspec

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/testcase"
)

// These cases cover rules and canonical forms that the recipes of tests/dbspec
// do not cover yet. Each document is written with LF line ends.

type ruleCase struct {
	id     string
	lines  []string
	set    map[string][]string
	errors []vectorError
}

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

// users is a valid table block used by many cases.
var users = []string{"table users {", "  id i64 identity", "  primary key (id)", "}"}

func with(lines ...[]string) []string {
	out := []string{"dbspec 1 shop", ""}
	for _, l := range lines {
		out = append(out, l...)
	}
	return out
}

func block(lines ...string) []string { return lines }

var core = map[string][]string{"core": {"dbspec 1 core", "", "table accounts {", "  id i64 identity", "  code varchar(8)", "  primary key (id)", "  unique uq_accounts_code (code)", "}"}}

func seventeenColumns() []string {
	lines := []string{"table wide {"}
	var names []string
	for i := 0; i < 17; i++ {
		name := fmt.Sprintf("c%d", i)
		lines = append(lines, "  "+name+" i32")
		names = append(names, name)
	}
	return append(lines, "  primary key ("+strings.Join(names, ", ")+")", "}")
}

// TestEncodingDiagnostics holds the texts that the line form of a JSON recipe cannot write: an empty text and one that is not a sequence of Unicode scalar values (FCV-2).
// Requirements: DBS-144.
func TestEncodingDiagnostics(t *testing.T) {
	testcase.Start(t, testcase.Compute)
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
			runTimed(t, c.id, 10*time.Second, func() error {
				return expectDiagnostics(c.text, nil, c.want)
			})
		})
	}
}

// TestParseReturnsModel checks the model fields of a parsed document.
func TestParseReturnsModel(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	runTimed(t, "model", 5*time.Second, func() error {
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

func TestStateMachineSetting(t *testing.T) {
	cases := []ruleCase{
		{id: "setting-state-machine", lines: with(block(
			"table jobs {",
			"  id i64 identity",
			"  status varchar(16)",
			"  evidence text null",
			"  primary key (id)",
			"  settings {",
			"    state_machine status waiting -> doing",
			"    state_machine status doing -> done require (evidence)",
			"    state_machine status terminal done require (evidence)",
			"  }",
			"}",
		))},
	}
	testcase.Start(t, testcase.Compute)
	text := joinLines(cases[0].lines, false)
	document := parseStable(t, text)
	machine := document.Tables[0].Settings.StateMachine
	if machine == nil || machine.Column != "status" || len(machine.Lines) != 3 ||
		machine.Lines[1].From != "doing" || machine.Lines[1].To != "done" ||
		len(machine.Lines[1].Requires) != 1 || machine.Lines[1].Requires[0] != "evidence" ||
		!machine.Lines[2].Terminal || machine.Lines[2].State != "done" {
		t.Fatalf("machine: %+v", machine)
	}
}

// markdown: the manifest trait that names a markdown prose column.
func TestMarkdownSetting(t *testing.T) {
	testcase.Start(t, testcase.Compute)
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
	"  status varchar(16)",
	"  reason varchar(200) null",
}

// historyColumns are the columns of the ticket_history table that state_machine history names.
var historyColumns = []string{
	"  id i64 identity",
	"  ticket_id varchar(32)",
	"  from_status varchar(16)",
	"  to_status varchar(16)",
	"  changed_at datetime(6)",
	"  reason varchar(200) null",
}

// ticketHistory writes a ticket_history table with the given columns, key, and foreign key, an index leading the foreign key, and a foreign key that points to tickets.
func ticketHistory(columns []string) []string {
	out := []string{"table ticket_history {"}
	out = append(out, columns...)
	return append(out,
		"  primary key (id)",
		"  index ix_ticket_history_ticket (ticket_id)",
		"  foreign key fk_ticket_history_ticket (ticket_id) references tickets (id) on delete restrict on update restrict",
		"}",
	)
}

// markdownDoc writes the tickets table with the given columns, key lines, and settings, and then writes the history table. Each setting is indented inside the settings block.
func markdownDoc(columns, key, history []string, settings ...string) []string {
	body := []string{"table tickets {"}
	body = append(body, columns...)
	body = append(body, key...)
	body = append(body, "  settings {")
	for _, s := range settings {
		body = append(body, "    "+s)
	}
	body = append(body, "  }", "}")
	return with(body, []string{""}, history)
}

var (
	pkID             = []string{"  primary key (id)"}
	standardHistory  = ticketHistory(historyColumns)
	markdownSettings = []string{
		"store document list",
		"key_prefix 'T'",
		"title title",
		"body body",
		"order position",
		"checkbox status waiting '-'",
		"checkbox status doing '/'",
		"checkbox status done 'x'",
		"state_machine status initial waiting",
		"state_machine status waiting -> doing",
		"state_machine status doing -> done require (reason)",
		"state_machine status terminal done",
		"state_machine status history ticket_history row ticket_id from from_status to to_status at changed_at",
		"state_machine status limit doing 3",
	}
)

// TestMarkdownStorageSetting: the storage, key, title, body, order, checkbox, and state_machine settings of markdown storage are parsed, emitted canonically, and reach the settings model.
func TestMarkdownStorageSetting(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	text := joinLines(markdownDoc(markdownColumns, pkID, standardHistory, markdownSettings...), false)
	document := parseStable(t, text)
	s := document.Tables[0].Settings
	if s.Store == nil || s.Store.Kind != "document" || s.Store.Shape != "list" {
		t.Fatalf("store: %+v", s.Store)
	}
	if s.KeyPrefix == nil || s.KeyPrefix.Prefix != "T" || s.Title == nil || s.Title.Column != "title" ||
		s.Body == nil || s.Body.Column != "body" || s.Order == nil || s.Order.Column != "position" {
		t.Fatalf("key, title, body or order: %+v %+v %+v %+v", s.KeyPrefix, s.Title, s.Body, s.Order)
	}
	if len(s.Checkboxes) != 3 || s.Checkboxes[1].State != "doing" || s.Checkboxes[1].Glyph != "/" {
		t.Fatalf("checkboxes: %+v", s.Checkboxes)
	}
	machine := s.StateMachine
	if machine == nil || len(machine.Lines) != 4 || !machine.Lines[0].Initial || machine.Lines[0].State != "waiting" ||
		machine.History == nil || machine.History.Table != "ticket_history" || machine.History.At != "changed_at" ||
		len(machine.Limits) != 1 || machine.Limits[0].State != "doing" || machine.Limits[0].Count != 3 {
		t.Fatalf("machine: %+v", machine)
	}
}

// TestStateMachineKeywordStates: a state with the same name as a state_machine line keyword is still a transition state when a transition arrow follows it.
func TestStateMachineKeywordStates(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	text := joinLines(with(block(
		"table jobs {", "  id i64 identity", "  status varchar(16)", "  primary key (id)",
		"  settings {",
		"    state_machine status initial -> waiting",
		"    state_machine status limit -> history",
		"    state_machine status initial initial",
		"  }", "}",
	)), false)
	document := parseStable(t, text)
	lines := document.Tables[0].Settings.StateMachine.Lines
	if len(lines) != 3 || lines[0].From != "initial" || lines[0].Initial || lines[1].From != "limit" ||
		lines[1].To != "history" || !lines[2].Initial || lines[2].State != "initial" {
		t.Fatalf("lines: %+v", lines)
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
