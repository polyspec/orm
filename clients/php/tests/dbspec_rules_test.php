<?php
declare(strict_types=1);
// Focused dbspec rules that tests/dbspec/cases.json does not cover yet. An
// expected error names its rule, its line and a needle: the column is the
// first occurrence of the needle in that line (in characters), or an integer.
require __DIR__ . '/autoload.php';
require_once __DIR__ . '/case_clock.php';
require __DIR__ . '/dbspec_cases.php';

$started = caseClockStart();

/** @param list<array{0:string,1:int,2:string|int}> $errors */
function rules_case(string $id, array $lines, array $errors, array $others = []): array
{
    $documents = $others + ['shop' => $lines];
    $expected = [];
    foreach ($errors as [$rule, $line, $needle]) {
        if (is_int($needle)) {
            $column = $needle;
        } else {
            $text = $lines[$line - 1];
            $at = mb_strpos($text, $needle);
            if ($at === false) {
                throw new RuntimeException("$id: needle '$needle' is not in line $line");
            }
            $column = $at + 1;
        }
        $expected[] = ['rule' => $rule, 'line' => $line, 'column' => $column];
    }
    return ['id' => $id, 'documents' => $documents, 'main' => 'shop', 'errors' => $expected];
}

/** A table body with an identity key around the given lines. */
function users(array $columns, array $rest = []): array
{
    return array_merge(['dbspec 1 shop', '', 'table users {', '  id i64 identity'], $columns, ['  primary key (id)'], $rest, ['}']);
}

$core = ['core' => [
    'dbspec 1 core', '', 'table accounts {', '  id i64 identity', '  code varchar(16)', '  primary key (id)', '  unique uq_accounts_code (code)', '}',
]];

$invalid = [
    rules_case('encoding-bom', ["\u{FEFF}dbspec 1 shop", '', 'table users {', '  id i64 identity', '  primary key (id)', '}'], [['encoding', 1, 1]]),
    rules_case('encoding-invalid-utf8', ['dbspec 1 shop', '', "# caf\xff", 'table users {', '  id i64 identity', '  Bad i64', '  primary key (id)', '}'], [['encoding', 3, 6]]),
    rules_case('encoding-bare-cr', ['dbspec 1 shop', '', 'table users {', "  id i64\ridentity", '  primary key (id)', '}'], [['encoding', 4, 9]]),
    rules_case('header-version', ['dbspec 2 shop', '', 'table Users {', '}'], [['header', 1, '2']]),
    rules_case('header-extra-token', ['dbspec 1 shop extra', 'table Users {', '}'], [['header', 1, 14]]),
    rules_case('header-blank-first-line', ['', 'dbspec 1 shop'], [['header', 1, 1]]),
    rules_case('header-double-space', ['dbspec 1  shop'], [['header', 1, 10]]),
    rules_case('header-tab', ["dbspec\t1 shop"], [['header', 1, 7]]),
    rules_case('blind-index-bytes-target', users(['  secret bytes', '  version i32', '  secret_hash bytes'], ['  settings {', '    codec secret aes', '    aes_version version', '    blind_index secret secret_hash', '  }']), [['setting', 12, 'secret_hash']]),
    rules_case('header-name-format', ['dbspec 1 Shop'], [['name.format', 1, 'Shop']]),
    rules_case('order-use-after-table', ['dbspec 1 shop', '', 'table users {', '  id i64 identity', '  primary key (id)', '}', 'use core { accounts }'], [['order', 7, 'use']], $core),
    rules_case('order-table-after-diagram', ['dbspec 1 shop', '', 'diagram main {', '}', 'table users {', '  id i64 identity', '  primary key (id)', '}'], [['order', 5, 'table']]),
    rules_case('order-column-after-key', users([], ['  name varchar(8)']), [['order', 6, 'name']]),
    rules_case('order-line-after-settings', users([], ['  settings {', '  }', '  index ix_users_id (id)']), [['order', 8, 'index']]),
    rules_case('syntax-top-level', ['dbspec 1 shop', '', 'view users {', '}'], [['syntax', 3, 'view'], ['syntax', 4, '}']]),
    rules_case('syntax-column-modifier', users(['  name varchar(8) unique']), [['syntax', 5, 'unique']]),
    rules_case('syntax-unclosed-table', ['dbspec 1 shop', '', 'table users {', '  id i64 identity', '  primary key (id)'], [['syntax', 3, '{']]),
    rules_case('name-primary', users(['  code varchar(8)'], ['  unique primary (code)']), [['name.format', 7, 'primary (']]),
    rules_case('name-duplicate-column', users(['  id i32']), [['name.duplicate', 5, 'id']]),
    rules_case('name-duplicate-table', array_merge(users([]), ['', 'table users {', '  id i64 identity', '  primary key (id)', '}']), [['name.duplicate', 8, 'users']]),
    rules_case('name-duplicate-kinds', users(['  code varchar(8)'], ['  index ix_code (code)', '  check ix_code (code <> \'\')']), [['name.duplicate', 8, 'ix_code']]),
    rules_case('name-duplicate-used-document', ['dbspec 1 shop', '', 'use core { accounts }', '', 'table users {', '  id i64 identity', '  code varchar(16)', '  primary key (id)', '  unique uq_accounts_code (code)', '}'], [['name.duplicate', 9, 'uq_accounts_code']], $core),
    rules_case('name-duplicate-diagram', array_merge(users([]), ['', 'diagram main {', '}', '', 'diagram main {', '}']), [['name.duplicate', 11, 'main']]),
    rules_case('name-duplicate-used-table', ['dbspec 1 shop', '', 'use core { accounts }', '', 'table accounts {', '  id i64 identity', '  primary key (id)', '}'], [['name.duplicate', 5, 'accounts']], $core),
    rules_case('type-ranges', users(['  a varchar(0)', '  b varchar(16384)', '  c time(7)', '  d decimal(5,6)', '  e datetime', '  f decimal(0,0)']), [['type', 5, 'varchar'], ['type', 6, 'varchar'], ['type', 7, 'time'], ['type', 8, 'decimal'], ['type', 9, 'datetime'], ['type', 10, 'decimal']]),
    rules_case('column-defaults', users([
        "  a text default 'x'",
        '  b i16 default 32768',
        '  c decimal(5,2) default 1.234',
        "  d varchar(2) default 'abc'",
        "  e date default '2026-02-30'",
        '  f i32 default now',
        "  g datetime(3) default '2026-01-01 00:00:00.1234'",
        "  h time(0) default '24:00:00'",
        "  i uuid default 'not-a-uuid'",
        '  j bool default 1',
        '  k i64 null default null',
        '  l decimal(5,2) default 1234.5',
        '  m i32 default 1.5',
        '  n f64 default true',
    ]), [['column', 5, 'default'], ['column', 6, '32768'], ['column', 7, '1.234'], ['column', 8, "'abc'"], ['column', 9, "'2026"], ['column', 10, 'now'], ['column', 11, "'2026"], ['column', 12, "'24"], ['column', 13, "'not"], ['column', 14, '1'], ['column', 15, 22], ['column', 16, '1234.5'], ['column', 17, '1.5'], ['column', 18, 'true']]),
    rules_case('column-identity', ['dbspec 1 shop', '', 'table users {', '  id i64 null identity', '  other i64 identity', '  code i64', '  primary key (id)', '}'], [['column', 4, 'identity'], ['column', 5, 'identity'], ['key', 7, 'id)']]),
    rules_case('column-identity-default', users(['  seq i64 identity default 1']), [['column', 5, 'identity'], ['column', 5, 'default']]),
    rules_case('key-rules', array_merge(users(['  a varchar(320)', '  b varchar(321)', '  c bytes', '  n i64 null'], [
        '  primary key (id)',
        '  unique uq_users_ab (a, b)',
        '  index ix_users_aa (a, a)',
        '  index ix_users_x (x)',
        '  index ix_users_c (c)',
        '  unique uq_users_n (n)',
    ])), [['key', 10, 'primary'], ['key', 11, 'uq_users_ab'], ['key', 12, 'a)'], ['key', 13, 'x)'], ['key', 14, 'c)']]),
    rules_case('key-seventeen-columns', users(array_map(static fn(int $i): string => "  c$i i32", range(1, 17)), ['  index ix_users_many (c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12, c13, c14, c15, c16, c17)']), [['key', 23, 'ix_users_many']]),
    rules_case('key-nullable-primary', ['dbspec 1 shop', '', 'table users {', '  id i64 null', '  primary key (id)', '}'], [['key', 5, 'id)']]),
    rules_case('foreign-key-rules', ['dbspec 1 shop', '', 'use core { accounts }', '', 'table orders {', '  id i64 identity',
        '  account_id i32', '  code varchar(16)', '  pair_a i64', '  pair_b i64',
        '  primary key (id)',
        '  index ix_orders_account (account_id, code)',
        '  index ix_orders_pair (pair_a, pair_b)',
        '  index ix_orders_code (code)',
        '  foreign key fk_orders_type (account_id) references accounts (id)',
        '  foreign key fk_orders_nokey (code) references orders (code)',
        '  foreign key fk_orders_missing (pair_a) references nowhere (id)',
        '  foreign key fk_orders_arity (pair_a, pair_b) references orders (id)',
        '  foreign key fk_orders_column (zzz) references orders (id)',
        '  foreign key fk_orders_target (pair_a) references orders (zzz)',
        '}'], [['foreign_key', 15, 'fk_orders_type'], ['foreign_key', 16, 'fk_orders_nokey'], ['foreign_key', 17, 'nowhere'], ['foreign_key', 18, 'fk_orders_arity'], ['foreign_key', 19, 'zzz'], ['foreign_key', 20, 'zzz']], $core),
    rules_case('check-rules', users(['  a i32', "  b varchar(8)"], [
        '  check ck_users_mod (a % 2 = 0)',
        '  check ck_users_unknown (zzz > 1)',
        '  check ck_users_chain (a < 1 < 2)',
        '  check ck_users_empty ()',
        '  check ck_users_upper (a > 1 AND a < 3)',
    ]), [['check', 8, '%'], ['check', 9, 'zzz'], ['check', 10, '< 2'], ['check', 11, ')'], ['check', 12, 'AND']]),
    rules_case('check-set-null-column', ['dbspec 1 shop', '', 'table users {', '  id i64 identity', '  parent_id i64 null', '  primary key (id)', '  index ix_users_parent (parent_id)',
        '  foreign key fk_users_parent (parent_id) references users (id) on delete restrict on update set_null',
        '  check ck_users_parent (parent_id is null or parent_id <> id)', '}'], [['check', 9, 'parent_id is']]),
    rules_case('check-typed-rules', users(['  qty i32', '  active bool', '  at_a time(0)', '  at_b time(3)', '  name varchar(8)'], [
        '  check ck_users_bool_ordering (active >= false)',
        '  check ck_users_time_precision (at_a < at_b)',
        '  check ck_users_read_first (name = 1 + 2)',
        '  check ck_users_in_literal (1 in (1, 2))',
        '  check ck_users_literal_alone (qty > 0 or (true))',
        '  check ck_users_spaced_minus (qty > - 1)',
        '  check ck_users_column_minus (-qty < 0)',
        '  check ck_users_bool_literal_ordering (qty < true)',
        '  check ck_users_first_type (name = 1 and qty = 1.5)',
        "  check ck_users_type_before_unknown (qty = 'x' or zzz > 0)",
        '  check ck_users_not_operator (not (qty > 1))',
        '  check ck_users_between (qty between 1 and 2)',
        '  check ck_users_not_between (qty not between 1 and 2)',
        '  check ck_users_bool_alone (active)',
        '  check ck_users_alone_before_and (active and qty > 0)',
        '  check ck_users_alone_in_group (qty > 0 or (active))',
    ]), [['check', 11, '>= false'], ['check', 12, 'at_b'], ['check', 13, '+'], ['check', 14, '1 in'], ['check', 15, 'true'], ['check', 16, '-'], ['check', 17, '-'], ['check', 18, '<'], ['check', 19, '1 and'], ['check', 20, "'x'"], ['check', 21, 'not ('], ['check', 22, 'between 1'], ['check', 23, 'not between'], ['check', 24, 'active)'], ['check', 25, 'active and'], ['check', 26, 'active)']]),
    rules_case('setting-rules', users(['  name varchar(8)', '  secret bytes', '  stamp datetime(6)', '  version i32 null'], [
        '  settings {',
        '    updated name',
        '    updated stamp',
        '    soft_delete stamp',
        '    select explicit secret secret',
        '    codec secret aes rot13',
        '    aes_version version',
        '    blind_index secret name',
        '    navigation fk_none users_of parent',
        '    immutable',
        '    immutable',
        '  }',
    ]), [['setting', 11, 'name'], ['setting', 12, 'updated'], ['setting', 13, 'stamp'], ['setting', 14, 28], ['setting', 15, 'rot13'], ['setting', 16, 17], ['setting', 17, 'name'], ['setting', 18, 'fk_none'], ['setting', 20, 'immutable']]),
    rules_case('setting-aes-without-version', users(['  secret bytes'], ['  settings {', '    codec secret aes', '  }']), [['setting', 8, 'codec']]),
    rules_case('setting-immutable-cascade-child', ['dbspec 1 shop', '', 'table users {', '  id i64 identity', '  parent_id i64 null', '  primary key (id)', '  index ix_users_parent (parent_id)',
        '  foreign key fk_users_parent (parent_id) references users (id) on delete cascade on update restrict', '  settings {', '    immutable', '  }', '}'], [['setting', 10, 'immutable']]),
    rules_case('setting-audit-shape', ['dbspec 1 shop', '', 'table service {', '  id i64 identity', '  audit_seq i32', '  primary key (id)', '  index ix_service_audit (audit_seq)',
        '  foreign key fk_service_audit (audit_seq) references audit (seq) on delete restrict on update restrict', '  settings {',
        '    audit into service_history column audit_seq references audit action change previous previous_audit_seq', '  }', '}', '',
        'table service_history {', '  history_id i64', '  change varchar(16)', '  previous_audit_seq i64', '  id i64', '  extra i32', '  primary key (history_id)', '}', '',
        'table audit {', '  seq i32', '  primary key (seq)', '}'],
        [['setting', 10, 'service_history'], ['setting', 10, 'service_history'], ['setting', 10, 'service_history'], ['setting', 10, 'service_history'], ['setting', 10, 'change'], ['setting', 10, 'previous_audit_seq']]),
    rules_case('use-unknown-table', ['dbspec 1 shop', '', 'use core { accounts, ghosts }', '', 'table users {', '  id i64 identity', '  primary key (id)', '}'], [['use', 3, 'ghosts']], $core),
    rules_case('use-invalid-document', ['dbspec 1 shop', '', 'use broken { accounts }'], [['use', 3, 'broken']], ['broken' => ['dbspec 1 broken', '', 'table accounts {', '  Id i64', '}']]),
    rules_case('use-header-mismatch', ['dbspec 1 shop', '', 'use core { accounts }'], [['use', 3, 'core']], ['core' => ['dbspec 1 other', '', 'table accounts {', '  id i64 identity', '  primary key (id)', '}']]),
    rules_case('diagram-rules', array_merge(users([]), ['', 'diagram main {', '  users at 1 2', '  users at 3 4', '  users at 1.5 2', '}']), [['diagram', 10, 'users'], ['diagram', 11, 'users'], ['diagram', 11, '1.5']]),
    rules_case('codec-storage-type', users(['  a varchar(64)', '  b bytes', '  c text'], ['  settings {', '    codec a gz', '    codec b base64', '    codec c yaml ordered_json', '  }']), [['setting', 10, 11], ['setting', 11, 11], ['setting', 12, 'ordered_json']]),
    rules_case('blind-index-shape', users(
        ['  s1 bytes', '  s2 bytes', '  s3 bytes', '  s4 bytes', '  version i32', '  short_hash varchar(32)', '  pair_hash varchar(64)', '  null_hash varchar(64) null'],
        ['  index ix_users_short (short_hash)', '  index ix_users_pair (pair_hash, version)', '  index ix_users_null (null_hash)', '  settings {',
            '    codec s1 aes', '    codec s2 aes', '    codec s3 aes', '    codec s4 aes', '    aes_version version',
            '    blind_index s1 short_hash', '    blind_index s2 pair_hash', '    blind_index s3 null_hash', '    blind_index s4 s1', '    blind_index s1 pair_hash', '  }']),
        [['setting', 23, 'short_hash'], ['setting', 24, 'pair_hash'], ['setting', 25, 'null_hash'], ['setting', 26, 20], ['setting', 27, 'blind_index']]),
    rules_case('audit-action-nullable', ['dbspec 1 shop', '', 'table service {', '  id i64 identity', '  audit_seq i64', '  deleted_at datetime(6) null', '  primary key (id)', '  index ix_service_audit (audit_seq)',
        '  foreign key fk_service_audit (audit_seq) references audit (seq) on delete restrict on update restrict', '  settings {', '    soft_delete deleted_at',
        '    audit into service_history column audit_seq references audit action change previous previous_audit_seq', '  }', '}', '',
        'table service_history {', '  history_id i64 identity', '  change varchar(8) null', '  previous_audit_seq i64 null', '  id i64', '  audit_seq i64', '  deleted_at datetime(6) null', '  primary key (history_id)', '}', '',
        'table audit {', '  seq i64 identity', '  primary key (seq)', '}'],
        [['setting', 12, 'change']]),
    rules_case('audit-record-table-audited', ['dbspec 1 shop', '', 'table service {', '  id i64 identity', '  audit_seq i64', '  deleted_at datetime(6) null', '  primary key (id)', '  index ix_service_audit (audit_seq)',
        '  foreign key fk_service_audit (audit_seq) references service (id) on delete restrict on update restrict', '  settings {', '    soft_delete deleted_at',
        '    audit into service_history column audit_seq references service action change previous previous_audit_seq', '  }', '}', '',
        'table service_history {', '  history_id i64 identity', '  change varchar(8)', '  previous_audit_seq i64 null', '  id i64', '  audit_seq i64', '  deleted_at datetime(6) null', '  primary key (history_id)', '}'],
        [['setting', 12, 'service action']]),
    rules_case('used-documents-repeat-constraint', ['dbspec 1 shop', '', 'use a { ta }', 'use b { tb }'], [['name.duplicate', 4, 'b {']], [
        'a' => ['dbspec 1 a', '', 'table ta {', '  id i64 identity', '  code varchar(8)', '  primary key (id)', '  unique uq_code (code)', '}'],
        'b' => ['dbspec 1 b', '', 'table tb {', '  id i64 identity', '  code varchar(8)', '  primary key (id)', '  unique uq_code (code)', '}'],
    ]),
    rules_case('malformed-reference', ['dbspec 1 shop', '', 'table orders {', '  id i64 identity', '  user_id i64', '  primary key (id)', '  index ix_orders_user (user_id)', '  foreign key fk_orders_user (user_id) references Users (id)', '}'], [['name.format', 8, 'Users']]),
    rules_case('constraint-named-like-used-table', ['dbspec 1 shop', '', 'use core { accounts }', '', 'table users {', '  id i64 identity', '  primary key (id)', '  index accounts (id)', '}'], [['name.duplicate', 8, 'accounts']], $core),
];

$normalize = [
    [
        'id' => 'literals-settings-and-comments',
        'documents' => [
            'core' => ['dbspec 1 core', '', 'table accounts {', '  id i64 identity', '  primary key (id)', '}'],
            'audit' => ['dbspec 1 audit', '', 'table logs {', '  id i64 identity', '  primary key (id)', '}'],
            'shop' => [
                'dbspec 1 shop',
                '# core comes second',
                'use core { accounts }',
                'use audit { logs }',
                'table users {',
                '  id i64 identity',
                '  account_id i64',
                '  token uuid default \'0A0B0C0D-0000-4000-8000-00000000000F\'',
                '  small i16 default -0',
                '  big i64 default 007',
                '  ratio f64 default 001.500',
                '  at time(3) default \'01:02:03\'',
                '  born date default \'2026-01-02\'',
                '  nick varchar(8) default \'it\'\'s\'',
                '  secret bytes null',
                '  version i32',
                '  removed datetime(6) null',
                '  primary key (id)',
                '  # sorted after b',
                '  index ix_users_z (account_id)',
                '  index ix_users_b (born desc, at asc)',
                '  foreign key fk_users_account (account_id) references accounts (id) on update restrict',
                '  check ck_users_small (small in(1,-2 , 3)and((big>=1)and(big<=10 or(big = 20))))',
                '  settings {',
                '    navigation fk_users_account user account',
                '    aes_version version',
                '    codec secret gz aes',
                '    soft_delete removed',
                '    # the model name',
                '    entity user_entity',
                '  }',
                '}',
                '# trailing',
            ],
        ],
        'main' => 'shop',
        'canonical' => [
            'dbspec 1 shop',
            '',
            'use audit { logs }',
            '# core comes second',
            'use core { accounts }',
            '',
            'table users {',
            '  id i64 identity',
            '  account_id i64',
            '  token uuid default \'0a0b0c0d-0000-4000-8000-00000000000f\'',
            '  small i16 default 0',
            '  big i64 default 7',
            '  ratio f64 default 1.5',
            '  at time(3) default \'01:02:03.000\'',
            '  born date default \'2026-01-02\'',
            '  nick varchar(8) default \'it\'\'s\'',
            '  secret bytes null',
            '  version i32',
            '  removed datetime(6) null',
            '  primary key (id)',
            '  index ix_users_b (born desc, at)',
            '  # sorted after b',
            '  index ix_users_z (account_id)',
            '  foreign key fk_users_account (account_id) references accounts (id) on delete restrict on update restrict',
            '  check ck_users_small (small in (1, -2, 3) and big >= 1 and (big <= 10 or big = 20))',
            '  settings {',
            '    # the model name',
            '    entity user_entity',
            '    soft_delete removed',
            '    codec secret gz aes',
            '    aes_version version',
            '    navigation fk_users_account user account',
            '  }',
            '}',
            '',
            '# trailing',
        ],
    ],
];

$normalize[] = [
    'id' => 'f64-shortest',
    'documents' => ['shop' => ['dbspec 1 shop', '', 'table users {', '  id i64 identity', '  a f64 default 0.100000000000000005551', '  b f64 default 100.0', '  primary key (id)', '}']],
    'main' => 'shop',
    'canonical' => ['dbspec 1 shop', '', 'table users {', '  id i64 identity', '  a f64 default 0.1', '  b f64 default 100', '  primary key (id)', '}'],
];

$normalize[] = [
    'id' => 'check-typed-operands',
    'documents' => ['shop' => users(['  small i16', '  big i64', '  price decimal(13,2)', '  cost decimal(8,2)', '  ratio f64', '  name varchar(8)', '  note text', '  at_a datetime(6)', '  at_b datetime(6)'], [
        "  check ck_users_columns (small <= big and cost <= price and name <> note and at_a < at_b)",
        "  check ck_users_left_literal (0 < price and -007 < small and '2100-01-01 00:00:00' > at_a)",
        "  check ck_users_ranges (ratio >= 0.0 and ratio <= 1.50 and note in ('a', 'it''s'))",
    ])],
    'main' => 'shop',
    'canonical' => users(['  small i16', '  big i64', '  price decimal(13,2)', '  cost decimal(8,2)', '  ratio f64', '  name varchar(8)', '  note text', '  at_a datetime(6)', '  at_b datetime(6)'], [
        "  check ck_users_columns (small <= big and cost <= price and name <> note and at_a < at_b)",
        "  check ck_users_left_literal (0.00 < price and -7 < small and '2100-01-01 00:00:00.000000' > at_a)",
        "  check ck_users_ranges (ratio >= 0 and ratio <= 1.5 and note in ('a', 'it''s'))",
    ]),
];

$canonical = [
    [
        'id' => 'closing-comments-and-bounds',
        'documents' => ['shop' => [
            'dbspec 1 shop', '', 'table users {', '  id i64 identity', '  ratio f64 default 0.000000125', '  primary key (id)', '  # before the end of the table', '}', '',
            'diagram main {', '  users at -2147483648 2147483647', '  # before the end of the diagram', '}', '', '# end of document',
        ]],
        'main' => 'shop',
    ],
    [
        'id' => 'every-setting',
        'documents' => ['shop' => [
            'dbspec 1 shop',
            '',
            'table service {',
            '  id i64 identity',
            '  parent_id i64 null',
            '  audit_id uuid',
            '  secret text null',
            '  secret_hash varchar(64) null',
            '  key_version i16',
            '  changed_at datetime(0)',
            '  deleted_at datetime(6) null',
            '  primary key (id)',
            '  index ix_service_audit (audit_id)',
            '  index ix_service_hash (secret_hash)',
            '  index ix_service_parent (parent_id)',
            '  foreign key fk_service_audit (audit_id) references audit (id) on delete restrict on update restrict',
            '  foreign key fk_service_parent (parent_id) references service (id) on delete restrict on update restrict',
            '  check ck_service_version (key_version >= 1 and key_version <= 100 and secret is not null or key_version not in (0, -1))',
            '  settings {',
            '    entity service_entity',
            '    updated changed_at',
            '    soft_delete deleted_at',
            '    select explicit secret secret_hash',
            '    codec secret ordered_json aes base64',
            '    aes_version key_version',
            '    blind_index secret secret_hash',
            '    navigation fk_service_parent children parent',
            '    immutable',
            '    audit into service_history column audit_id references audit action change previous previous_audit_id',
            '  }',
            '}',
            '',
            'table service_history {',
            '  history_id i64 identity',
            '  change varchar(8)',
            '  previous_audit_id uuid null',
            '  id i64',
            '  parent_id i64 null',
            '  audit_id uuid',
            '  secret text null',
            '  secret_hash varchar(64) null',
            '  key_version i16 null',
            '  changed_at datetime(0)',
            '  deleted_at datetime(6) null',
            '  primary key (history_id)',
            '}',
            '',
            'table audit {',
            '  id uuid',
            '  primary key (id)',
            '}',
            '',
            'diagram main {',
            '  service at -10 20',
            '  service_history at 300 20',
            '}',
        ]],
        'main' => 'shop',
    ],
];

$counts = [
    'canonical' => dbspec_run_cases('canonical', $canonical, 2.0),
    'normalize' => dbspec_run_cases('normalize', $normalize, 2.0),
    'invalid' => dbspec_run_cases('invalid', $invalid, 2.0),
];

// Limits: generated documents, each with its own deadline.
$limit = static function (string $id, string $text, array $want): void {
    $clock = cpuCaseBegin("limit/$id", 20.0);
    $result = Orm\Dbspec\Dbspec::parse($text, []);
    $got = array_map(static fn(Orm\Dbspec\Diagnostic $d): array => [$d->rule, $d->line, $d->column], $result->diagnostics);
    if ($result->document !== null || $got !== [$want]) {
        throw new RuntimeException("limit/$id: want " . json_encode([$want]) . ' got ' . json_encode($got));
    }
    testcase_step('peakBytes=' . memory_get_peak_usage(true));
    cpuCaseEnd("limit/$id", $clock);
};
$size = 32 * 1024 * 1024 + 1;
$text = str_pad("dbspec 1 shop\n", $size, "\n");
$limit('size', $text, ['limit', 1, 1]);
unset($text);
$tables = "dbspec 1 shop\n";
for ($i = 0; $i < 4097; $i++) {
    $tables .= "\ntable t$i {\n  id i64 identity\n  primary key (id)\n}\n";
}
$limit('tables', $tables, ['limit', 3 + 4096 * 5, 1]);
unset($tables);
$columns = "dbspec 1 shop\n\ntable t {\n";
for ($i = 0; $i < 1001; $i++) {
    $columns .= "  c$i i64\n";
}
$columns .= "  primary key (c0)\n}\n";
$limit('table-columns', $columns, ['limit', 4 + 1000, 3]);
unset($columns);
$all = "dbspec 1 shop\n";
for ($t = 0; $t < 121; $t++) {
    $all .= "\ntable t$t {\n";
    for ($i = 0; $i < 1000; $i++) {
        $all .= "  c$i i64\n";
    }
    $all .= "  primary key (c0)\n}\n";
}
// Column 120001 is the first column of table 121 (index 120).
$limit('columns', $all, ['limit', 4 + 120 * 1004, 3]);
unset($all);
$fks = "dbspec 1 shop\n";
$line = 1;
for ($t = 0; $t < 21; $t++) {
    $fks .= "\ntable t$t {\n  id i64 identity\n  primary key (id)\n";
    $line += 4;
    for ($i = 0; $i < 1000; $i++) {
        $fks .= "  foreign key fk_{$t}_$i (id) references t$t (id)\n";
        $line++;
        if ($t === 20 && $i === 0) {
            $fkLine = $line;
        }
    }
    $fks .= "}\n";
    $line++;
}
$limit('foreign-keys', $fks, ['limit', $fkLine, 3]);
unset($fks);

// 모든 rule case를 합친 CPU 시간을 출력하고, 60 s 기준값을 넘으면 경고한다.
testcase_begin('dbspec_rules/cpu-total', TESTCASE_COMPUTE);
[$cpuMs, $wallMs] = caseClockElapsed($started);
if ($cpuMs > 60000) {
    testcase_warning(sprintf('dbspec_rules used %.3f ms of CPU (%.3f ms wall), above its reference of 60 s; machine %s %s, PHP %s', $cpuMs, $wallMs, PHP_OS_FAMILY, php_uname('m'), PHP_VERSION));
}
testcase_step("canonical={$counts['canonical']} normalize={$counts['normalize']} invalid={$counts['invalid']} limits=5 cpuMs=$cpuMs wallMs=$wallMs");
testcase_end();
