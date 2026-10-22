// The full-text predicates (PRT-75): the fulltext_boolean normalization of DIA-6, and the match each dialect renders over
// the columns, with SQLite refusing the predicate (DIA-187).
import assert from 'node:assert/strict';
import { fulltextBoolean, transformParam } from '../dist/bind_check.js';
import { dialectOf } from '../dist/engine/dialect.js';

const cases = new Map([
  ['alpha beta', '+alpha +beta*'],
  ['  +a  (b) "c"  ', '+a +b +c*'],
  ['one ~ two', '+one +two*'],
  ['', ''],
  ['  \t ', ''],
  ['+ - < > ( ) ~ * " @', ''],
]);
for (const [input, want] of cases) {
  assert.equal(fulltextBoolean(input), want, `fulltextBoolean(${JSON.stringify(input)})`);
}

assert.equal(transformParam('fulltext_boolean', 'alpha beta'), '+alpha +beta*');
assert.throws(() => transformParam('fulltext_boolean', '  '), error => error.code === 'IR_INVALID');

const value = transform => `$[${transform}]`;
const cols = ['p.name', 'p.description'];
const mysql = dialectOf('mysql');
const postgres = dialectOf('postgres');
const sqlite = dialectOf('sqlite');

assert.equal(mysql.fulltext(cols, value, true), 'MATCH (p.name, p.description) AGAINST ($[fulltext_boolean] IN BOOLEAN MODE)');
assert.equal(mysql.fulltext(cols, value, false), 'MATCH (p.name, p.description) AGAINST ($[] IN NATURAL LANGUAGE MODE)');
const doc = "to_tsvector('simple', coalesce(p.name, '') || ' ' || coalesce(p.description, ''))";
assert.equal(postgres.fulltext(cols, value, false), `${doc} @@ plainto_tsquery('simple', $[])`);
assert.equal(postgres.fulltext(cols, value, true), `${doc} @@ websearch_to_tsquery('simple', $[])`);
assert.equal(sqlite.fulltext(cols, value, true), undefined);
console.log('fulltext-search: ok');
