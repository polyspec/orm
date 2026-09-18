// Engine test: manifest loading, request validation, plans, and SQL splitting.
// Usage: node tests/typescript/engine.mjs (after npm run typescript:build)
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db, Engine, SCHEMA_HASH, loadManifest, splitSQL } from '../../clients/typescript/dist/index.js';

const schemaPath = new URL('../../schema/schema.json', import.meta.url).pathname;
const text = await readFile(schemaPath, 'utf8');
let failures = 0;
function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL: ${message}`); }
}
function code(fn) {
  try { fn(); return null; } catch (error) { return error.code ?? String(error); }
}
async function codeOf(promise) {
  try { await promise; return null; } catch (error) { return error.code ?? String(error); }
}

check(loadManifest(text).manifest.schema_hash === SCHEMA_HASH, 'the generated models use the loaded schema');
check(code(() => loadManifest(text.replace('"name": "battle"', '"name": "battles"'))) === 'SCHEMA_INVALID', 'an edited manifest is rejected');
check(code(() => loadManifest('{')) === 'SCHEMA_INVALID', 'invalid JSON is rejected');
check(code(() => Engine.load(text, 'oracle')) === 'DIALECT_UNKNOWN', 'unknown dialect');

const work = await mkdtemp(join(tmpdir(), 'orm-ts-engine-'));
try {
  const other = JSON.parse(text);
  const edited = text.replace(`"schema_hash": "${other.schema_hash}"`, '"schema_hash": ""');
  // A valid manifest that no imported models were generated from.
  const { createHash } = await import('node:crypto');
  const compact = JSON.stringify(JSON.parse(edited.replace('"table": "battle"', '"table": "battle_other"')));
  const hash = createHash('sha256').update(compact).digest('hex').slice(0, 16);
  const path = join(work, 'other.json');
  await writeFile(path, compact.replace('"schema_hash":""', `"schema_hash":"${hash}"`));
  check(loadManifest(await readFile(path, 'utf8')).manifest.schema_hash === hash, 'compact manifest hash');
  check(await codeOf(Db.connect(`sqlite://${join(work, 'x.sqlite')}`, path)) === 'SCHEMA_HASH_MISMATCH', 'schema without generated models');
  check(await codeOf(Db.connect(`sqlite://${join(work, 'x.sqlite')}`, join(work, 'missing.json'))) === 'CONFIG', 'missing schema file');
} finally {
  await rm(work, { recursive: true, force: true });
}

const engine = Engine.load(text, 'postgres');
const base = { ir_version: 1, schema_hash: SCHEMA_HASH, entity: 'battle' };
const compileCode = request => code(() => engine.compile(request));
check(compileCode({ ...base, kind: 'all', n_params: 0, where: { items: [{ pred: { column: 'nope', op: 'eq', p: 0 } }] } }) === 'IR_INVALID', 'parameter out of range');
check(compileCode({ ...base, kind: 'all', n_params: 1, where: { items: [{ pred: { column: 'nope', op: 'eq', p: 0 } }] } }) === 'COLUMN_UNKNOWN', 'unknown column');
check(compileCode({ ...base, kind: 'all', n_params: 1, where: { items: [{ pred: { conn: 'or', column: 'seq', op: 'eq', p: 0 } }] } }) === 'OR_AT_GROUP_START', 'or at group start');
check(compileCode({ ...base, kind: 'all', n_params: 0, where: { items: [{ pred: { column: 'seq', op: 'in', ps: [] } }] } }) === 'EMPTY_IN', 'empty in');
check(compileCode({ ...base, kind: 'all', n_params: 1, where: { items: [{ pred: { column: 'json_setting', op: 'eq', p: 0 } }] } }) === 'OPERATOR_NOT_ALLOWED', 'operator on a json column');
check(compileCode({ ...base, kind: 'delete', n_params: 0 }) === 'IR_INVALID', 'delete without where');
check(compileCode({ ...base, schema_hash: 'x', kind: 'all', n_params: 0 }) === 'SCHEMA_HASH_MISMATCH', 'request of another schema');
check(compileCode({ ...base, kind: 'all', n_params: 0, force_index: 'nope' }) === 'INDEX_UNKNOWN', 'unknown index');

const plan = engine.compile({ ...base, kind: 'one', n_params: 2, columns: { mode: 'none' }, where: { items: [{ pred: { column: 'seq', op: 'in', ps: [0, 1] } }] } });
const want = 'SELECT "a"."seq" AS "a__seq", "a"."user_seq" AS "a__user_seq", "a"."service_seq" AS "a__service_seq", "a"."service_module_seq" AS "a__service_module_seq", "a"."service_member_seq" AS "a__service_member_seq" FROM "battle" AS "a" WHERE "a"."seq" IN ($1, $2) LIMIT 1 OFFSET 0';
check(plan.steps.length === 1 && plan.steps[0].sql === want, `plan SQL: ${plan.steps[0].sql}`);
check(plan.steps[0].bind_slots.map(s => s.param).join(',') === '0,1', 'plan binds');

const split = splitSQL("-- note\nCREATE TABLE a (x TEXT DEFAULT 'a;b');\n/* c; */ CREATE FUNCTION f() AS $$ BEGIN; END; $$;\nSELECT 1");
check(split.length === 3 && split[0] === "CREATE TABLE a (x TEXT DEFAULT 'a;b')" && split[1].endsWith('$$') && split[2] === 'SELECT 1', `splitSQL: ${JSON.stringify(split)}`);
check(engine.installStatements().every(s => !s.startsWith('DROP ')), 'install statements never drop tables');

if (failures > 0) {
  console.error(`typescript engine test: ${failures} failure(s)`);
  process.exit(1);
}
console.log('typescript engine test passed');
