// Engine test: the runtime model of the embedded manifest, request validation and plans.
// Usage: node packages/ts/tests/engine.mjs (after npm run typescript:build)
import { readFile } from 'node:fs/promises';
import { Db, EXTERNAL_TEXT, Engine, MANIFEST_HASH, MANIFEST_TEXT, dbspecManifest, loadSet, parseDbspec, parseDbspecSet, registerModel } from '../dist/index.js';
import { decodeRequest, validate } from '../dist/engine/validate.js';
import { parse as parseJson, stringify as stringifyJson } from '@polyspec/ordered-json';
import { caseTest, cases, COMPUTE } from '../../../tests/testcase.mts';

const text = await readFile(new URL('../../../contracts/fixtures/bench/bench.dbs', import.meta.url), 'utf8');
const bench = name => readFile(new URL(`../../../contracts/fixtures/bench/${name}`, import.meta.url), 'utf8');
// The bench set of contracts/fixtures/bench/dbspec-set.json: its owned documents and its external document.
const setDocuments = parseDbspecSet([text, await bench('bench_reader.dbs')], [await bench('bench_shared.dbs')]).map(r => r.document);
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

// The engine check runs model registration, request validation, and the plan in memory as one case.
const run = cases();
await run.run('engine', COMPUTE, async () => {
  // The generated models embed the manifest and the external text of the bench set (contracts/fixtures/bench/dbspec-set.json).
  const { manifest } = dbspecManifest(setDocuments);
  check(MANIFEST_TEXT === manifest.manifestText && MANIFEST_HASH === manifest.manifestHash && EXTERNAL_TEXT === manifest.externalText, 'the generated models embed the manifest of the bench set');
  const model = registerModel(MANIFEST_TEXT, MANIFEST_HASH, EXTERNAL_TEXT);
  check(registerModel(MANIFEST_TEXT, MANIFEST_HASH, EXTERNAL_TEXT) === model, 'registering the same manifest returns the registered model');
  check([...model.entities.keys()].join(',') === 'author,user,service,service_region,service_member,composite_account,composite_membership,soft_record,soft_link,account,project,account_project,task,hex_cell,time_cell,clock_cell,day_cell,upsert_cell,uuid_cell,bind_cell,note_reader,shared_note', 'entities in document order');
  // Text that does not hash to the declared hash is SCHEMA_HASH_MISMATCH, even if that hash is already registered.
  const edited = MANIFEST_TEXT.replace('table author', 'table authors');
  check(edited !== MANIFEST_TEXT, 'the edited manifest text differs');
  check(code(() => registerModel(edited, MANIFEST_HASH, EXTERNAL_TEXT)) === 'SCHEMA_HASH_MISMATCH', 'an edited manifest text is rejected');
  check(registerModel(MANIFEST_TEXT, MANIFEST_HASH, EXTERNAL_TEXT) === model, 'a rejected text leaves the registered model');
  check(code(() => registerModel(`${MANIFEST_TEXT}# note\n`, manifest.manifestHash.replace(/.$/, '0'))) === 'SCHEMA_INVALID', 'a text that is not a manifest text is rejected');
  check(code(() => registerModel('{', 'sha256:00')) === 'SCHEMA_INVALID', 'a text that is not dbspec is rejected');
  check(code(() => new Engine(model, 'oracle')) === 'DIALECT_UNKNOWN', 'unknown dialect');
  const author = model.entities.get('author');
  const field = name => author.fields.find(f => f.name === name);
  check(!field('description').selected && field('name').selected && field('price').selected, 'the default select set leaves out only select explicit columns');
  check(field('json_setting').stages.join(',') === 'ordered_json' && field('aes_hex_email').stages.join(',') === 'aes,hex' && field('aes_hex_email').blindIndex === 'email_blind_index', 'codec stages and blind index');
  check(author.updated === 'updated_ts' && author.aesVersion === 'aes_key_version' && author.identity === 'seq' && model.entities.get('soft_record').softDelete === 'deleted_at', 'settings of the runtime model');

  // A request names a manifest that no imported model registered.
  check(await codeOf(Db.connect('sqlite:///tmp/orm-engine-unused.sqlite', 'contracts/fixtures/bench/bench.dbs')) === 'CONFIG', 'connect rejects a string in place of the options object');

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

  // A relation links all parts of a foreign key in key order, and an invalid key list is rejected.
  const compositeRelation = keys => ({ ir_version: 1, manifest_hash: MANIFEST_HASH, entity: 'composite_account', kind: 'all', n_params: 0, relations: [{ rel: 'memberships', kind: 'many', keys, query: { entity: 'composite_membership' } }] });
  {
    const plan = engine.compile(compositeRelation([{ left: 'tenant_id', right: 'tenant_id' }, { left: 'account_id', right: 'account_id' }]));
    check(plan.steps.length === 2 && plan.steps[1].parent?.keys.length === 2, 'the composite relation step binds two parent keys');
    check(plan.steps[1].sql.includes('WHERE ("a"."tenant_id", "a"."account_id") IN (($1))'), `composite relation SQL: ${plan.steps[1].sql}`);
    const child = plan.steps[0].assemble.children[0];
    check(child.parent_keys.map(k => k.column).join(',') === 'tenant_id,account_id' && child.child_keys.map(k => k.column).join(',') === 'tenant_id,account_id', 'composite relation keys in key order');
  }
  for (const [keys, want] of [
    [[], 'IR_INVALID'],
    [[{ left: 'tenant_id', right: 'tenant_id' }, { left: 'tenant_id', right: 'account_id' }], 'IR_INVALID'],
    [[{ left: 'tenant_id', right: 'tenant_id' }, { left: 'account_id', right: 'tenant_id' }], 'IR_INVALID'],
    [[{ left: 'tenant_id', right: '' }], 'IR_INVALID'],
    [[{ left: 'tenant_id', right: 'tenant_id' }, { left: 'nope', right: 'account_id' }], 'COLUMN_UNKNOWN'],
  ]) check(compileCode(compositeRelation(keys)) === want, `relation keys ${JSON.stringify(keys)}: want ${want}`);
  check(compileCode({ ...base, kind: 'all', n_params: 0, force_index: 'nope' }) === 'INDEX_UNKNOWN', 'unknown index');

  // insert cannot write an identity column value, and update and duplicate update cannot write the primary key and identity
  // column values. PostgreSQL identity does not advance past an explicitly given key, so
  // (postgres.identity.by_default_not_advanced) all three dialects reject it.
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

  // A node that selects every column reads the AES key version column only once and marks its position.
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
    softDelete.steps[0].sql.startsWith('UPDATE "soft_record" SET "deleted_at" = $1') && softDelete.steps[0].sql.includes('"soft_record"."deleted_at" IS NULL'),
    `soft-delete guarded update: ${softDelete.steps[0].sql}`,
  );

  // Restore: one update that sets the soft delete column back to NULL, with an eq condition on one primary key or unique key.
  // It changes only deleted rows, and if the table is audited it also writes the audit column (the same case as engine/planner/restore_test.go).
  {
    const restoreText = `dbspec 1 restore

table link {
  id i64 identity
  team_id i64
  member_id i64
  audit_seq i64
  deleted_at datetime(6) null
  primary key (id)
  unique uq_link_pair (team_id, member_id)
  index ix_link_audit (audit_seq)
  foreign key fk_link_audit (audit_seq) references audit (seq) on delete restrict on update restrict
  settings {
    soft_delete deleted_at
    audit into link_history column audit_seq references audit action change previous previous_audit_seq
  }
}

table link_history {
  history_id i64 identity
  change varchar(8)
  previous_audit_seq i64 null
  id i64
  team_id i64
  member_id i64
  audit_seq i64
  deleted_at datetime(6) null
  primary key (history_id)
}

table tag {
  id i64 identity
  name varchar(64)
  label varchar(64)
  deleted_at datetime(6) null
  primary key (id)
  unique uq_tag_name (name)
  settings {
    soft_delete deleted_at
  }
}

table audit {
  seq i64 identity
  actor varchar(64)
  primary key (seq)
}

table plain {
  id i64 identity
  name varchar(64)
  primary key (id)
}
`;
    const { manifest: restoreManifest } = dbspecManifest([parseDbspec(restoreText, {}).document]);
    const restoreModel = registerModel(restoreManifest.manifestText, restoreManifest.manifestHash);
    const restoreRequest = (entity, ...preds) => {
      const r = { ir_version: 1, manifest_hash: restoreManifest.manifestHash, kind: 'restore', entity, n_params: 0, where: { items: [] } };
      for (const pred of preds) {
        const p = { ...pred };
        if (p.p === undefined && p.op !== 'is_null') p.p = r.n_params++;
        r.where.items.push({ pred: p });
      }
      return r;
    };
    const withSet = (r, ...assigns) => {
      r.set = r.set ?? [];
      for (const a of assigns) r.set.push({ ...a, p: r.n_params++ });
      return r;
    };
    const slotsOf = step => step.bind_slots.map(s => (s.from === 'param' ? `param ${s.param}` : s.from));
    for (const [name, dialect, request, sql, slots] of [
      ['unique key with audit', 'sqlite', restoreRequest('link', { column: 'team_id', op: 'eq' }, { conn: 'and', column: 'member_id', op: 'eq' }),
        'UPDATE "link" SET "deleted_at" = NULL, "audit_seq" = ? WHERE "link"."team_id" = ? AND "link"."member_id" = ? AND "link"."deleted_at" IS NOT NULL',
        ['audit', 'param 0', 'param 1']],
      ['unique key in another order', 'mysql', restoreRequest('link', { column: 'member_id', op: 'eq' }, { conn: 'and', column: 'team_id', op: 'eq' }),
        'UPDATE `link` SET `deleted_at` = NULL, `audit_seq` = ? WHERE `link`.`member_id` = ? AND `link`.`team_id` = ? AND `link`.`deleted_at` IS NOT NULL',
        ['audit', 'param 0', 'param 1']],
      ['primary key', 'postgres', restoreRequest('link', { column: 'id', op: 'eq' }),
        'UPDATE "link" SET "deleted_at" = NULL, "audit_seq" = $1 WHERE "link"."id" = $2 AND "link"."deleted_at" IS NOT NULL',
        ['audit', 'param 0']],
      ['without audit', 'mysql', restoreRequest('tag', { column: 'name', op: 'eq' }),
        'UPDATE `tag` SET `deleted_at` = NULL WHERE `tag`.`name` = ? AND `tag`.`deleted_at` IS NOT NULL',
        ['param 0']],
      ['key from set and where', 'sqlite', withSet(restoreRequest('link', { column: 'team_id', op: 'eq' }), { column: 'member_id' }),
        'UPDATE "link" SET "deleted_at" = NULL, "audit_seq" = ? WHERE "link"."team_id" = ? AND "link"."member_id" = ? AND "link"."deleted_at" IS NOT NULL',
        ['audit', 'param 0', 'param 1']],
      ['primary key of set before a unique key of where', 'postgres', withSet(restoreRequest('tag', { column: 'name', op: 'eq' }), { column: 'id' }, { column: 'label' }),
        'UPDATE "tag" SET "label" = $1, "deleted_at" = NULL WHERE "tag"."name" = $2 AND "tag"."id" = $3 AND "tag"."deleted_at" IS NOT NULL',
        ['param 2', 'param 0', 'param 1']],
      ['new value and null', 'postgres', withSet(restoreRequest('tag', { column: 'name', op: 'eq' }), { column: 'label' }),
        'UPDATE "tag" SET "label" = $1, "deleted_at" = NULL WHERE "tag"."name" = $2 AND "tag"."deleted_at" IS NOT NULL',
        ['param 1', 'param 0']],
      ['a key and another condition', 'mysql', restoreRequest('tag', { column: 'name', op: 'eq' }, { conn: 'and', column: 'label', op: 'gt' }),
        'UPDATE `tag` SET `deleted_at` = NULL WHERE `tag`.`name` = ? AND `tag`.`label` > ? AND `tag`.`deleted_at` IS NOT NULL',
        ['param 0', 'param 1']],
      ['a repeated column', 'mysql', restoreRequest('tag', { column: 'name', op: 'eq' }, { conn: 'and', column: 'name', op: 'eq' }),
        'UPDATE `tag` SET `deleted_at` = NULL WHERE `tag`.`name` = ? AND `tag`.`name` = ? AND `tag`.`deleted_at` IS NOT NULL',
        ['param 0', 'param 1']],
    ]) {
      let plan;
      try { plan = new Engine(restoreModel, dialect).compile(request); } catch (error) { check(false, `restore ${name}: ${error.code ?? ''} ${error.message}`); continue; }
      check(plan.steps.length === 1 && plan.steps[0].role === 'main' && plan.steps[0].sql === sql, `restore ${name}: ${JSON.stringify(plan.steps)}, want ${sql}`);
      check(JSON.stringify(slotsOf(plan.steps[0])) === JSON.stringify(slots), `restore ${name}: bind slots ${JSON.stringify(slotsOf(plan.steps[0]))}, want ${JSON.stringify(slots)}`);
    }
    const sqlite = new Engine(restoreModel, 'sqlite');
    const group = restoreRequest('tag');
    group.n_params = 1;
    group.where.items = [{ group: { items: [{ pred: { column: 'name', op: 'eq', p: 0 } }] } }];
    for (const [name, request] of [
      ['part of a unique key', restoreRequest('link', { column: 'team_id', op: 'eq' })],
      ['a column that is no key', restoreRequest('tag', { column: 'label', op: 'eq' })],
      ['part of a unique key in set', withSet(restoreRequest('link'), { column: 'member_id' })],
      ['an or connector with a key in set', withSet(restoreRequest('tag', { column: 'label', op: 'eq' }, { conn: 'or', column: 'label', op: 'eq' }), { column: 'name' })],
      ['another operator', restoreRequest('tag', { column: 'name', op: 'gt' })],
      ['an or connector', restoreRequest('link', { column: 'team_id', op: 'eq' }, { conn: 'or', column: 'member_id', op: 'eq' })],
      ['a null test', restoreRequest('tag', { column: 'name', op: 'is_null' })],
      ['no condition', restoreRequest('tag')],
      ['a group', group],
      ['an assignment of the soft delete column', withSet(restoreRequest('tag', { column: 'name', op: 'eq' }), { column: 'deleted_at' })],
      ['a null assignment of the primary key', { ...restoreRequest('tag', { column: 'name', op: 'eq' }), set: [{ column: 'id', null: true }] }],
      ['an assignment of the audit column', withSet(restoreRequest('link', { column: 'id', op: 'eq' }), { column: 'audit_seq' })],
      ['an optimistic check', { ...restoreRequest('tag', { column: 'name', op: 'eq' }), optimistic: { column: 'label', p: 0 } }],
      ['a table without soft_delete', restoreRequest('plain', { column: 'id', op: 'eq' })],
    ]) {
      const got = code(() => sqlite.compile(request));
      check(got === 'IR_INVALID', `restore with ${name}: ${got}, want IR_INVALID`);
    }
  }

  if (failures > 0) throw new Error(`${failures} check(s) failed; each FAIL line above names one`);
});
// Shared validation cases (tests/ir/validate.json): each request, with the schema's manifest_hash added, is given only to the validator, and
// it is checked whether it is accepted or fails with the expected error code.
const validateText = await readFile(new URL('../../../tests/ir/validate.json', import.meta.url), 'utf8');
const file = JSON.parse(validateText);
// Each request is read again as its JSON text through ordered-json, so a number keeps its literal (0.0 is not 0).
const requestTexts = parseJson(validateText).get('cases').items.map(c => stringifyJson(c.get('request')));
if (file.schema !== 'contracts/fixtures/bench/bench.dbs' || file.cases.length === 0) throw new Error('validate.json names contracts/fixtures/bench/bench.dbs and has cases');
const validated = dbspecManifest([parseDbspec(await readFile(new URL(`../../../${file.schema}`, import.meta.url), 'utf8'), {}).document]).manifest;
const validateModel = registerModel(validated.manifestText, validated.manifestHash);
for (const [index, c] of file.cases.entries()) caseTest(c.name, COMPUTE, () => {
  const got = code(() => validate(validateModel, { ...decodeRequest(requestTexts[index]), manifest_hash: validated.manifestHash }));
  if (c.valid ? got !== null : got !== c.error) throw new Error(`got ${got ?? 'valid'}, want ${c.error ?? 'valid'}`);
});
// loadSet returns the parsed documents of a generated schema value, as PHP's RuntimeModel::loadSet does (T163).
await run.run('load-set', COMPUTE, async () => {
  const owned = 'dbspec 1 shop\n\nuse core { account }\n\ntable item {\n  seq i64\n  account_seq i64\n  primary key (seq)\n  index ix_item_account (account_seq)\n  foreign key fk_item_account (account_seq) references account (seq) on delete restrict on update restrict\n}\n';
  const external = 'dbspec 1 core\n\ntable account {\n  seq i64\n  primary key (seq)\n}\n';
  const documents = loadSet(owned, external);
  if (documents.map(d => `${d.name}:${d.external === true}`).join(',') !== 'shop:false,core:true') throw new Error(`documents ${documents.map(d => d.name).join(',')}`);
  if (loadSet(external, '').map(d => d.name).join(',') !== 'core') throw new Error('an empty external text adds a document');
  if (code(() => loadSet('table item {}\n', '')) !== 'SCHEMA_INVALID') throw new Error('a text without a header is not SCHEMA_INVALID');
});

run.finish();
