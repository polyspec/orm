// dbspec rules that tests/dbspec/cases.json does not cover yet: each invalid
// case lists its exact diagnostics (rule, line, column) in source order, and
// each normalize case its canonical text.
//
// Usage: node --test clients/typescript/tests/dbspec-rules.mjs (after the build)
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { emitDbspec, parseDbspec } from '../dist/dbspec/index.js';
import * as api from '../dist/index.js';

const TIMEOUT = 15000;

function rule(name, body) {
  test(name, { timeout: TIMEOUT }, async () => {
    const started = performance.now();
    console.log(`start ${name}`);
    try {
      await body();
    } catch (error) {
      console.log(`fail ${name} ${(performance.now() - started).toFixed(1)} ms`);
      throw error;
    }
    console.log(`pass ${name} ${(performance.now() - started).toFixed(1)} ms`);
  });
}

const text = lines => lines.join('\n') + '\n';
const users = ['table users {', '  id i64 identity', '  primary key (id)', '}'];

function invalid(name, lines, errors, documents = {}) {
  rule(`invalid ${name}`, () => {
    const result = parseDbspec(typeof lines === 'string' ? lines : text(lines), documents);
    assert.equal(result.document, null);
    assert.deepEqual(
      result.diagnostics.map(d => [d.rule, d.line, d.column]),
      errors,
      result.diagnostics.map(d => `${d.rule} ${d.line}:${d.column} ${d.message}`).join('\n'),
    );
  });
}

function normalize(name, lines, canonical, documents = {}) {
  rule(`normalize ${name}`, () => {
    const result = parseDbspec(text(lines), documents);
    assert.deepEqual(result.diagnostics, []);
    const emitted = emitDbspec(result.document);
    assert.equal(emitted, text(canonical));
    assert.equal(emitDbspec(parseDbspec(emitted, documents).document), emitted);
  });
}

// encoding, header and limit stop parsing
invalid('byte order mark', '﻿dbspec 1 shop\n', [['encoding', 1, 1]]);
invalid('bare CR', 'dbspec 1 shop\n\ntable users {\r  id i64\n}\n', [['encoding', 3, 14]]);
invalid('unpaired surrogate', "dbspec 1 shop\n# \uD800\ntable Users {\n", [['encoding', 2, 3]]);
invalid('final bare CR', 'dbspec 1 shop\r', [['encoding', 1, 14]]);
invalid('version 2', ['dbspec 2 shop', 'table Users {'], [['header', 1, 8]]);
invalid('header without name', ['dbspec 1'], [['header', 1, 9]]);
invalid('header extra token', ['dbspec 1 shop extra'], [['header', 1, 15]]);
invalid('leading blank line', ['', 'dbspec 1 shop'], [['header', 1, 1]]);
rule('invalid 32 MiB document', () => {
  const big = 'dbspec 1 shop\n' + '#'.repeat(32 * 1024 * 1024 - 14) + '\n';
  assert.deepEqual(parseDbspec(big, {}).diagnostics.map(d => [d.rule, d.line, d.column]), [['limit', 1, 1]]);
  const multibyte = 'dbspec 1 shop\n# ' + 'é'.repeat((32 * 1024 * 1024 - 16) / 2) + '\n';
  assert.equal(Buffer.byteLength(multibyte), 32 * 1024 * 1024 + 1);
  assert.deepEqual(parseDbspec(multibyte, {}).diagnostics.map(d => d.rule), ['limit']);
  assert.deepEqual(parseDbspec(multibyte.slice(0, -2) + '\n', {}).diagnostics, []);
});
rule('invalid 4097 tables', () => {
  const lines = ['dbspec 1 shop'];
  for (let i = 0; i < 4097; i++) lines.push(`table t${i} {`, '  id i64 identity', '  primary key (id)', '}');
  const result = parseDbspec(text(lines), {});
  assert.deepEqual(result.diagnostics.map(d => [d.rule, d.line, d.column]), [['limit', 1 + 4096 * 4 + 1, 1]]);
  assert.deepEqual(parseDbspec(text(lines.slice(0, -4)), {}).diagnostics, []);
});
rule('invalid 1001 columns', () => {
  const lines = ['dbspec 1 shop', 'table t {', '  id i64 identity'];
  for (let i = 1; i <= 1000; i++) lines.push(`  c${i} i32`);
  lines.push('  primary key (id)', '}');
  assert.deepEqual(parseDbspec(text(lines), {}).diagnostics.map(d => [d.rule, d.line, d.column]), [['limit', 1003, 3]]);
});

// syntax and order
invalid('syntax and order', [
  'dbspec 1 shop',
  'table users {',
  '  id i64 identity extra',
  '  primary key (id)',
  '  name varchar(8)',
  '  settings {',
  '  }',
  '  index ix_users_name (name)',
  '}',
  'use core { users }',
  'diagram main {',
  '}',
  'table late {',
  '  id i64 identity',
  '  primary key (id)',
  '}',
  'bogus',
], [
  ['syntax', 3, 19],
  ['order', 5, 3],
  ['order', 8, 3],
  ['order', 10, 1],
  ['use', 10, 5],
  ['name.duplicate', 10, 12],
  ['order', 13, 1],
  ['syntax', 17, 1],
]);
invalid('unclosed block', ['dbspec 1 shop', 'table users {', '  id i64 identity', '  primary key (id)'], [['syntax', 2, 13]]);
invalid('unclosed settings and diagram blocks', ['dbspec 1 shop', 'table users {', '  id i64 identity', '  primary key (id)', '  settings {'], [
  ['syntax', 2, 13],
  ['syntax', 5, 12],
]);
invalid('unclosed diagram', ['dbspec 1 shop', ...users, 'diagram main {', '  users at 0 0'], [['syntax', 6, 14]]);
invalid('unterminated string', ['dbspec 1 shop', 'table users {', "  id varchar(8) default 'x", '  primary key (id)', '}'], [['syntax', 3, 25]]);

// names
invalid('duplicate names', [
  'dbspec 1 shop',
  'table users {',
  '  id i64 identity',
  '  id i64',
  '  primary key (id)',
  '  check primary (id > 0)',
  '}',
  'table users {',
  '  id i64 identity',
  '  primary key (id)',
  '}',
  'diagram main {',
  '}',
  'diagram main {',
  '}',
], [
  ['name.duplicate', 4, 3],
  ['name.format', 6, 9],
  ['name.duplicate', 8, 7],
  ['name.duplicate', 14, 9],
]);

// types and columns
invalid('type parameters', [
  'dbspec 1 shop',
  'table t {',
  '  id i64 identity',
  '  a varchar(0)',
  '  b varchar(16384)',
  '  c time(7)',
  '  d datetime',
  '  e i32(4)',
  '  f decimal(5,6)',
  '  primary key (id)',
  '}',
], [
  ['type', 4, 5],
  ['type', 5, 5],
  ['type', 6, 5],
  ['type', 7, 5],
  ['type', 8, 5],
  ['type', 9, 5],
]);
invalid('column combinations and defaults', [
  'dbspec 1 shop',
  'table t {',
  '  id i64 null identity',
  '  k i64 identity default 1',
  "  body text default 'x'",
  '  small i16 default 32768',
  "  code varchar(2) default 'abc'",
  '  amount decimal(5,2) default 1.234',
  '  big decimal(5,2) default 1000',
  "  day date default '2026-02-30'",
  "  at time(2) default '24:00:00'",
  "  stamp datetime(0) default '2026-01-01 00:00:00.5'",
  '  flag bool default 1',
  '  seen date default now',
  "  token uuid default 'not-a-uuid'",
  '  ratio f64 default 1e5',
  '  primary key (id)',
  '}',
], [
  ['column', 3, 15],
  ['column', 4, 9],
  ['column', 4, 9],
  ['column', 4, 18],
  ['column', 5, 13],
  ['column', 6, 21],
  ['column', 7, 27],
  ['column', 8, 31],
  ['column', 9, 28],
  ['column', 10, 20],
  ['column', 11, 22],
  ['column', 12, 29],
  ['column', 13, 21],
  ['column', 14, 21],
  ['column', 15, 22],
  ['column', 16, 21],
  ['key', 17, 16],
]);
invalid('table without columns', ['dbspec 1 shop', 'table t {', '}'], [['column', 2, 7], ['key', 2, 7]]);

// keys
const many = Array.from({ length: 17 }, (_, i) => `c${i}`);
invalid('keys', [
  'dbspec 1 shop',
  'table t {',
  '  id i64 identity',
  '  maybe i32 null',
  ...many.map(c => `  ${c} i32`),
  '  a varchar(400)',
  '  b varchar(241)',
  '  primary key (id)',
  '  primary key (maybe)',
  `  index ix_many (${many.join(', ')})`,
  '  index ix_wide (a, b)',
  '  unique uq_repeat (a, a)',
  '  unique uq_unknown (nope)',
  '}',
], [
  ['key', 25, 3],
  ['key', 25, 16],
  ['key', 26, 9],
  ['key', 27, 9],
  ['key', 28, 24],
  ['key', 29, 22],
]);
invalid('composite identity key', [
  'dbspec 1 shop',
  'table t {',
  '  id i64 identity',
  '  other i64',
  '  primary key (id, other)',
  '}',
], [['column', 3, 10]]);

// foreign keys
invalid('foreign keys', [
  'dbspec 1 shop',
  'table users {',
  '  id i64 identity',
  '  code varchar(8)',
  '  primary key (id)',
  '}',
  'table orders {',
  '  id i64 identity',
  '  user_id i32',
  '  code varchar(8)',
  '  primary key (id)',
  '  index ix_orders_user (user_id, code)',
  '  foreign key fk_type (user_id) references users (id)',
  '  foreign key fk_arity (user_id, code) references users (id)',
  '  foreign key fk_not_key (code) references users (code)',
  '  foreign key fk_target (user_id) references nobody (id)',
  '  foreign key fk_column (nope) references users (id)',
  '}',
], [
  ['foreign_key', 13, 15],
  ['foreign_key', 14, 15],
  ['foreign_key', 15, 15],
  ['foreign_key', 15, 15],
  ['foreign_key', 16, 46],
  ['foreign_key', 17, 26],
]);

// checks
normalize('check expression form', [
  'dbspec 1 shop',
  'table t {',
  '  id i64 identity',
  '  status varchar(8)',
  '  qty i32 null',
  '  primary key (id)',
  "  check ck_t ((qty>=-007 and qty<>0)or status not in('a','it''s') or qty is not null or not qty between 1 and 2.50)",
  '}',
], [
  'dbspec 1 shop',
  '',
  'table t {',
  '  id i64 identity',
  '  status varchar(8)',
  '  qty i32 null',
  '  primary key (id)',
  "  check ck_t ((qty >= -7 and qty <> 0) or status not in ('a', 'it''s') or qty is not null or not qty between 1 and 2.50)",
  '}',
]);
invalid('check outside the neutral set', [
  'dbspec 1 shop',
  'table t {',
  '  id i64 identity',
  '  primary key (id)',
  '  check ck_a (nope > 0)',
  "  check ck_b (id like 'x')",
  '  check ck_c (id > )',
  '  check ck_d (id in (id))',
  '}',
], [
  ['check', 5, 15],
  ['check', 6, 18],
  ['syntax', 7, 20],
  ['check', 8, 22],
]);

// settings
invalid('settings', [
  'dbspec 1 shop',
  'table users {',
  '  id i64 identity',
  '  primary key (id)',
  '}',
  'table t {',
  '  id i64 identity',
  '  user_id i64',
  '  secret bytes',
  '  version i32 null',
  '  name varchar(8)',
  '  changed_at datetime(6)',
  '  primary key (id)',
  '  index ix_t_user (user_id)',
  '  foreign key fk_t_user (user_id) references users (id) on delete cascade',
  '  settings {',
  '    updated name',
  '    updated changed_at',
  '    soft_delete changed_at',
  '    codec secret aes zip',
  '    aes_version version',
  '    blind_index name secret',
  '    navigation fk_nope child parent',
  '    select explicit name name',
  '    immutable',
  '  }',
  '}',
], [
  ['setting', 17, 13],
  ['setting', 18, 5],
  ['setting', 19, 17],
  ['setting', 20, 22],
  ['setting', 21, 17],
  ['setting', 22, 17], // name has no aes stage
  ['setting', 22, 22], // the index column is bytes, not varchar(n >= 64)
  ['setting', 22, 22], // the index column is aes-encoded
  ['setting', 22, 22], // and is not the only column of an index
  ['setting', 23, 16],
  ['setting', 24, 26],
  ['setting', 25, 5],
]);
invalid('aes without aes_version', [
  'dbspec 1 shop',
  'table t {',
  '  id i64 identity',
  '  secret bytes',
  '  primary key (id)',
  '  settings {',
  '    codec secret ordered_json aes',
  '  }',
  '}',
], [['setting', 7, 5]]);
const audited = [
  'dbspec 1 shop',
  'table service {',
  '  id i64 identity',
  '  name varchar(191)',
  '  operation_id i64 null',
  '  primary key (id)',
  '  settings {',
  '    audit into service_history operation operation_id action change previous previous_operation_id',
  '  }',
  '}',
  'table service_history {',
  '  history_id i64 identity',
  '  change varchar(16)',
  '  previous_operation_id i64',
  '  id i64',
  '  name varchar(64)',
  '  extra i32',
  '  primary key (history_id)',
  '  settings {',
  '    soft_delete history_id',
  '    audit into service operation id action name previous id',
  '  }',
  '}',
];
invalid('audit', audited, [
  ['setting', 8, 5], // no soft_delete
  ['setting', 8, 16], // service_history is audited itself
  ['setting', 8, 16], // name varchar(64) differs
  ['setting', 8, 16], // no operation_id copy
  ['setting', 8, 16], // extra column
  ['setting', 8, 42], // nullable operation column
  ['setting', 8, 62], // action is varchar(16)
  ['setting', 8, 78], // previous is not null
  ['setting', 20, 17], // soft_delete on an i64 column
  ['setting', 21, 16], // service is audited itself
  ['setting', 21, 16], // no history_id copy
  ['setting', 21, 16], // no change copy
  ['setting', 21, 16], // no previous_operation_id copy
  ['setting', 21, 16], // name varchar(191) differs
  ['setting', 21, 16], // no extra copy
  ['setting', 21, 16], // operation_id is not a copied column
  ['setting', 21, 44], // action is varchar(191)
  ['setting', 21, 58], // previous is not null
]);
normalize('settings order and comments move with their lines', [
  'dbspec 1 shop',
  'table t {',
  '  id i64 identity',
  '  b bytes',
  '  a bytes',
  '  v i16',
  '  token uuid default \'0E2B5E8C-3B0F-4C59-9A0F-6A2F2C2E1B10\'',
  '  ratio f64 default 0012.500',
  '  zero f64 default -0.0',
  '  primary key (id)',
  '  # second',
  '  unique uq_b (v)',
  '  # first',
  '  unique uq_a (token)',
  '  settings {',
  '    immutable',
  '    # codec of b',
  '    codec b gz',
  '    codec a ordered_json aes',
  '    aes_version v',
  '    select explicit b a',
  '    entity thing',
  '    # closing the settings',
  '  }',
  '}',
  '# end of document',
], [
  'dbspec 1 shop',
  '',
  'table t {',
  '  id i64 identity',
  '  b bytes',
  '  a bytes',
  '  v i16',
  "  token uuid default '0e2b5e8c-3b0f-4c59-9a0f-6a2f2c2e1b10'",
  '  ratio f64 default 12.5',
  '  zero f64 default 0',
  '  primary key (id)',
  '  # first',
  '  unique uq_a (token)',
  '  # second',
  '  unique uq_b (v)',
  '  settings {',
  '    entity thing',
  '    select explicit b a',
  '    codec a ordered_json aes',
  '    # codec of b',
  '    codec b gz',
  '    aes_version v',
  '    immutable',
  '    # closing the settings',
  '  }',
  '}',
  '',
  '# end of document',
]);

// use
const core = text(['dbspec 1 core', '', ...users, '', 'table teams {', '  id i64 identity', '  code varchar(8)', '  primary key (id)', '  unique uq_code (code)', '}']);
invalid('use', [
  'dbspec 1 shop',
  'use core { users, groups }',
  'use broken { x }',
  'use renamed { x }',
  'use core { teams }',
  'table orders {',
  '  id i64 identity',
  '  code varchar(8)',
  '  primary key (id)',
  '  unique uq_code (code)',
  '}',
  'table users {',
  '  id i64 identity',
  '  primary key (id)',
  '}',
], [
  ['use', 2, 19],
  ['use', 3, 5],
  ['use', 4, 5],
  ['name.duplicate', 4, 15],
  ['name.duplicate', 5, 5],
  ['name.duplicate', 10, 10],
  ['name.duplicate', 12, 7],
], { core, broken: 'dbspec 1 broken\ntable X {\n', renamed: 'dbspec 1 other\n' });
invalid('use cycle', ['dbspec 1 shop', 'use core { users }'], [['use', 2, 5]], {
  core: text(['dbspec 1 core', 'use shop { orders }', ...users]),
  shop: text(['dbspec 1 shop', 'table orders {', '  id i64 identity', '  primary key (id)', '}']),
});
normalize('foreign key to a used table and use order', [
  'dbspec 1 shop',
  'use zeta { z }',
  'use core { users }',
  'table orders {',
  '  id i64 identity',
  '  user_id i64 null',
  '  primary key (id)',
  '  index ix_orders_user (user_id)',
  '  foreign key fk_orders_user (user_id) references users (id) on update cascade',
  '}',
], [
  'dbspec 1 shop',
  '',
  'use core { users }',
  'use zeta { z }',
  '',
  'table orders {',
  '  id i64 identity',
  '  user_id i64 null',
  '  primary key (id)',
  '  index ix_orders_user (user_id)',
  '  foreign key fk_orders_user (user_id) references users (id) on delete restrict on update cascade',
  '}',
], { core, zeta: text(['dbspec 1 zeta', 'table z {', '  id i64 identity', '  primary key (id)', '}']) });

// diagrams
invalid('diagrams', [
  'dbspec 1 shop',
  ...users,
  'diagram main {',
  '  users at 1 2',
  '  users at 3 4',
  '}',
  'diagram other {',
  '  users at 1.5 -0x1',
  '}',
], [
  ['diagram', 8, 3],
  ['diagram', 11, 12],
  ['diagram', 11, 16],
]);

// columns count code points, and inputs are strings
invalid('columns count code points', ['dbspec 1 shop', 'table t {', '  id i64 identity', "  name varchar(1) default '\u{1F600}\u{1F600}' x", '  primary key (id)', '}'], [
  ['column', 4, 27],
  ['syntax', 4, 32],
]);
invalid('foreign key actions in grammar order', [
  'dbspec 1 shop',
  ...users,
  'table orders {',
  '  id i64 identity',
  '  user_id i64',
  '  primary key (id)',
  '  index ix_orders_user (user_id)',
  '  foreign key fk_orders_user (user_id) references users (id) on update cascade on delete cascade',
  '}',
], [['syntax', 11, 80]]);
rule('inputs are strings and documents are frozen', () => {
  assert.throws(() => parseDbspec(Buffer.from('dbspec 1 shop\n'), {}), TypeError);
  assert.throws(() => parseDbspec('dbspec 1 shop\n', { core: 1 }), TypeError);
  assert.throws(() => parseDbspec('dbspec 1 shop\n', null), TypeError);
  const result = parseDbspec(text(['dbspec 1 shop', ...users]), {});
  assert(Object.isFrozen(result) && Object.isFrozen(result.document) && Object.isFrozen(result.document.tables[0].columns[0]));
  assert.equal(api.parseDbspec, parseDbspec);
  assert.equal(api.emitDbspec, emitDbspec);
});

// settled rules (T8.1.1)
invalid('codec storage and stage order', [
  'dbspec 1 shop',
  'table t {',
  '  id i64 identity',
  '  doc text',
  '  blob bytes',
  '  note varchar(64)',
  '  packed text',
  '  primary key (id)',
  '  settings {',
  '    codec doc gz ordered_json',
  '    codec blob base64',
  '    codec note serialize',
  '    codec packed ordered_json gz',
  '  }',
  '}',
], [
  ['setting', 10, 18], // ordered_json is not first (the last stage stores text, so doc fits)
  ['setting', 11, 11], // base64 stores text in a bytes column
  ['setting', 13, 11], // gz stores bytes in a text column
]);
invalid('blind index shape', [
  'dbspec 1 shop',
  'table t {',
  '  id i64 identity',
  '  version i32',
  '  email bytes',
  '  short varchar(63)',
  '  loose varchar(64) null',
  '  hash varchar(64)',
  '  primary key (id)',
  '  index ix_t_hash (hash)',
  '  index ix_t_pair (short, loose)',
  '  settings {',
  '    codec email aes',
  '    aes_version version',
  '    blind_index email short',
  '    blind_index email loose',
  '  }',
  '}',
], [
  ['setting', 15, 23], // varchar(63) is too short
  ['setting', 15, 23], // and not the only column of an index
  ['setting', 16, 5], // a second blind_index for email repeats
]);
normalize('blind index accepted', [
  'dbspec 1 shop',
  'table t {',
  '  id i64 identity',
  '  version i32',
  '  email bytes null',
  '  hash varchar(64) null',
  '  primary key (id)',
  '  unique uq_t_hash (hash)',
  '  settings {',
  '    blind_index email hash',
  '    aes_version version',
  '    codec email ordered_json aes',
  '  }',
  '}',
], [
  'dbspec 1 shop',
  '',
  'table t {',
  '  id i64 identity',
  '  version i32',
  '  email bytes null',
  '  hash varchar(64) null',
  '  primary key (id)',
  '  unique uq_t_hash (hash)',
  '  settings {',
  '    codec email ordered_json aes',
  '    aes_version version',
  '    blind_index email hash',
  '  }',
  '}',
]);
invalid('tabs, reserved words and table-named constraints', [
  'dbspec 1 shop',
  '\ttable users {',
  '  id i64 identity',
  '  null i64',
  '  primary key (id)',
  '  unique orders (id)',
  '}',
  'table orders {',
  '  id i64 identity',
  '  primary key (id)',
  '}',
], [
  ['syntax', 2, 1], // the tab is reported and the line is still read
  ['name.format', 4, 3],
  ['name.duplicate', 8, 7], // the later of the constraint and the table
]);
invalid('constraint named like a used table', ['dbspec 1 shop', 'use core { users }', 'table orders {', '  id i64 identity', '  primary key (id)', '  index teams (id)', '}'], [
  ['name.duplicate', 6, 9],
], { core });
invalid('references to failed lines report nothing more', [
  'dbspec 1 shop',
  'use core { users users2',
  'table orders {',
  '  id i64 identity',
  '  user_id (i64',
  '  primary key (id)',
  '  index ix_orders_user (user_id)',
  '  foreign key fk_orders_user (user_id) references users (id)',
  '  check ck_orders_user (user_id > 0)',
  '}',
], [
  ['syntax', 2, 18],
  ['syntax', 5, 11],
]);
normalize('empty settings block keeps its comments', [
  'dbspec 1 shop',
  'table users {',
  '  id i64 identity',
  '  primary key (id)',
  '  # no settings yet',
  '  settings {',
  '    # inside',
  '  }',
  '}',
], [
  'dbspec 1 shop',
  '',
  'table users {',
  '  id i64 identity',
  '  primary key (id)',
  '  # no settings yet',
  '  # inside',
  '}',
]);
normalize('f64 shortest decimal without exponent', [
  'dbspec 1 shop',
  'table t {',
  '  id i64 identity',
  '  big f64 default 1000000000000000000000000',
  '  tiny f64 default 0.0000001',
  '  third f64 default 0.33333333333333333333',
  '  primary key (id)',
  '}',
], [
  'dbspec 1 shop',
  '',
  'table t {',
  '  id i64 identity',
  '  big f64 default 1000000000000000000000000',
  '  tiny f64 default 0.0000001',
  '  third f64 default 0.3333333333333333',
  '  primary key (id)',
  '}',
]);
invalid('blind index column is not bytes', [
  'dbspec 1 shop',
  'table t {',
  '  id i64 identity',
  '  version i32',
  '  email bytes',
  '  hash bytes',
  '  primary key (id)',
  '  settings {',
  '    codec email aes',
  '    aes_version version',
  '    blind_index email hash',
  '  }',
  '}',
], [
  ['setting', 11, 23], // bytes is not varchar(n >= 64)
  ['setting', 11, 23], // and is not the only column of an index (bytes cannot be indexed)
]);
