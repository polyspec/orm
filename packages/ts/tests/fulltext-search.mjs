// The full-text predicates (PRT-75): the fulltext_boolean normalization of DIA-6, and the match each dialect renders over
// the columns, with SQLite refusing the predicate (DIA-187).
import assert from 'node:assert/strict';
import { fulltextBoolean, transformParam } from '../dist/bind_check.js';
import { dialectOf } from '../dist/engine/dialect.js';
import { Author, CORE, Engine } from '../dist/index.js';
import { parseChain as parseRuntimeChain } from '../dist/names.js';
import { parseChain as parseGeneratedChain } from '../dist/generate/names.js';

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

// Requirements: DSL-32, DSL-33. Generated chains preserve both full-text IR operations and their dialect modes.
const author = new Author();
const method = author.fulltextBooleanNameWithDescription;
assert.equal(typeof method, 'function', 'the documented full-text boolean method resolves on a generated model');
method.call(author, 'alpha beta');
const built = author[CORE].build('all');
assert.deepEqual(built.ir.where.items[0].pred, { op: 'fulltext_boolean', cols: ['name', 'description'], p: 0 });
assert.deepEqual(built.params, ['alpha beta']);
const mysqlPlan = new Engine(Author.entity.model, 'mysql').compile(built.finish());
assert.ok(mysqlPlan.steps[0].sql.includes('MATCH (`a`.`name`, `a`.`description`) AGAINST (? IN BOOLEAN MODE)'));
assert.equal(mysqlPlan.steps[0].bind_slots[0].transform, 'fulltext_boolean');
assert.throws(() => new Engine(Author.entity.model, 'sqlite').compile(built.finish()), error => error.code === 'OPERATOR_NOT_ALLOWED');
const natural = new Author();
natural.fulltextNameWithDescription('alpha');
assert.deepEqual(natural[CORE].build('all').ir.where.items[0].pred, { op: 'fulltext', cols: ['name', 'description'], p: 0 });
assert.deepEqual(parseRuntimeChain(Author.entity.model, Author.entity.entity, 'FulltextBooleanNameWithDescription'), [
  { conn: '', op: 'fulltext_boolean', column: '', columns: ['name', 'description'], compare: '' },
]);
assert.deepEqual(parseGeneratedChain(Author.entity.model, Author.entity.entity, 'FulltextBooleanNameWithDescription'), [
  { conn: '', op: 'fulltext_boolean', column: '', columns: ['name', 'description'], compare: '' },
]);
console.log('fulltext-search: ok');
