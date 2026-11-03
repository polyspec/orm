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

// TestCanonicalForms checks literal, expression, comment and ordering forms.
func TestCanonicalForms(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	cases := []struct {
		id    string
		input []string
		set   map[string][]string
		want  []string
	}{
		{
			id: "literal-forms",
			input: with(block("table v {", "  id i64 identity",
				"  a i16 default -0", "  b i32 default 007", "  c i64 default -9223372036854775808", "  d bool default false",
				"  e decimal(5,2) default -0.5", "  f decimal(4,0) default 0012", "  g f64 default 0001.2500", "  h f64 default -0.0",
				"  i varchar(8) default 'it''s'", "  j uuid default '0E2B5D7A-0000-4000-8000-00000000000A'", "  k date default '0001-01-01'",
				"  l time(3) default '23:59:59.5'", "  m datetime(6) default '2026-01-01 00:00:00'", "  n time(3) default '12:00:00'",
				"  primary key (id)", "}")),
			want: with(block("table v {", "  id i64 identity",
				"  a i16 default 0", "  b i32 default 7", "  c i64 default -9223372036854775808", "  d bool default false",
				"  e decimal(5,2) default -0.50", "  f decimal(4,0) default 12", "  g f64 default 1.25", "  h f64 default 0",
				"  i varchar(8) default 'it''s'", "  j uuid default '0e2b5d7a-0000-4000-8000-00000000000a'", "  k date default '0001-01-01'",
				"  l time(3) default '23:59:59.500'", "  m datetime(6) default '2026-01-01 00:00:00.000000'", "  n time(3) default '12:00:00.000'",
				"  primary key (id)", "}")),
		},
		{
			id: "check-expressions",
			input: with(block("table v {", "  id i64 identity", "  s varchar(8) null", "  n decimal(5,2)", "  primary key (id)",
				"  check ck_b (s   not in('a','b''c') and(n >= -01.50 and n<=2))", "  check ck_a ((id>=0)or s is not null or 2.5<>n)",
				"  check ck_c (s is null)", "}")),
			want: with(block("table v {", "  id i64 identity", "  s varchar(8) null", "  n decimal(5,2)", "  primary key (id)",
				"  check ck_a (id >= 0 or s is not null or 2.50 <> n)", "  check ck_b (s not in ('a', 'b''c') and n >= -1.50 and n <= 2.00)",
				"  check ck_c (s is null)", "}")),
		},
		{
			id: "comments-move-with-sorted-lines",
			input: []string{"dbspec 1 shop", "# zeta", "use zeta { z }", "# alpha", "use alpha { a }", "table users {", "  id i64 identity",
				"  primary key (id)", "  # second", "  index ix_b (id)", "  # first", "  index ix_a (id desc)", "  settings {", "    # select", "    select explicit id",
				"    # entity", "    entity person", "    # end of settings", "  }", "  # end of table", "}", "diagram d {", "  # entry", "  users at -0 -5", "  # end of diagram", "}", "# trailing"},
			set: map[string][]string{
				"zeta":  {"dbspec 1 zeta", "", "table z {", "  id i64 identity", "  primary key (id)", "}"},
				"alpha": {"dbspec 1 alpha", "", "table a {", "  id i64 identity", "  primary key (id)", "}"},
			},
			want: []string{"dbspec 1 shop", "", "# alpha", "use alpha { a }", "# zeta", "use zeta { z }", "", "table users {", "  id i64 identity",
				"  primary key (id)", "  # first", "  index ix_a (id desc)", "  # second", "  index ix_b (id)", "  settings {", "    # entity", "    entity person",
				"    # select", "    select explicit id", "    # end of settings", "  }", "  # end of table", "}", "", "diagram d {", "  # entry", "  users at 0 -5",
				"  # end of diagram", "}", "", "# trailing"},
		},
		{
			id: "settings-order",
			input: with(users, block("", "table orders {", "  id i64 identity", "  user_id i64 null", "  secret bytes null", "  token varchar(64) null", "  note text null",
				"  v i32", "  op i64", "  gone datetime(6) null", "  changed datetime(0)", "  primary key (id)", "  index ix_op (op)", "  index ix_token (token)", "  index ix_user (user_id)",
				"  foreign key fk_op (op) references users (id) on delete restrict on update restrict",
				"  foreign key fk_user (user_id) references users (id) on delete restrict on update restrict", "  settings {",
				"    audit into orders_history column op references users action act previous prev", "    immutable", "    navigation fk_user orders user",
				"    blind_index secret token", "    aes_version v", "    codec secret ordered_json aes", "    codec note gz base64", "    select explicit note secret",
				"    soft_delete gone", "    updated changed", "    entity order", "  }", "}", "", "table orders_history {", "  hid i64 identity", "  act varchar(8)",
				"  prev i64 null", "  id i64", "  user_id i64 null", "  secret bytes null", "  token varchar(64) null", "  note text null", "  v i32 null", "  op i64",
				"  gone datetime(6) null", "  changed datetime(0)", "  primary key (hid)", "}")),
			want: with(users, block("", "table orders {", "  id i64 identity", "  user_id i64 null", "  secret bytes null", "  token varchar(64) null", "  note text null",
				"  v i32", "  op i64", "  gone datetime(6) null", "  changed datetime(0)", "  primary key (id)", "  index ix_op (op)", "  index ix_token (token)", "  index ix_user (user_id)",
				"  foreign key fk_op (op) references users (id) on delete restrict on update restrict",
				"  foreign key fk_user (user_id) references users (id) on delete restrict on update restrict", "  settings {",
				"    entity order", "    updated changed", "    soft_delete gone", "    select explicit note secret", "    codec note gz base64",
				"    codec secret ordered_json aes", "    aes_version v", "    blind_index secret token", "    navigation fk_user orders user", "    immutable",
				"    audit into orders_history column op references users action act previous prev", "  }", "}", "", "table orders_history {", "  hid i64 identity", "  act varchar(8)",
				"  prev i64 null", "  id i64", "  user_id i64 null", "  secret bytes null", "  token varchar(64) null", "  note text null", "  v i32 null", "  op i64",
				"  gone datetime(6) null", "  changed datetime(0)", "  primary key (hid)", "}")),
		},
		{
			id:    "empty-settings-comments-move",
			input: with(block("table users {", "  id i64 identity", "  primary key (id)", "  # before", "  settings {", "      # inside", "  }", "  # end", "}")),
			want:  with(block("table users {", "  id i64 identity", "  primary key (id)", "  # before", "  # inside", "  # end", "}")),
		},
		{
			id:    "header-only",
			input: []string{"dbspec 1 empty", "", ""},
			want:  []string{"dbspec 1 empty"},
		},
		{
			id:    "used-table-in-diagram-and-mixed-line-ends",
			input: []string{"dbspec 1 shop\r", "use core { accounts }", "diagram d {\r", "  accounts at 1 2", "}"},
			set:   core,
			want:  []string{"dbspec 1 shop", "", "use core { accounts }", "", "diagram d {", "  accounts at 1 2", "}"},
		},
	}
	for _, c := range cases {
		t.Run(c.id, func(t *testing.T) {
			runTimed(t, c.id, 5*time.Second, func() error {
				got, err := emitStable(joinLines(c.input, false), docSet(c.set))
				if err != nil {
					return err
				}
				if want := joinLines(c.want, false); got != want {
					return fmt.Errorf("emission differs:\ngot:\n%s\nwant:\n%s", got, want)
				}
				return nil
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

// state_machine: the clean machine of the checklist application.
func TestStateMachineRules(t *testing.T) {
	cases := []ruleCase{
		{id: "state-machine-column-type", lines: with(block(
			"table jobs {", "  id i64 identity", "  status i32", "  primary key (id)",
			"  settings {", "    state_machine status waiting -> doing", "  }", "}",
		)), errors: errs(8, 19, RuleSetting)},
		{id: "state-machine-terminal-exit", lines: with(block(
			"table jobs {", "  id i64 identity", "  status varchar(16)", "  primary key (id)",
			"  settings {",
			"    state_machine status waiting -> doing",
			"    state_machine status terminal done",
			"    state_machine status done -> waiting",
			"  }", "}",
		)), errors: errs(10, 5, RuleSetting)},
		{id: "state-machine-require-column", lines: with(block(
			"table jobs {", "  id i64 identity", "  status varchar(16)", "  primary key (id)",
			"  settings {", "    state_machine status waiting -> doing require (nope)", "  }", "}",
		)), errors: errs(8, 52, RuleSetting)},
		{id: "state-machine-two-columns", lines: with(block(
			"table jobs {", "  id i64 identity", "  status varchar(16)", "  phase varchar(16)", "  primary key (id)",
			"  settings {",
			"    state_machine status waiting -> doing",
			"    state_machine phase ready -> running",
			"  }", "}",
		)), errors: errs(10, 19, RuleSetting)},
	}
	testcase.Start(t, testcase.Compute)
	for _, c := range cases {
		t.Run(c.id, func(t *testing.T) {
			runTimed(t, c.id, 5*time.Second, func() error {
				return expectDiagnostics(joinLines(c.lines, false), nil, c.errors)
			})
		})
	}
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
	bad := joinLines(with(block(
		"table pages {", "  id i64 identity", "  n i32", "  primary key (id)",
		"  settings {", "    markdown n", "  }", "}",
	)), false)
	if document, _, diagnostics := Parse(bad, nil); document != nil || len(diagnostics) == 0 {
		t.Fatalf("diagnostics: %+v", diagnostics)
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

// at returns the diagnostic that the rule reports at the token on the first line that holds the text.
func at(lines []string, text, token, rule string) vectorError {
	for i, line := range lines {
		if start := strings.Index(line, text); start >= 0 {
			return vectorError{Line: i + 1, Column: strings.Index(line[start:], token) + start + 1, Rule: rule}
		}
	}
	panic("no line holds " + text)
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

// TestMarkdownStorageManifest: a markdown setting enters the manifest hash and does not enter the schema hash.
func TestMarkdownStorageManifest(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	list := joinLines(markdownDoc(markdownColumns, pkID, standardHistory, markdownSettings...), false)
	table := strings.Replace(list, "store document list", "store document table", 1)
	manifests := make([]*Manifest, 0, 2)
	for _, text := range []string{list, table} {
		document, _, diagnostics := Parse(text, nil)
		if document == nil || len(diagnostics) != 0 {
			t.Fatalf("diagnostics: %+v", diagnostics)
		}
		manifest, diagnostics := ManifestOf([]*Document{document})
		if len(diagnostics) != 0 {
			t.Fatalf("manifest diagnostics: %+v", diagnostics)
		}
		manifests = append(manifests, manifest)
	}
	if manifests[0].ManifestHash == manifests[1].ManifestHash {
		t.Fatalf("the manifest hash does not cover the store setting")
	}
	if manifests[0].SchemaHash != manifests[1].SchemaHash {
		t.Fatalf("the schema hash covers the store setting")
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

// TestMarkdownStorageRules: each markdown storage setting is rejected at the token that its rule names, for the state, column, or shape that the rule names.
func TestMarkdownStorageRules(t *testing.T) {
	intKey := []string{"  primary key (id)"}
	intColumns := append([]string{"  id i64 identity"}, markdownColumns[1:]...)
	position := append([]string{}, markdownColumns...)
	position[3] = "  position i64 default 0"
	defaulted := append([]string{}, markdownColumns...)
	defaulted[4] = "  status varchar(16) default 'doing'"
	badHistory := historyColumns[:5]
	extraHistory := append(append([]string{}, historyColumns...), "  note varchar(10) null")
	precisionHistory := append([]string{}, historyColumns...)
	precisionHistory[4] = "  changed_at datetime(3)"
	fromHistory := append([]string{}, historyColumns...)
	fromHistory[2] = "  from_status varchar(8)"
	machine := []string{
		"state_machine status initial waiting",
		"state_machine status waiting -> doing",
		"state_machine status doing -> done require (reason)",
		"state_machine status terminal done",
	}
	cases := []struct {
		id       string
		columns  []string
		key      []string
		history  []string
		settings []string
		want     func(lines []string) []vectorError
	}{
		{id: "store-repeats", settings: []string{"store files", "store document list"}, want: func(l []string) []vectorError {
			return []vectorError{at(l, "store document list", "store", RuleSetting)}
		}},
		{id: "store-shape", settings: []string{"store document rows"}, want: func(l []string) []vectorError {
			return []vectorError{at(l, "store document rows", "rows", RuleSyntax)}
		}},
		{id: "store-block-foreign-key", settings: []string{"store block nope list"}, want: func(l []string) []vectorError {
			return []vectorError{at(l, "store block nope", "nope", RuleSetting)}
		}},
		{id: "key-prefix-integer-key", columns: intColumns, key: intKey, history: []string{}, settings: []string{"key_prefix 'T'"}, want: func(l []string) []vectorError {
			return []vectorError{at(l, "key_prefix 'T'", "key_prefix", RuleSetting)}
		}},
		{id: "title-nullable", settings: []string{"title reason"}, want: func(l []string) []vectorError {
			return []vectorError{at(l, "title reason", "reason", RuleSetting)}
		}},
		{id: "body-unknown-column", settings: []string{"body nope"}, want: func(l []string) []vectorError {
			return []vectorError{at(l, "body nope", "nope", RuleSetting)}
		}},
		{id: "order-kind", settings: []string{"order status"}, want: func(l []string) []vectorError {
			return []vectorError{at(l, "order status", "status", RuleSetting)}
		}},
		{id: "order-default", columns: position, settings: []string{"order position"}, want: func(l []string) []vectorError {
			return []vectorError{at(l, "order position", "position", RuleSetting)}
		}},
		{id: "order-in-index", key: []string{"  primary key (id)", "  index ix_position (position)"}, settings: []string{"order position"}, want: func(l []string) []vectorError {
			return []vectorError{at(l, "order position", "position", RuleSetting)}
		}},
		{id: "checkbox-outside-state-set", settings: append([]string{"checkbox status waiting '-'", "checkbox status doing '/'", "checkbox status done 'x'", "checkbox status paused '~'"}, machine...), want: func(l []string) []vectorError {
			return []vectorError{at(l, "checkbox status paused", "paused", RuleSetting)}
		}},
		{id: "checkbox-missing-state", settings: append([]string{"checkbox status waiting '-'", "checkbox status doing '/'"}, machine...), want: func(l []string) []vectorError {
			return []vectorError{at(l, "checkbox status waiting", "checkbox", RuleSetting)}
		}},
		{id: "checkbox-repeated-glyph", settings: append([]string{"checkbox status waiting '-'", "checkbox status doing '-'", "checkbox status done 'x'"}, machine...), want: func(l []string) []vectorError {
			return []vectorError{at(l, "checkbox status doing", "'-'", RuleSetting)}
		}},
		{id: "checkbox-glyph-length", settings: append([]string{"checkbox status waiting '--'", "checkbox status doing '/'", "checkbox status done 'x'"}, machine...), want: func(l []string) []vectorError {
			return []vectorError{at(l, "checkbox status waiting", "'--'", RuleSetting)}
		}},
		{id: "checkbox-without-machine", settings: []string{"checkbox status waiting '-'"}, want: func(l []string) []vectorError {
			return []vectorError{at(l, "checkbox status waiting", "status", RuleSetting)}
		}},
		{id: "initial-terminal", settings: []string{"state_machine status initial done", "state_machine status terminal done"}, want: func(l []string) []vectorError {
			return []vectorError{at(l, "state_machine status initial done", "state_machine", RuleSetting)}
		}},
		{id: "default-not-initial", columns: defaulted, settings: machine, want: func(l []string) []vectorError {
			return []vectorError{at(l, "status varchar(16) default", "'doing'", RuleSetting)}
		}},
		{id: "history-missing-table", settings: append([]string{"state_machine status history nope row ticket_id from from_status to to_status at changed_at"}, machine...), want: func(l []string) []vectorError {
			return []vectorError{at(l, "history nope", "nope", RuleSetting)}
		}},
		{id: "history-extra-column", history: ticketHistory(extraHistory), settings: append([]string{"state_machine status history ticket_history row ticket_id from from_status to to_status at changed_at"}, machine...), want: func(l []string) []vectorError {
			return []vectorError{at(l, "history ticket_history", "ticket_history", RuleSetting)}
		}},
		{id: "history-at-precision", history: ticketHistory(precisionHistory), settings: append([]string{"state_machine status history ticket_history row ticket_id from from_status to to_status at changed_at"}, machine...), want: func(l []string) []vectorError {
			return []vectorError{at(l, "history ticket_history", "ticket_history", RuleSetting)}
		}},
		{id: "history-from-type", history: ticketHistory(fromHistory), settings: append([]string{"state_machine status history ticket_history row ticket_id from from_status to to_status at changed_at"}, machine...), want: func(l []string) []vectorError {
			return []vectorError{at(l, "history ticket_history", "ticket_history", RuleSetting)}
		}},
		{id: "history-missing-required-column", history: ticketHistory(badHistory), settings: append([]string{"state_machine status history ticket_history row ticket_id from from_status to to_status at changed_at"}, machine...), want: func(l []string) []vectorError {
			return []vectorError{at(l, "history ticket_history", "ticket_history", RuleSetting)}
		}},
		{id: "history-repeated", settings: append([]string{
			"state_machine status history ticket_history row ticket_id from from_status to to_status at changed_at",
			"state_machine status history ticket_history row ticket_id from from_status to to_status at changed_at",
		}, machine...), want: func(l []string) []vectorError {
			first := at(l, "state_machine status history", "state_machine", RuleSetting)
			return []vectorError{{Line: first.Line + 1, Column: first.Column, Rule: RuleSetting}}
		}},
		{id: "limit-outside-state-set", settings: append([]string{"state_machine status limit paused 3"}, machine...), want: func(l []string) []vectorError {
			return []vectorError{at(l, "limit paused 3", "paused", RuleSetting)}
		}},
		{id: "limit-zero-count", settings: append([]string{"state_machine status limit doing 0"}, machine...), want: func(l []string) []vectorError {
			return []vectorError{at(l, "limit doing 0", "0", RuleSetting)}
		}},
		{id: "limit-repeated-state", settings: append([]string{"state_machine status limit doing 3", "state_machine status limit doing 4"}, machine...), want: func(l []string) []vectorError {
			return []vectorError{at(l, "limit doing 4", "doing", RuleSetting)}
		}},
	}
	testcase.Start(t, testcase.Compute)
	for _, c := range cases {
		t.Run(c.id, func(t *testing.T) {
			columns, key, history := c.columns, c.key, c.history
			if columns == nil {
				columns = markdownColumns
			}
			if key == nil {
				key = pkID
			}
			if history == nil {
				history = standardHistory
			}
			lines := markdownDoc(columns, key, history, c.settings...)
			runTimed(t, c.id, 5*time.Second, func() error {
				return expectDiagnostics(joinLines(lines, false), nil, c.want(lines))
			})
		})
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
