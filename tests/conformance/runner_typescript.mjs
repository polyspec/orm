import { readFile } from 'node:fs/promises';
import {
  Battle, BattleColumns, Collection, ConnectCompiler, Db, OrmError, QueryCore,
  Service, ServiceMember, ServiceModule, ServiceRow, User,
} from '../../clients/typescript/dist/index.js';

const args = process.argv.slice(2);
let driver = 'mysql';
let dsn = '';
let compiler = '';
let schemaPath = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--driver') driver = args[++i];
  else if (args[i] === '--dsn') dsn = args[++i];
  else if (args[i] === '--compiler') compiler = args[++i];
  else schemaPath = args[i];
}
if (!compiler || !schemaPath) throw new Error('usage: runner_typescript.mjs --compiler URL [--driver DRIVER] [--dsn DSN] schema.json');
const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
const output = {};
let statements = [];
let maskedSeqs = new Set();
let maskedTimestamp;

function date(value) {
  if (value instanceof Date) value = value.toISOString();
  return String(value).replace('T', ' ').replace('Z', '').replace(/\.([0-9]{3})$/, '.$1000').replace(/\.000000$/, '');
}
function norm(value) {
  if (typeof value === 'bigint') value = Number(value);
  if (value instanceof Date) value = date(value);
  if (value instanceof Uint8Array) return value[0] === 0x78 ? '$ZLIB' : Buffer.from(value).toString();
  if (typeof value === 'number' && maskedSeqs.has(value)) return '$SEQ';
  if (typeof value === 'string' && maskedTimestamp !== undefined && date(value) === date(maskedTimestamp)) return '$TS';
  if (Array.isArray(value)) return value.map(norm);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, norm(item)]));
  return value;
}
function maskRows(timestamp, ...seqs) {
  maskedTimestamp = timestamp;
  for (const seq of seqs) maskedSeqs.add(Number(seq));
  statements = norm(statements);
}
function code(error) { return typeof error?.code === 'string' ? error.code : error?.message ?? String(error); }
function queryView(query) {
  const { ir_version, schema_hash, kind, n_params, ...view } = query.request.ir;
  return view;
}
async function run(name, callback) {
  statements = [];
  maskedSeqs = new Set();
  maskedTimestamp = undefined;
  let result;
  try { result = await callback(); }
  catch (error) { result = { error: code(error) }; }
  output[name] = { statements: norm(statements), result: norm(result) };
}

const options = {
  schemaHash: schema.schema_hash,
  compiler: new ConnectCompiler(compiler),
  aesKey: 'bench-salt',
  onQuery: event => statements.push({ sql: event.sql, binds: norm([...event.binds]) }),
};
if (!dsn) {
  if (driver === 'mysql') dsn = process.env.ORM_MYSQL_DSN_TYPESCRIPT ?? 'mysql://root@localhost/orm_bench?socketPath=/tmp/mysql.sock';
  else if (driver === 'postgres') dsn = 'postgres://maxkwon@localhost:5432/orm_bench';
  else dsn = '/tmp/orm_bench.sqlite';
}
if (driver === 'sqlite') dsn = dsn.replace(/^sqlite:\/\//, '').split('?')[0];
const db = driver === 'mysql' ? await Db.mysql(dsn, options) : driver === 'postgres' ? await Db.postgres(dsn, options) : await Db.sqlite(dsn, options);

const rollback = Symbol('rollback');
const dt = value => new Date(value.endsWith('Z') ? value : `${value}Z`);
const battle = row => row === null ? null : {
  seq: row.getSeq(), name: row.getName(), aes_hex_email: row.getAesHexEmail(), is_close: row.getIsClose(),
  is_display: row.getIsDisplay(), description: row.getDescription(), start_dt: date(row.getStartDt()), like_count: row.getLikeCount(),
};
const keyed = rows => rows.entries().map(([key, row]) => [key, { seq: row.getSeq(), name: row.getName(), like_count: row.getLikeCount() }]);
const keys = rows => rows.keys();

try {
  await run('interface_query_reuse', async () => {
    const q = Battle().using(db).serviceSeq(7).limit(0, 2);
    return [await q.getCount(), (await q.gets()).length, await q.getCount()];
  });
  await run('interface_attach', async () => {
    const child = User().seqIn([1, 2]).and(w => w.name('user-1').or().name('user-2'));
    const a = Battle().serviceSeq(7).join(child);
    const b = Battle().serviceSeq(8).join(child);
    child.name('later');
    return { a: queryView(a), b: queryView(b), child: queryView(child), a_params: a.request.params, b_params: b.request.params, child_params: child.request.params };
  });
  await run('interface_typed_keys', async () => {
    const rows = new Collection();
    for (const [key, name] of [[1, 'first'], ['1', 'string'], [2, 'second'], [1, 'last']]) rows.put(key, new ServiceRow().setName(name));
    return rows.entries().map(([key, row]) => [key, row.getName()]);
  });
  await run('interface_invalid_page', () => Battle().using(db).paginate(1, 0));
  await run('interface_error', async () => {
    const child = User(); child.request.deferredError = new OrmError('CODEC_UNSUPPORTED', 'x');
    const q = Battle().using(db).join(child); const errors = [];
    try { await q.sql(); } catch (error) { errors.push(code(error)); }
    try { await q.sql(); } catch (error) { errors.push(code(error)); }
    return errors;
  });
  await run('interface_row_state', async () => {
    let result;
    try { await db.transaction(async tx => {
      const row = await Battle().using(tx).selectNone().selectSeq().getBySeq(6);
      const before = row.has('name'); row.setName('interface-first').setLikeCount(5).setName('interface-final');
      await row.update(); const count = statements.length; await row.update();
      result = { before, assigned: row.has('name'), value: row.getName(), export: row.toObject(), noop_statements: statements.length - count, relation_loaded: row.relLoaded('user') };
      throw rollback;
    }); } catch (error) { if (error !== rollback) throw error; }
    return result;
  });
  await run('interface_dirty_retry', async () => {
    let result;
    try { await db.transaction(async tx => {
      const row = await Battle().using(tx).getBySeq(6); maskRows(row.getUpdatedTs());
      await Battle().using(tx).seq(6).setUpdatedTs(dt('2001-01-01 00:00:00')).update();
      row.setName('interface-pending'); const errors = [];
      try { await row.updateOptimistic(); errors.push(null); } catch (error) { errors.push(code(error)); }
      try { await row.updateOptimistic(); errors.push(null); } catch (error) { errors.push(code(error)); }
      result = { errors, value: row.getName() }; throw rollback;
    }); } catch (error) { if (error !== rollback) throw error; }
    return result;
  });
  await run('interface_original_version', async () => {
    let result; try { await db.transaction(async tx => {
      const row = await Battle().using(tx).getBySeq(6); maskRows(row.getUpdatedTs()); const version = dt('2002-01-01 00:00:00');
      row.setUpdatedTs(version).setName('interface-version'); await row.updateOptimistic();
      const sparse = await Battle().using(tx).selectNone().selectSeq().getBySeq(6); sparse.setName('not-written'); let missing;
      try { await sparse.updateOptimistic(); } catch (error) { missing = code(error); }
      const stored = await Battle().using(tx).getBySeq(6); result = { name: stored.getName(), version_retained: date(row.getUpdatedTs()) === date(version) && date(stored.getUpdatedTs()) === date(version), missing_version: missing, pending: sparse.getName() }; throw rollback;
    }); } catch (error) { if (error !== rollback) throw error; } return result;
  });
  await run('interface_identity', async () => {
    let result; try { await db.transaction(async tx => {
      const row = await Battle().using(tx).getBySeq(6); row.values[0] = 5; row.setName('identity-original'); await row.update();
      const stored = await Battle().using(tx).getBySeq(6); await row.delete(); result = { updated: stored.getName(), original_left: await Battle().using(tx).getCountBySeq(6), other_left: await Battle().using(tx).getCountBySeq(5) }; throw rollback;
    }); } catch (error) { if (error !== rollback) throw error; } return result;
  });
  await run('interface_nested_keys', async () => {
    const row = await Service().using(db).relations(ServiceMember().orderBySeqAsc().limitPerParent(1)).getBySeq(7);
    const members = row.getMembers(), first = members.first(); members.put(1, first); members.put('1', first); return row.toObject();
  });
  await run('interface_stream', async () => {
    let seen = 0;
    let first, firstSeq;
    const stopped = await Battle().serviceSeq(7).orderBySeqAsc().using(db).stream(row => {
      if (first === undefined) { first = row; firstSeq = row.getSeq(); }
      return ++seen < 3;
    });
    if (first?.getSeq() !== firstSeq) throw new Error('stream row ownership check failed');
    const exhausted = await Battle().serviceSeq(7).orderBySeqAsc().limit(0, 4).using(db).stream(() => true);
    let relationError;
    try { await Battle().serviceSeq(7).relation(User()).using(db).stream(() => true); }
    catch (error) { relationError = code(error); }
    return { stopped, exhausted, relation_error: relationError };
  });
  await run('unbound_terminal', () => Battle().getCountByServiceSeq(7));
  await run('bound_count_finder', () => Battle().using(db).join(Service().where(w => w.name('service-7'))).relation(User()).getCountByServiceSeq(7));
  await run('finished_transaction', async () => {
    const q = await db.transaction(async tx => Battle().using(tx));
    return q.getCountByServiceSeq(7);
  });
  await run('bound_transaction_rollback', async () => {
    let service, member, changed, joinedName;
    try { await db.transaction(async tx => {
      service = await Service().using(tx).setName('conf-bind').insert(); await service.setName('conf-bound').update();
      member = await ServiceMember().using(tx).setServiceSeq(service.getSeq()).setUserSeq(1).insert();
      const parent = await Service().using(db).using(tx).relations(ServiceMember().using(db).join(User())).getBySeq(service.getSeq());
      const child = parent.getMembers().first(); await child.setUserSeq(2).update(); await child.getUser().setName('conf-user').update();
      changed = await ServiceMember().using(tx).userSeq(2).getCountByServiceSeq(service.getSeq());
      joinedName = (await User().using(tx).getBySeq(1)).getName(); throw rollback;
    }); } catch (error) { if (error !== rollback) throw error; }
    maskRows(undefined, service.getSeq(), member.getSeq()); let expired;
    try { await member.delete(); } catch (error) { expired = code(error); }
    return { changed, joined_name: joinedName, expired_row: expired,
      members_left: await ServiceMember().using(db).getCountByServiceSeq(service.getSeq()),
      service_left: await Service().using(db).getCountBySeq(service.getSeq()), user_name: (await User().using(db).getBySeq(1)).getName() };
  });
  await run('pk_one', async () => battle(await Battle().seq(42).using(db).get()));
  await run('pk_one_by', async () => battle(await Battle().using(db).getBySeq(42)));
  await run('pk_missing', async () => battle(await Battle().seq(0).using(db).get()));
  await run('select_lazy', async () => { const row = await Battle().selectDescription().seq(42).using(db).get(); return { seq: row.getSeq(), description_prefix: row.getDescription().slice(0, 7) }; });
  await run('list_order_limit', async () => keyed(await Battle().serviceSeq(7).isClose(false).orderBySeqDesc().limit(0, 5).using(db).gets()));
  await run('in_keyed', async () => keys(await Battle().seqIn([306, 6, 106]).orderBySeqAsc().using(db).gets()));
  await run('group_or', async () => keyed(await Battle().serviceSeq(7).isClose(false)
    .and(w => w.isDisplay(true).or().and(x => x.isDisplay(false).displayStartDtLt(dt('2026-09-11 00:00:00'))))
    .seqIn([6, 106, 206, 306, 406]).orderBySeqDesc().limit(0, 3).using(db).gets()));
  await run('aggregates', async () => ({ count: await Battle().serviceSeq(7).using(db).getCount(), sum_like_count: await Battle().serviceSeq(7).using(db).sumLikeCount(), avg_like_count: await Battle().serviceSeq(7).using(db).avgLikeCount() }));
  await run('join_nav_count', () => Battle().join(Service().where(w => w.name('service-7'))).leftJoin(User().on(w => w.nameContains('user')))
    .isClose(false).and(w => w.isDisplay(true).or().service(s => s.seqGt(1000))).using(db).getCount());
  await run('join_row', async () => { const row = await Battle().join(Service().where(w => w.seq(7))).seq(6).using(db).get(); return { seq: row.getSeq(), service: { seq: row.getService().getSeq(), name: row.getService().getName() } }; });
  await run('root_finder_join_relation', async () => (await Battle().selectNone().join(Service().where(w => w.name('service-7'))).relation(User()).orderBySeqAsc().limit(0, 2).using(db).getsByServiceSeq(7)).values().map(row => ({ seq: row.getSeq(), service: { seq: row.getService().getSeq(), name: row.getService().getName() }, user: { seq: row.getUser().getSeq(), name: row.getUser().getName() } })));
  await run('paginate', async () => { const page = await Battle().serviceSeq(7).orderBySeqAsc().using(db).paginate(2, 10); return { total: page.total, pages: page.pages, current: page.current, per: page.per, keys: keys(page.items) }; });
  await run('contains_escape', () => Battle().nameContains('%').using(db).getCount());
  await run('empty_in_error', () => Battle().seqIn([]).using(db).getCount());
  await run('op_not_allowed_error', async () => { const q = new QueryCore('battle').predicate('seq', 'like', 'x'); q.request.ir.schema_hash = db.schemaHash; return db.execute(await db.plan(q.request.shape('count')), q.request.params); });
  await run('write_cycle', async () => {
    const created = await db.transaction(tx => Battle().setName('conf-write').setUserSeq(1).setServiceSeq(999).setServiceModuleSeq(1).setServiceMemberSeq(1).setStartDt(dt('2026-06-01 00:00:00')).setEndDt(dt('2026-12-31 00:00:00')).setAesHexEmail('w@example.com').using(tx).insert());
    maskRows(created.getUpdatedTs(), created.getSeq()); created.setName('conf-write-2').setLikeCount(5); await created.using(db).updateOptimistic();
    const again = await Battle().using(db).getBySeq(created.getSeq()); created.setName('stale'); let stale;
    try { await created.using(db).updateOptimistic(); } catch (error) { stale = code(error); }
    await again.delete(); return { inserted: created.getSeq() > 0, email: created.getAesHexEmail(), after_update: { name: again.getName(), like_count: again.getLikeCount() }, stale, left: await Battle().seq(created.getSeq()).using(db).getCount() };
  });
  await run('eq_col_where', async () => keys(await Battle().join(Service().where(w => w.seqEqCol(BattleColumns.serviceModuleSeq()))).seqIn([1, 2, 10]).orderBySeqAsc().using(db).gets()));
  await run('expr_where', () => Battle().serviceSeq(7).expr('LENGTH(`name`) > ?', [8]).using(db).getCount());
  await run('select_expr', async () => { const row = await Battle().selectExpr('tag', "CONCAT(`name`, '!')").seq(42).using(db).get(); return { seq: row.getSeq(), tag: row.column('tag') }; });
  await run('relation_four_levels', async () => (await Battle().selectNone().seq(7).relation(Service().relations(ServiceMember().orderBySeqAsc().limitPerParent(2).relation(User().relations(Battle().selectNone().orderBySeqAsc().limitPerParent(1))))).using(db).get()).toObject());
  await run('relation_one_ordered', async () => (await Battle().selectNone().seq(7).relation(Service().orderBySeqDesc()).using(db).get()).toObject());
  await run('relation_if_parent', async () => (await Battle().selectNone().seqIn([7, 8, 14]).orderBySeqAsc().relation(User().ifParentIsCloseEq(true)).using(db).gets()).values().map(row => row.toObject()));
  await run('relation_empty_parents', async () => keys(await Battle().seq(0).relation(User()).using(db).gets()));
  await run('relation_off_join', async () => (await Battle().selectNone().seq(8).join(Service().relations(ServiceModule())).using(db).get()).toObject());
  await run('paginate_relations', async () => { const page = await Battle().selectNone().serviceSeq(7).orderBySeqAsc().relation(User()).using(db).paginate(1, 3); return { total: page.total, items: page.items.values().map(row => row.toObject()) }; });
  await run('key_by_column', async () => (await Service().seq(7).relations(ServiceMember().orderBySeqAsc().limitPerParent(3).keyByUserSeq()).using(db).get()).toObject());
  await run('key_by_unselected', async () => (await Service().seq(7).relations(ServiceModule().selectNone().keyByName()).using(db).get()).toObject());
  await run('types_roundtrip', async () => {
    const value = '2026-06-01 12:34:56.123456';
    const created = await db.transaction(tx => Battle().setName('conf-types').setUserSeq(1).setServiceSeq(999).setServiceModuleSeq(1).setServiceMemberSeq(1).setStartDt(value).setEndDt(value).setDisplayStartDt(value).setIsDisplay(true).setTargetTeamPlayerCount(2147483647).setReadCount(4294967295).setPrice(12345.678).setJsonSetting({ k: [] }).setJsonsTags([]).setSerializeData('').using(tx).insert());
    maskRows(created.getUpdatedTs(), created.getSeq()); const row = await Battle().selectJsonSetting().selectJsonsTags().selectSerializeData().seq(created.getSeq()).using(db).get(); await row.delete();
    return { display_start_dt: date(row.getDisplayStartDt()), is_display: row.getIsDisplay(), is_close: row.getIsClose(), target_team_player_count: row.getTargetTeamPlayerCount(), read_count: row.getReadCount(), price: row.getPrice(), json_setting: row.getJsonSetting(), jsons_tags: row.getJsonsTags(), serialize_data: row.getSerializeData() };
  });
  await run('key_by_fn_to_array', async () => (await ServiceMember().serviceSeq(7).orderBySeqAsc().limit(0, 2).relation(User().flatten()).keyByFn(row => `u${row.getUserSeq()}`).using(db).gets()).entries().map(([key, row]) => [key, row.toObject()]));
  await run('drop_child_key_to_array', async () => (await User().seq(5).relations(Battle().selectNone().orderBySeqAsc().limitPerParent(2).dropChildKey()).using(db).get()).toObject());
  const fks = query => query.setUserSeq(1).setServiceSeq(999).setServiceModuleSeq(1).setServiceMemberSeq(1)
    .setStartDt(dt('2026-06-01 00:00:00')).setEndDt(dt('2026-12-31 00:00:00'));
  await run('upsert', () => db.transaction(async tx => {
    const a = await fks(Battle().setUuid('conf-upsert').setName('u1').setReadCount(1)).using(tx).insert(); maskRows(a.getUpdatedTs(), a.getSeq());
    const b = await fks(Battle().setUuid('conf-upsert').setName('u2').setReadCount(1)).onDuplicateSetName('u2').onDuplicatePlusReadCount(5).using(tx).insert(); await b.delete();
    return { same_seq: a.getSeq() === b.getSeq(), name: b.getName(), read_count: b.getReadCount() };
  }));
  await run('upsert_set_all', () => db.transaction(async tx => {
    const a = await fks(Battle().setUuid('conf-upsert').setName('u1').setReadCount(1)).using(tx).insert(); maskRows(a.getUpdatedTs(), a.getSeq());
    const b = await fks(Battle().setUuid('conf-upsert').setName('u3').setReadCount(9)).onDuplicateSetAll().using(tx).insert(); await b.delete();
    return { same_seq: a.getSeq() === b.getSeq(), name: b.getName(), read_count: b.getReadCount() };
  }));
  await run('save_branch', async () => {
    const row = await db.transaction(tx => fks(Battle().setName('conf-save')).using(tx).save()); maskRows(row.getUpdatedTs(), row.getSeq());
    const after = await Battle().setSeq(row.getSeq()).setName('conf-save-2').using(db).save(); await after.delete(); return { inserted: row.getSeq() > 0, after: after.getName() };
  });
  await run('bulk_update_plus_minus', async () => {
    const row = await db.transaction(tx => fks(Battle().setReadCount(3).setName('conf-bulk')).using(tx).insert()); maskRows(row.getUpdatedTs(), row.getSeq());
    const read = async () => (await Battle().using(db).getBySeq(row.getSeq())).getReadCount();
    await Battle().seq(row.getSeq()).plusReadCount(2).using(db).update(); const afterPlus = await read();
    await Battle().seq(row.getSeq()).minusReadCount(10).using(db).update(); const afterMinus = await read();
    await Battle().seq(row.getSeq()).setReadCountExpr('`read_count` * ? + 1', [2]).using(db).update(); const afterExpr = await read();
    return { after_plus: afterPlus, after_minus: afterMinus, after_expr: afterExpr, deleted: await Battle().seq(row.getSeq()).using(db).delete() };
  });
  await run('delete_cascade_order', async () => {
    const made = await db.transaction(async tx => { const service = await Service().setName('conf-svc').using(tx).insert(); const members = [await ServiceMember().setServiceSeq(service.getSeq()).setUserSeq(1).using(tx).insert(), await ServiceMember().setServiceSeq(service.getSeq()).setUserSeq(2).using(tx).insert()]; const module = await ServiceModule().setServiceSeq(service.getSeq()).setName('conf-mod').using(tx).insert(); return { service, members, module }; });
    maskRows(undefined, made.service.getSeq(), ...made.members.map(row => row.getSeq()), made.module.getSeq());
    const service = await Service().seq(made.service.getSeq()).relations(ServiceMember().orderBySeqAsc()).relations(ServiceModule().noCascadeDelete()).using(db).get(); await service.using(db).deleteCascade();
    const result = { members_left: await ServiceMember().serviceSeq(made.service.getSeq()).using(db).getCount(), modules_left: await ServiceModule().serviceSeq(made.service.getSeq()).using(db).getCount(), service_left: await Service().seq(made.service.getSeq()).using(db).getCount() };
    await ServiceModule().seq(made.module.getSeq()).using(db).delete(); return result;
  });
  await run('sql_dump', async () => { const statement = await Battle().serviceSeq(7).selectAesHexEmail().limit(0, 1).using(db).sql(); return norm(statement); });
  await run('agg_min_max', async () => ({ min: await Battle().serviceSeq(7).using(db).minSeq(), max: await Battle().serviceSeq(7).using(db).maxSeq(), distinct_users: await Battle().serviceSeq(7).using(db).countDistinctUserSeq() }));
  await run('group_count_having', () => Battle().serviceSeq(7).groupByUserSeq().having(w => w.expr('COUNT(*) > ?', [1])).using(db).getCount());
  await run('predicate_named', async () => ({ visible: await Battle().visible().serviceSeq(7).using(db).getCount(), started_after: await Battle().startedAfter('2026-01-01 00:00:00').serviceSeq(7).using(db).getCount() }));
  await run('raw_root', () => Battle().raw('SELECT COUNT(*) AS n, MAX(seq) AS m FROM {table} WHERE service_seq = ? AND is_close = ?', [7, false]).using(db).rawAll());
  await run('join_fulltext_or', () => Battle().join(Service().where(w => w.seq(7))).isClose(false).and(w => w.nameWithDescriptionMatchBoolean('battle').or().service(s => s.name('service-999'))).using(db).getCount());
  await run('join_two_groups', () => Battle().join(Service().on(w => w.name('service-7')).where(w => w.seqGt(0))).leftJoin(User().where(w => w.nameContains('user-4'))).seqIn([6, 106, 206, 406]).using(db).getCount());
  await run('join_multi_level', async () => (await Battle().selectNone().seq(6).join(ServiceMember().selectNone().join(User().selectNone()).join(Service().selectNone())).using(db).get()).toObject());
  await run('relation_predicates', async () => ({
    exists: await Service().seq(7).hasMembers(() => {}).using(db).getCount(),
    count: await Service().seq(7).countMembersEq(50, () => {}).using(db).getCount(),
  }));
  await run('batch_insert_delete', async () => {
    const names = ['conformance-batch-a', 'conformance-batch-b'];
    await Service().nameIn(names).using(db).delete();
    const result = await Service().using(db).batchInsert([
      Service().setName(names[0]), Service().setName(names[1]),
    ], { chunkSize: 1 });
    const deleted = await Service().nameIn(names).using(db).delete();
    return { attempted: result.attempted, affected: result.affected, inserted: result.inserted, deleted };
  });
  await run('codec_roundtrip', async () => {
    const value = { a: 1, b: [1, 2, { c: '한글/slash' }], d: null, e: true, f: 1.5 };
    const row = await db.transaction(tx => Battle().setName('conf-codec').setUserSeq(1).setServiceSeq(999).setServiceModuleSeq(1).setServiceMemberSeq(1).setStartDt(dt('2026-06-01 00:00:00')).setEndDt(dt('2026-12-31 00:00:00')).setJsonSetting(value).setJsonsTags(['x', 'y']).setBase64Extra(value).setSerializeData(value).setGzExtend(value).setIp('10.1.2.3').using(tx).insert());
    maskRows(row.getUpdatedTs(), row.getSeq()); const stored = await Battle().selectJsonSetting().selectJsonsTags().selectBase64Extra().selectSerializeData().selectGzExtend().seq(row.getSeq()).using(db).get(); await stored.delete();
    return { json_setting: stored.getJsonSetting(), jsons_tags: stored.getJsonsTags(), base64_extra: stored.getBase64Extra(), serialize_data: stored.getSerializeData(), gz_extend: stored.getGzExtend(), ip: stored.getIp() };
  });
} finally { await db.close(); }

console.log(JSON.stringify(output, null, 2));
