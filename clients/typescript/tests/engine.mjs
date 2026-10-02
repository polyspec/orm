// Engine test: the runtime model of the embedded manifest, request validation and plans.
// Usage: node clients/typescript/tests/engine.mjs (after npm run typescript:build)
import { readFile } from 'node:fs/promises';
import { Db, Engine, MANIFEST_HASH, MANIFEST_TEXT, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';

const text = await readFile(new URL('../../../schema/bench.dbspec', import.meta.url), 'utf8');
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

// The generated models embed the manifest of schema/bench.dbspec.
const { manifest } = dbspecManifest([parseDbspec(text, {}).document]);
check(MANIFEST_TEXT === manifest.manifestText && MANIFEST_HASH === manifest.manifestHash, 'the generated models embed the manifest of bench.dbspec');
const model = registerModel(MANIFEST_TEXT, MANIFEST_HASH);
check(registerModel(MANIFEST_TEXT, MANIFEST_HASH) === model, 'registering the same manifest returns the registered model');
check([...model.entities.keys()].join(',') === 'author,user,service,service_region,service_member,composite_account,composite_membership,soft_record,account,project,account_project,task', 'entities in document order');
// 선언한 hash로 가지 않는 text는 그 hash가 이미 등록되어 있어도 SCHEMA_HASH_MISMATCH다.
const edited = MANIFEST_TEXT.replace('table author', 'table authors');
check(edited !== MANIFEST_TEXT, 'the edited manifest text differs');
check(code(() => registerModel(edited, MANIFEST_HASH)) === 'SCHEMA_HASH_MISMATCH', 'an edited manifest text is rejected');
check(registerModel(MANIFEST_TEXT, MANIFEST_HASH) === model, 'a rejected text leaves the registered model');
check(code(() => registerModel(`${MANIFEST_TEXT}# note\n`, manifest.manifestHash.replace(/.$/, '0'))) === 'SCHEMA_INVALID', 'a text that is not a manifest text is rejected');
check(code(() => registerModel('{', 'sha256:00')) === 'SCHEMA_INVALID', 'a text that is not dbspec is rejected');
check(code(() => new Engine(model, 'oracle')) === 'DIALECT_UNKNOWN', 'unknown dialect');
const author = model.entities.get('author');
const field = name => author.fields.find(f => f.name === name);
check(!field('description').selected && field('name').selected && field('price').selected, 'the default select set leaves out only select explicit columns');
check(field('json_setting').stages.join(',') === 'ordered_json' && field('aes_hex_email').stages.join(',') === 'aes,hex' && field('aes_hex_email').blindIndex === 'email_blind_index', 'codec stages and blind index');
check(author.updated === 'updated_ts' && author.aesVersion === 'aes_key_version' && author.identity === 'seq' && model.entities.get('soft_record').softDelete === 'deleted_at', 'settings of the runtime model');

// A request names a manifest that no imported model registered.
check(await codeOf(Db.connect('sqlite:///tmp/orm-engine-unused.sqlite', 'schema/bench.dbspec')) === 'CONFIG', 'connect rejects a string in place of the options object');

const engine = new Engine(model, 'postgres');
const base = { ir_version: 1, manifest_hash: MANIFEST_HASH, entity: 'author' };
const compileCode = request => code(() => engine.compile(request));
check(compileCode({ ...base, kind: 'all', n_params: 0, where: { items: [{ pred: { column: 'nope', op: 'eq', p: 0 } }] } }) === 'IR_INVALID', 'parameter out of range');
check(compileCode({ ...base, kind: 'all', n_params: 1, where: { items: [{ pred: { column: 'nope', op: 'eq', p: 0 } }] } }) === 'COLUMN_UNKNOWN', 'unknown column');
check(compileCode({ ...base, kind: 'all', n_params: 1, where: { items: [{ pred: { conn: 'or', column: 'seq', op: 'eq', p: 0 } }] } }) === 'OR_AT_GROUP_START', 'or at group start');
check(compileCode({ ...base, kind: 'all', n_params: 0, where: { items: [{ pred: { column: 'seq', op: 'in', ps: [] } }] } }) === 'EMPTY_IN', 'empty in');
check(compileCode({ ...base, kind: 'all', n_params: 1, where: { items: [{ pred: { column: 'json_setting', op: 'eq', p: 0 } }] } }) === 'OPERATOR_NOT_ALLOWED', 'operator on a json column');
check(compileCode({ ...base, kind: 'delete', n_params: 0 }) === 'IR_INVALID', 'delete without where');
check(compileCode({ ...base, manifest_hash: 'x', kind: 'all', n_params: 0 }) === 'SCHEMA_HASH_MISMATCH', 'request of another manifest');
check(compileCode({ ...base, kind: 'all', n_params: 0, force_index: 'nope' }) === 'INDEX_UNKNOWN', 'unknown index');

// insert는 identity column 값을, update와 duplicate update는 primary key와 identity
// column 값을 쓰지 못한다. PostgreSQL identity는 명시한 key를 지나 나아가지 않으므로
// (postgres.identity.by_default_not_advanced) 세 dialect 모두 거부한다.
const keyWrites = {
  'cannot set identity column seq': { kind: 'insert', entity: 'service', set: [{ column: 'seq', p: 0 }, { column: 'name', p: 1 }], n_params: 2 },
  'cannot update seq': { kind: 'update', entity: 'service', set: [{ column: 'seq', p: 0 }], where: { items: [{ pred: { column: 'seq', op: 'eq', p: 1 } }] }, n_params: 2 },
  'on_duplicate cannot assign service.seq': { kind: 'insert', entity: 'service', set: [{ column: 'name', p: 0 }], on_duplicate: [{ column: 'seq', p: 1 }], n_params: 2 },
  'on_duplicate cannot assign composite_account.tenant_id': { kind: 'insert', entity: 'composite_account', set: [{ column: 'tenant_id', p: 0 }, { column: 'account_id', p: 1 }, { column: 'name', p: 2 }], on_duplicate: [{ column: 'tenant_id', p: 3 }], n_params: 4 },
};
for (const dialect of ['mysql', 'postgres', 'sqlite']) {
  const keyEngine = new Engine(model, dialect);
  for (const [message, request] of Object.entries(keyWrites)) {
    let error = null;
    try { keyEngine.compile({ ir_version: 1, manifest_hash: MANIFEST_HASH, ...request }); } catch (e) { error = e; }
    check(error?.code === 'IR_INVALID' && String(error?.message).includes(message), `${dialect} key write: want ${message}, got ${error?.code} ${error?.message}`);
  }
}

const plan = engine.compile({ ...base, kind: 'one', n_params: 2, columns: { mode: 'none' }, where: { items: [{ pred: { column: 'seq', op: 'in', ps: [0, 1] } }] } });
const want = 'SELECT "a"."seq" AS "a__seq", "a"."user_seq" AS "a__user_seq", "a"."service_seq" AS "a__service_seq", "a"."service_region_seq" AS "a__service_region_seq", "a"."service_member_seq" AS "a__service_member_seq" FROM "author" AS "a" WHERE "a"."seq" IN ($1, $2) LIMIT 1 OFFSET 0';
check(plan.steps.length === 1 && plan.steps[0].sql === want, `plan SQL: ${plan.steps[0].sql}`);
check(plan.steps[0].bind_slots.map(s => s.param).join(',') === '0,1', 'plan binds');

// 모든 column을 고른 node는 AES key version column을 한 번만 읽고 그 위치를 표시한다.
const allPlan = engine.compile({ ...base, kind: 'one', n_params: 1, columns: { mode: 'all' }, where: { items: [{ pred: { column: 'seq', op: 'eq', p: 0 } }] } });
const allAsm = allPlan.steps[0].assemble;
check(allPlan.steps[0].sql.split('"a"."aes_key_version" AS').length - 1 === 1, `aes_key_version selected once: ${allPlan.steps[0].sql}`);
check(allAsm.aes_version !== undefined && allAsm.columns[allAsm.aes_version].column === 'aes_key_version' && !allAsm.columns[allAsm.aes_version].hidden, `AES version column marked: ${JSON.stringify(allAsm.aes_version)}`);

// Soft delete: reads filter rows with a deleted_at value and a delete
// rewrites to a guarded update that sets the timestamp.
const softRead = engine.compile({ ...base, entity: 'soft_record', kind: 'all', n_params: 0 });
check(softRead.steps[0].sql.includes('"a"."deleted_at" IS NULL'), `soft-delete read filter: ${softRead.steps[0].sql}`);
const softDelete = engine.compile({ ...base, entity: 'soft_record', kind: 'delete', n_params: 1, where: { items: [{ pred: { column: 'seq', op: 'eq', p: 0 } }] } });
check(
  softDelete.steps[0].sql.startsWith('UPDATE "soft_record" SET "deleted_at" = CURRENT_TIMESTAMP') && softDelete.steps[0].sql.includes('"soft_record"."deleted_at" IS NULL'),
  `soft-delete guarded update: ${softDelete.steps[0].sql}`,
);

if (failures > 0) {
  console.error(`typescript engine test: ${failures} failure(s)`);
  process.exit(1);
}
console.log('typescript engine test passed');
