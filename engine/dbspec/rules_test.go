package dbspec

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/internal/testcase"
)

// These cases cover rules and canonical forms that tests/dbspec/cases.json
// does not cover yet. Each document is written with LF line ends.

type ruleCase struct {
	id     string
	lines  []string
	set    map[string][]string
	errors []vectorError
}

func errs(spec ...any) []vectorError {
	var out []vectorError
	for i := 0; i < len(spec); i += 3 {
		out = append(out, vectorError{Line: spec[i].(int), Column: spec[i+1].(int), Rule: spec[i+2].(string)})
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

var ruleCases = []ruleCase{
	// header, encoding, limit
	{id: "empty-document", lines: nil, errors: errs(1, 1, RuleHeader)},
	{id: "header-version", lines: []string{"dbspec 2 shop"}, errors: errs(1, 8, RuleHeader)},
	{id: "header-extra-token", lines: []string{"dbspec 1 shop extra"}, errors: errs(1, 14, RuleHeader)},
	{id: "header-missing-name", lines: []string{"dbspec 1"}, errors: errs(1, 9, RuleHeader)},
	{id: "header-name-format", lines: []string{"dbspec 1 Shop"}, errors: errs(1, 10, RuleNameFormat)},
	{id: "header-stops-parsing", lines: []string{"dbspec 1", "table Users {", "}"}, errors: errs(1, 9, RuleHeader)},

	// syntax and order
	{id: "unknown-top-level", lines: with(block("view v {")), errors: errs(3, 1, RuleSyntax)},
	{id: "unclosed-table", lines: with(block("table users {", "  id i64 identity", "  primary key (id)")), errors: errs(3, 13, RuleSyntax)},
	{id: "unterminated-string", lines: with(block("table users {", "  id i64 identity", "  name varchar(8) default 'x", "  primary key (id)", "}")), errors: errs(5, 27, RuleSyntax)},
	{id: "bad-character", lines: with(block("table users {", "  id i64 identity;", "  primary key (id)", "}")), errors: errs(4, 18, RuleSyntax)},
	{id: "tab-is-not-space", lines: with(block("table users {", "\tid i64 identity", "  primary key (id)", "}")), errors: errs(4, 1, RuleSyntax)},
	{id: "modifier-order", lines: with(block("table users {", "  id i64 identity null", "  primary key (id)", "}")), errors: errs(4, 19, RuleSyntax)},
	{id: "empty-key-list", lines: with(block("table users {", "  id i64 identity", "  primary key ()", "}")), errors: errs(5, 16, RuleSyntax)},
	{id: "use-after-table", lines: with(users, block("", "use core { accounts }")), set: core, errors: errs(8, 1, RuleOrder)},
	{id: "table-after-diagram", lines: with(block("diagram d {", "}", ""), users), errors: errs(6, 1, RuleOrder)},
	{id: "column-after-key", lines: with(block("table users {", "  id i64 identity", "  primary key (id)", "  name varchar(8)", "}")), errors: errs(6, 3, RuleOrder)},
	{id: "key-after-settings", lines: with(block("table users {", "  id i64 identity", "  settings {", "    immutable", "  }", "  primary key (id)", "}")), errors: errs(8, 3, RuleOrder)},
	{id: "second-settings", lines: with(block("table users {", "  id i64 identity", "  primary key (id)", "  settings {", "  }", "  settings {", "  }", "}")), errors: errs(8, 3, RuleOrder)},

	// names
	{id: "name-primary", lines: with(block("table primary {", "  id i64 identity", "  primary key (id)", "}")), errors: errs(3, 7, RuleNameFormat)},
	{id: "name-leading-digit", lines: with(block("table users {", "  id i64 identity", "  9lives i32", "  primary key (id)", "}")), errors: errs(5, 3, RuleNameFormat)},
	{id: "name-qualified", lines: with(block("table core.users {", "  id i64 identity", "  primary key (id)", "}")), errors: errs(3, 7, RuleNameFormat)},
	{id: "duplicate-column", lines: with(block("table users {", "  id i64 identity", "  id i32", "  primary key (id)", "}")), errors: errs(5, 3, RuleNameDuplicate)},
	{id: "duplicate-table", lines: with(users, block(""), users), errors: errs(8, 7, RuleNameDuplicate)},
	{id: "duplicate-diagram", lines: with(users, block("", "diagram d {", "}", "diagram d {", "}")), errors: errs(10, 9, RuleNameDuplicate)},
	{id: "duplicate-index-and-check", lines: with(block("table users {", "  id i64 identity", "  primary key (id)", "  index x_id (id)", "  check x_id (id > 0)", "}")), errors: errs(7, 9, RuleNameDuplicate)},
	{id: "duplicate-name-with-used-document", lines: with(block("use core { accounts }", "", "table users {", "  id i64 identity", "  primary key (id)", "  index uq_accounts_code (id)", "}")), set: core, errors: errs(8, 9, RuleNameDuplicate)},
	{id: "local-table-shadows-used-table", lines: with(block("use core { accounts }", ""), block("table accounts {", "  id i64 identity", "  primary key (id)", "}")), set: core, errors: errs(5, 7, RuleNameDuplicate)},

	// types
	{id: "varchar-zero", lines: with(block("table users {", "  id i64 identity", "  name varchar(0)", "  primary key (id)", "}")), errors: errs(5, 8, RuleType)},
	{id: "varchar-too-long", lines: with(block("table users {", "  id i64 identity", "  name varchar(16384)", "  primary key (id)", "}")), errors: errs(5, 8, RuleType)},
	{id: "time-without-precision", lines: with(block("table users {", "  id i64 identity", "  at time", "  primary key (id)", "}")), errors: errs(5, 6, RuleType)},
	{id: "datetime-precision-7", lines: with(block("table users {", "  id i64 identity", "  at datetime(7)", "  primary key (id)", "}")), errors: errs(5, 6, RuleType)},
	{id: "decimal-scale-above-precision", lines: with(block("table users {", "  id i64 identity", "  n decimal(4,5)", "  primary key (id)", "}")), errors: errs(5, 5, RuleType)},
	{id: "parameter-on-plain-type", lines: with(block("table users {", "  id i64 identity", "  n i32(4)", "  primary key (id)", "}")), errors: errs(5, 5, RuleType)},
	{id: "unsupported-types", lines: with(block("table users {", "  id i64 identity", "  a f32", "  b char(4)", "  c json", "  primary key (id)", "}")), errors: errs(5, 5, RuleType, 6, 5, RuleType, 7, 5, RuleType)},

	// columns
	{id: "null-identity", lines: with(block("table users {", "  id i64 null identity", "  primary key (id)", "}")), errors: errs(4, 15, RuleColumn, 5, 16, RuleKey)},
	{id: "identity-default", lines: with(block("table users {", "  id i64 identity default 1", "  primary key (id)", "}")), errors: errs(4, 19, RuleColumn)},
	{id: "identity-not-sole-key", lines: with(block("table users {", "  id i64 identity", "  n i32", "  primary key (id, n)", "}")), errors: errs(4, 10, RuleColumn)},
	{id: "identity-twice", lines: with(block("table users {", "  id i64 identity", "  other i64 identity", "  primary key (id)", "}")), errors: errs(5, 13, RuleColumn)},
	{id: "text-default", lines: with(block("table users {", "  id i64 identity", "  body text default 'x'", "  primary key (id)", "}")), errors: errs(5, 13, RuleColumn)},
	{id: "default-out-of-range", lines: with(block("table users {", "  id i64 identity",
		"  a i16 default 32768", "  b i32 default -2147483649", "  c bool default 1", "  d decimal(3,1) default 100", "  e decimal(3,1) default 1.25",
		"  f varchar(2) default 'abc'", "  g uuid default 'x'", "  h date default '2026-02-30'", "  i time(0) default '24:00:00'",
		"  j datetime(0) default '2026-01-01T00:00:00'", "  k i32 default now", "  l i32 default '1'", "  m varchar(4) default null",
		"  primary key (id)", "}")),
		errors: errs(5, 17, RuleColumn, 6, 17, RuleColumn, 7, 18, RuleColumn, 8, 26, RuleColumn, 9, 26, RuleColumn, 10, 24, RuleColumn,
			11, 18, RuleColumn, 12, 18, RuleColumn, 13, 21, RuleColumn, 14, 25, RuleColumn, 15, 17, RuleColumn, 16, 17, RuleColumn, 17, 24, RuleColumn)},

	// keys
	{id: "two-primary-keys", lines: with(block("table users {", "  id i64 identity", "  primary key (id)", "  primary key (id)", "}")), errors: errs(6, 3, RuleKey)},
	{id: "nullable-key-column", lines: with(block("table users {", "  id i64", "  n i32 null", "  primary key (id, n)", "}")), errors: errs(6, 20, RuleKey)},
	{id: "unknown-and-repeated-key-column", lines: with(block("table users {", "  id i64 identity", "  primary key (id)", "  index ix_a (id, id, nope)", "}")), errors: errs(6, 19, RuleKey, 6, 23, RuleKey)},
	{id: "bytes-in-unique", lines: with(block("table users {", "  id i64 identity", "  b bytes", "  primary key (id)", "  unique uq_b (b)", "}")), errors: errs(7, 16, RuleKey)},
	{id: "seventeen-columns", lines: with(seventeenColumns()), errors: errs(21, 3, RuleKey)},
	{id: "varchar-over-640", lines: with(block("table users {", "  id i64 identity", "  a varchar(320)", "  b varchar(320)", "  c varchar(1)", "  primary key (id)", "  index ix_abc (a, b, c)", "}")), errors: errs(9, 9, RuleKey)},

	// foreign keys
	{id: "unknown-target", lines: with(block("table users {", "  id i64 identity", "  t_id i64", "  primary key (id)", "  index ix_t (t_id)", "  foreign key fk_t (t_id) references teams (id)", "}")), errors: errs(8, 38, RuleForeignKey)},
	{id: "unlisted-used-table", lines: with(block("use core { accounts }", "", "table users {", "  id i64 identity", "  t_id i64", "  primary key (id)", "  index ix_t (t_id)", "  foreign key fk_t (t_id) references teams (id)", "}")), set: core, errors: errs(10, 38, RuleForeignKey)},
	{id: "type-mismatch", lines: with(users, block("", "table orders {", "  id i64 identity", "  user_id i32", "  primary key (id)", "  index ix_u (user_id)", "  foreign key fk_u (user_id) references users (id)", "}")), errors: errs(13, 15, RuleForeignKey)},
	{id: "arity-mismatch", lines: with(users, block("", "table orders {", "  id i64 identity", "  user_id i64", "  primary key (id)", "  index ix_u (user_id, id)", "  foreign key fk_u (user_id, id) references users (id)", "}")), errors: errs(13, 15, RuleForeignKey)},
	{id: "reference-not-a-key", lines: with(block("table users {", "  id i64 identity", "  code varchar(8)", "  primary key (id)", "}", "", "table orders {", "  id i64 identity", "  code varchar(8)", "  primary key (id)", "  index ix_c (code)", "  foreign key fk_c (code) references users (code)", "}")), errors: errs(14, 15, RuleForeignKey)},
	{id: "unknown-action-and-columns", lines: with(users, block("", "table orders {", "  id i64 identity", "  primary key (id)", "  foreign key fk_u (nope) references users (missing) on delete no_action", "}")), errors: errs(11, 21, RuleForeignKey, 11, 45, RuleForeignKey, 11, 64, RuleForeignKey)},
	{id: "index-order-matters", lines: with(block("table pairs {", "  a i64", "  b i64", "  primary key (a, b)", "}", "", "table refs {", "  id i64 identity", "  a i64", "  b i64", "  primary key (id)", "  index ix_ba (b, a)", "  foreign key fk_ab (a, b) references pairs (a, b)", "}")), errors: errs(15, 15, RuleForeignKey)},

	// checks
	{id: "check-unknown-column", lines: with(block("table users {", "  id i64 identity", "  primary key (id)", "  check ck_x (x > 0)", "}")), errors: errs(6, 15, RuleCheck)},
	{id: "check-set-null-on-update", lines: with(users, block("", "table orders {", "  id i64 identity", "  user_id i64 null", "  primary key (id)", "  index ix_u (user_id)", "  foreign key fk_u (user_id) references users (id) on update set_null", "  check ck_u (user_id is not null or id > 0)", "}")), errors: errs(14, 15, RuleCheck)},
	{id: "check-outside-neutral-set", lines: with(block("table users {", "  id i64 identity", "  primary key (id)", "  check ck_a (id like 1)", "  check ck_b (id > -id)", "  check ck_c (id AND 1)", "  check ck_d (id in (id))", "  check ck_e ((id > 0)", "}")),
		errors: errs(6, 18, RuleCheck, 7, 20, RuleCheck, 8, 18, RuleCheck, 9, 22, RuleCheck, 10, 22, RuleCheck)},
	{id: "check-typed-operands", lines: with(block("table users {", "  id i64 identity", "  on bool", "  t0 time(0)", "  t3 time(3)", "  primary key (id)",
		"  check ck_a (on between true and false)", "  check ck_b (t0 < t3)", "  check ck_c (1 is null)", "  check ck_d (id = 1 and on > false)", "}")),
		errors: errs(9, 18, RuleCheck, 10, 20, RuleCheck, 11, 15, RuleCheck, 12, 29, RuleCheck)},

	// settings
	{id: "setting-repeats", lines: with(block("table users {", "  id i64 identity", "  primary key (id)", "  settings {", "    entity user", "    entity person", "  }", "}")), errors: errs(8, 5, RuleSetting)},
	{id: "setting-unknown-column", lines: with(block("table users {", "  id i64 identity", "  primary key (id)", "  settings {", "    select explicit id nope id", "  }", "}")), errors: errs(7, 24, RuleSetting, 7, 29, RuleSetting)},
	{id: "setting-column-types", lines: with(block("table users {", "  id i64 identity", "  at date", "  gone datetime(6)", "  v i32 null", "  n i32", "  primary key (id)", "  settings {", "    updated at", "    soft_delete gone", "    codec n gz", "    aes_version v", "  }", "}")),
		errors: errs(11, 13, RuleSetting, 12, 17, RuleSetting, 13, 11, RuleSetting, 14, 5, RuleSetting, 14, 17, RuleSetting)},
	{id: "codec-companions", lines: with(block("table users {", "  id i64 identity", "  secret bytes", "  token varchar(64)", "  plain varchar(64)", "  primary key (id)", "  index ix_token (token)", "  settings {", "    codec secret aes zip", "    blind_index plain token", "  }", "}")),
		errors: errs(11, 5, RuleSetting, 11, 22, RuleSetting, 12, 5, RuleSetting)},
	{id: "blind-index-not-indexed", lines: with(block("table users {", "  id i64 identity", "  secret bytes", "  token varchar(64)", "  v i32", "  primary key (id)", "  settings {", "    codec secret aes", "    aes_version v", "    blind_index secret token", "  }", "}")), errors: errs(12, 24, RuleSetting)},
	{id: "navigation-unknown-key", lines: with(block("table users {", "  id i64 identity", "  primary key (id)", "  settings {", "    navigation fk_nope Owner owned", "  }", "}")), errors: errs(7, 16, RuleSetting, 7, 24, RuleNameFormat)},
	{id: "immutable-on-cascade-child", lines: with(users, block("", "table orders {", "  id i64 identity", "  user_id i64", "  primary key (id)", "  index ix_u (user_id)", "  foreign key fk_u (user_id) references users (id) on delete cascade", "  settings {", "    immutable", "  }", "}")), errors: errs(15, 5, RuleSetting)},
	{id: "audit-bad-history", lines: with(block("table service {", "  id i64 identity", "  audit_seq i32", "  primary key (id)", "  index ix_service_audit (audit_seq)", "  foreign key fk_service_audit (audit_seq) references audit (seq) on delete restrict on update restrict", "  settings {", "    audit into service_history column audit_seq references audit action change previous previous_audit_seq", "  }", "}", "",
		"table service_history {", "  history_id i64", "  change varchar(16)", "  previous_audit_seq i64", "  id i64", "  extra i32", "  primary key (history_id)", "}", "", "table audit {", "  seq i32", "  primary key (seq)", "}")),
		errors: errs(10, 16, RuleSetting, 10, 16, RuleSetting, 10, 16, RuleSetting, 10, 16, RuleSetting, 10, 73, RuleSetting, 10, 89, RuleSetting)},
	{id: "audit-history-audited", lines: with(block("table a {", "  id i64 identity", "  op i64", "  gone datetime(6) null", "  primary key (id)", "  index ix_a_op (op)", "  foreign key fk_a_op (op) references r (id) on delete restrict on update restrict", "  settings {", "    soft_delete gone", "    audit into a column op references r action act previous prev", "  }", "}", "", "table r {", "  id i64 identity", "  primary key (id)", "}")), errors: errs(12, 16, RuleSetting)},

	// use and diagrams
	{id: "use-undefined-table", lines: with(block("use core { accounts, teams }"), users), set: core, errors: errs(3, 22, RuleUse)},
	{id: "use-invalid-document", lines: with(block("use core { accounts }"), users), set: map[string][]string{"core": {"dbspec 1 core", "", "table accounts {", "  id i64 identity", "}"}}, errors: errs(3, 5, RuleUse)},
	{id: "use-mismatched-name", lines: with(block("use core { accounts }"), users), set: map[string][]string{"core": {"dbspec 1 other", "", "table accounts {", "  id i64 identity", "  primary key (id)", "}"}}, errors: errs(3, 5, RuleUse)},
	{id: "use-own-document", lines: with(block("use shop { users }", ""), users), errors: errs(3, 5, RuleUse)},
	{id: "decimal-and-time-extra-zero-digits", lines: with(block("table users {", "  id i64 identity", "  d decimal(4,0) default 12.0", "  t time(0) default '12:00:00.0'", "  primary key (id)", "}")), errors: errs(5, 26, RuleColumn, 6, 21, RuleColumn)},
	{id: "reserved-word-and-tie-order", lines: with(block("table users {", "  id i64 identity", "  Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa i32", "  primary key (id)", "  index identity (id)", "}")), errors: errs(5, 3, RuleNameFormat, 5, 3, RuleNameLength, 7, 9, RuleNameFormat)},
	{id: "malformed-reference", lines: with(block("table users {", "  id i64 identity", "  primary key (Id)", "  index ix_x (id, Nope)", "}")), errors: errs(5, 16, RuleNameFormat, 6, 19, RuleNameFormat)},
	{id: "reference-to-failed-table", lines: with(block("table teams { x", "  id i64 identity", "  primary key (id)", "}", "", "table users {", "  id i64 identity", "  team_id i64", "  primary key (id)", "  index ix_team (team_id)", "  foreign key fk_team (team_id) references teams (missing)", "}")), errors: errs(3, 15, RuleSyntax)},
	{id: "varchar-640-in-primary-key", lines: with(block("table users {", "  a varchar(400)", "  b varchar(400)", "  primary key (a, b)", "}")), errors: errs(6, 3, RuleKey)},
	{id: "constraint-named-like-used-table", lines: with(block("use core { accounts }", "", "table users {", "  id i64 identity", "  primary key (id)", "  index accounts (id)", "}")), set: core, errors: errs(8, 9, RuleNameDuplicate)},
	{id: "used-documents-repeat-constraint", lines: with(block("use core { accounts }", "use extra { teams }"), users), set: map[string][]string{"core": core["core"], "extra": {"dbspec 1 extra", "", "table teams {", "  id i64 identity", "  code varchar(8)", "  primary key (id)", "  unique uq_accounts_code (code)", "}"}}, errors: errs(4, 5, RuleNameDuplicate)},
	{id: "use-cycle-in-set", lines: with(block("use core { accounts }"), users), set: map[string][]string{"core": {"dbspec 1 core", "", "use extra { teams }", "", "table accounts {", "  id i64 identity", "  primary key (id)", "}"}, "extra": {"dbspec 1 extra", "", "use core { accounts }", "", "table teams {", "  id i64 identity", "  primary key (id)", "}"}}, errors: errs(3, 5, RuleUse)},
	{id: "codec-storage-and-order", lines: with(block("table users {", "  id i64 identity", "  a bytes", "  b text", "  c varchar(64)", "  primary key (id)", "  settings {", "    codec a gz base64", "    codec b gz", "    codec c hex ordered_json", "  }", "}")), errors: errs(10, 11, RuleSetting, 11, 11, RuleSetting, 12, 17, RuleSetting)},
	{id: "blind-index-rules", lines: with(block("table users {", "  id i64 identity", "  s1 bytes", "  s2 bytes null", "  s3 bytes", "  s4 bytes", "  h1 varchar(32)", "  h2 varchar(64)", "  v i32", "  primary key (id)", "  index ix_h1 (h1)", "  index ix_h2 (h2, id)", "  settings {", "    codec s1 aes", "    codec s2 aes", "    codec s3 aes", "    codec s4 aes", "    aes_version v", "    blind_index s1 h1", "    blind_index s2 h2", "    blind_index s3 s1", "    blind_index s3 h2", "    blind_index s4 h2", "  }", "}")),
		errors: errs(21, 20, RuleSetting, 22, 20, RuleSetting, 23, 20, RuleSetting, 24, 5, RuleSetting, 25, 20, RuleSetting)},
	{id: "blind-index-bytes", lines: with(block("table users {", "  id i64 identity", "  s bytes", "  h varchar(64)", "  b bytes", "  v i32", "  primary key (id)", "  unique uq_h (h)", "  settings {", "    codec s aes", "    aes_version v", "    blind_index s b", "  }", "}")), errors: errs(14, 19, RuleSetting)},
	{id: "check-first-diagnostic-only", lines: with(block("table users {", "  id i64 identity", "  primary key (id)", "  check ck_x (x > 0 and y > 0)", "}")), errors: errs(6, 15, RuleCheck)},
	{id: "header-exact-spacing", lines: []string{"dbspec  1 shop"}, errors: errs(1, 8, RuleHeader)},
	{id: "header-tab", lines: []string{"dbspec 1\tshop"}, errors: errs(1, 9, RuleHeader)},
	{id: "audit-action-nullable", lines: with(block("table a {", "  id i64 identity", "  op i64", "  gone datetime(6) null", "  primary key (id)", "  index ix_a_op (op)", "  foreign key fk_a_op (op) references r (id) on delete restrict on update restrict", "  settings {", "    soft_delete gone", "    audit into h column op references r action act previous prev", "  }", "}", "", "table h {", "  hid i64 identity", "  act varchar(8) null", "  prev i64 null", "  id i64", "  op i64", "  gone datetime(6) null", "  primary key (hid)", "}", "", "table r {", "  id i64 identity", "  primary key (id)", "}")), errors: errs(12, 48, RuleSetting)},
	{id: "coordinate-i32-bounds", lines: with(users, block("", "diagram main {", "  users at -2147483648 2147483647", "}", "diagram other {", "  users at -2147483649 0", "}")), errors: errs(12, 12, RuleDiagram)},
	{id: "diagram-repeat-and-coordinates", lines: with(users, block("", "diagram main {", "  users at 1.5 x", "  users at 0 0", "}")), errors: errs(9, 12, RuleDiagram, 9, 16, RuleDiagram, 10, 3, RuleDiagram)},
}

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

func TestRuleDiagnostics(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, c := range ruleCases {
		t.Run(c.id, func(t *testing.T) {
			runTimed(t, "rule/"+c.id, 5*time.Second, func() error {
				text := ""
				if c.lines != nil {
					text = joinLines(c.lines, false)
				}
				return expectDiagnostics(text, docSet(c.set), c.errors)
			})
		})
	}
}

func TestEncodingAndLimitDiagnostics(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	big := "dbspec 1 shop\n" + strings.Repeat("#", maxDocumentBytes)
	var tables strings.Builder
	tables.WriteString("dbspec 1 shop\n")
	for i := 0; i <= maxTables; i++ {
		fmt.Fprintf(&tables, "table t%d {\n  id i64 identity\n  primary key (id)\n}\n", i)
	}
	var columns strings.Builder
	columns.WriteString("dbspec 1 shop\ntable wide {\n")
	for i := 0; i <= maxTableColumns; i++ {
		fmt.Fprintf(&columns, "  c%d i32\n", i)
	}
	cases := []struct {
		id   string
		text string
		want []vectorError
	}{
		{"byte-order-mark", "\xef\xbb\xbfdbspec 1 shop\n", errs(1, 1, RuleEncoding)},
		{"invalid-utf8", "dbspec 1 shop\n# caf\xe9\n", errs(2, 6, RuleEncoding)},
		{"bare-cr", "dbspec 1 shop\r\n\rtable", errs(2, 1, RuleEncoding)},
		{"size", big, errs(1, 1, RuleLimit)},
		{"tables", tables.String(), errs(4*maxTables+2, 1, RuleLimit)},
		{"table-columns", columns.String(), errs(maxTableColumns+3, 3, RuleLimit)},
		{"limit-after-earlier-errors", "dbspec 1 shop\ntable T {\n" + strings.TrimPrefix(columns.String(), "dbspec 1 shop\ntable wide {\n"), errs(2, 7, RuleNameFormat, maxTableColumns+3, 3, RuleLimit)},
		{"encoding-after-earlier-errors", "dbspec 1 shop\ntable T {\n  id i64 identity\n  bad\xff i32\n", errs(2, 7, RuleNameFormat, 4, 6, RuleEncoding)},
	}
	for _, c := range cases {
		t.Run(c.id, func(t *testing.T) {
			runTimed(t, "limit/"+c.id, 10*time.Second, func() error {
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
			runTimed(t, "canonical/"+c.id, 5*time.Second, func() error {
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
		document, diagnostics := Parse(text, docSet(core))
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
			runTimed(t, "rule/"+c.id, 5*time.Second, func() error {
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
	document, diagnostics := Parse(text, nil)
	if document == nil || len(diagnostics) != 0 {
		t.Fatalf("diagnostics: %+v", diagnostics)
	}
	if got, err := emitStable(text, nil); err != nil || got != text {
		t.Fatalf("emission: %v\n%s", err, got)
	}
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
	document, diagnostics := Parse(text, nil)
	if document == nil || len(diagnostics) != 0 {
		t.Fatalf("diagnostics: %+v", diagnostics)
	}
	if got, err := emitStable(text, nil); err != nil || got != text {
		t.Fatalf("emission: %v\n%s", err, got)
	}
	trait := document.Tables[0].Settings.Marks
	if len(trait) != 2 || trait[0].Column != "body" || trait[1].Column != "note" {
		t.Fatalf("marks: %+v", trait)
	}
	bad := joinLines(with(block(
		"table pages {", "  id i64 identity", "  n i32", "  primary key (id)",
		"  settings {", "    markdown n", "  }", "}",
	)), false)
	if document, diagnostics := Parse(bad, nil); document != nil || len(diagnostics) == 0 {
		t.Fatalf("diagnostics: %+v", diagnostics)
	}
}

// markdownColumns는 markdown storage case들이 공유하는 tickets table의 column이다.
var markdownColumns = []string{
	"  id varchar(32)",
	"  title varchar(255)",
	"  body text",
	"  position i64",
	"  status varchar(16)",
	"  reason varchar(200) null",
}

// historyColumns는 state_machine history가 이름 붙이는 ticket_history table의 column이다.
var historyColumns = []string{
	"  id i64 identity",
	"  ticket_id varchar(32)",
	"  from_status varchar(16)",
	"  to_status varchar(16)",
	"  changed_at datetime(6)",
	"  reason varchar(200) null",
}

// ticketHistory는 주어진 column과 key, foreign key를 선행하는 index, tickets를 가리키는 foreign key를 가진 ticket_history table을 쓴다.
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

// markdownDoc은 주어진 column, key 줄과 setting으로 tickets table을 쓰고, 그 뒤에 history table을 쓴다. 각 setting은 settings block 안에 들여쓴다.
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

// at은 text를 담은 첫 줄에서 rule이 token에 보고하는 diagnostic을 돌려준다.
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

// TestMarkdownStorageSetting: markdown storage의 storage, key, title, body, order, checkbox와 state_machine setting이 parse되고 canonical하게 emit되어 settings model에 도달한다.
func TestMarkdownStorageSetting(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	text := joinLines(markdownDoc(markdownColumns, pkID, standardHistory, markdownSettings...), false)
	document, diagnostics := Parse(text, nil)
	if document == nil || len(diagnostics) != 0 {
		t.Fatalf("diagnostics: %+v", diagnostics)
	}
	if got, err := emitStable(text, nil); err != nil || got != text {
		t.Fatalf("emission: %v\n%s", err, got)
	}
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

// TestMarkdownStorageManifest: markdown setting은 manifest hash에 들어가고 schema hash에는 들어가지 않는다.
func TestMarkdownStorageManifest(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	list := joinLines(markdownDoc(markdownColumns, pkID, standardHistory, markdownSettings...), false)
	table := strings.Replace(list, "store document list", "store document table", 1)
	manifests := make([]*Manifest, 0, 2)
	for _, text := range []string{list, table} {
		document, diagnostics := Parse(text, nil)
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

// TestStateMachineKeywordStates: state_machine 줄의 keyword와 이름이 같은 state도 뒤에 전환 화살표가 오면 여전히 전환 state다.
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
	document, diagnostics := Parse(text, nil)
	if document == nil || len(diagnostics) != 0 {
		t.Fatalf("diagnostics: %+v", diagnostics)
	}
	if got, err := emitStable(text, nil); err != nil || got != text {
		t.Fatalf("emission: %v\n%s", err, got)
	}
	lines := document.Tables[0].Settings.StateMachine.Lines
	if len(lines) != 3 || lines[0].From != "initial" || lines[0].Initial || lines[1].From != "limit" ||
		lines[1].To != "history" || !lines[2].Initial || lines[2].State != "initial" {
		t.Fatalf("lines: %+v", lines)
	}
}

// TestMarkdownStorageRules: 각 markdown storage setting은 그 rule이 이름 붙이는 state, column, 모양을 rule이 이름 붙이는 token에서 거부한다.
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
			runTimed(t, "rule/"+c.id, 5*time.Second, func() error {
				return expectDiagnostics(joinLines(lines, false), nil, c.want(lines))
			})
		})
	}
}
