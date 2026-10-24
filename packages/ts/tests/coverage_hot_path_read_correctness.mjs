import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Author, connect, hostEncode } from '../dist/index.js';
import { typedNativeValues } from './coverage_performance_gate.mjs';
import { runCases } from './coverage_case.mjs';

async function hotPathReadCorrectness() {
  const emailCell = hostEncode('bench-email@example.com', ['aes', 'hex'], 'bench-salt');
  const phoneCell = hostEncode('+15550101010', ['aes', 'hex'], 'bench-salt');
  const typed = typedNativeValues({
    a__seq: 42,
    a__name: 'bench-author',
    a__created_ts: '2026-06-01 00:00:00',
    a__updated_ts: '2026-06-01 00:00:00',
    a__is_close: 0,
    a__is_display: 1,
    a__display_start_dt: null,
    a__display_end_dt: null,
    a__is_allday: 0,
    a__target_club_reader_count: 2,
    a__success_count: 1,
    a__reader_count: 3,
    a__read_count: 4,
    a__photo_url: null,
    a__user_seq: 10,
    a__service_seq: 7,
    a__service_region_seq: 2,
    a__service_member_seq: 11,
    a__start_dt: '2026-06-01 00:00:00',
    a__end_dt: '2026-12-31 00:00:00',
    a__uuid: null,
    a__is_single_work: 0,
    a__like_count: 5,
    a__aes_hex_email: emailCell,
    a__aes_hex_phone: phoneCell,
    a__price: '12.500',
    a__aes_key_version: 1,
  });
  assert.deepEqual(typed.slice(0, 2), [42, 'bench-author']);
  assert.equal(typed[23], 'bench-email@example.com', 'native AES2 email decode');
  assert.equal(typed[24], '+15550101010', 'native AES2 phone decode');
  assert.equal(typed[25], '12.500', 'native decimal stays exact');

  const directory = await mkdtemp(path.join(os.tmpdir(), 'orm-hot-path-'));
  const file = path.join(directory, 'read.sqlite');
  const dsn = `sqlite://${file}`;
  const native = new DatabaseSync(file);
  let db;
  try {
    native.exec('CREATE TABLE author (seq INTEGER PRIMARY KEY, name TEXT NOT NULL, service_seq INTEGER NOT NULL, is_close INTEGER NOT NULL)');
    const insert = native.prepare('INSERT INTO author (seq, name, service_seq, is_close) VALUES (?, ?, ?, ?)');
    for (let seq = 1; seq <= 100; seq++) insert.run(seq, `list-${String(seq).padStart(3, '0')}`, 7, 0);
    insert.run(101, 'closed', 7, 1);
    insert.run(102, 'other-service', 8, 0);
    db = await connect(dsn);

    const pk = new Author().connect(db).removeAllColumns().removeColumnUserSeq().removeColumnServiceSeq()
      .removeColumnServiceRegionSeq().removeColumnServiceMemberSeq().seq(42).addColumnSeq().addColumnName().limit(0, 1);
    const pkStatement = await pk.getQuery();
    assert.deepEqual(pkStatement.binds, [42, 1, 0]);
    assertProjection(pkStatement.sql);
    const pkExpected = [[42, 'list-042']];
    assert.deepEqual(nativeRows(native, pkStatement.sql, pkStatement.binds), pkExpected);
    assert.deepEqual(clientRows(await pk.gets()), pkExpected);

    const list = new Author().connect(db).removeAllColumns().removeColumnUserSeq().removeColumnServiceSeq()
      .removeColumnServiceRegionSeq().removeColumnServiceMemberSeq().serviceSeq(7).andIsClose(false)
      .orderBySeqDesc().limit(0, 100).addColumnSeq().addColumnName();
    const listStatement = await list.getQuery();
    assert.deepEqual(listStatement.binds, [7, false, 100, 0]);
    assertProjection(listStatement.sql);
    const listExpected = Array.from({ length: 100 }, (_, index) => {
      const seq = 100 - index;
      return [seq, `list-${String(seq).padStart(3, '0')}`];
    });
    assert.deepEqual(nativeRows(native, listStatement.sql, listStatement.binds), listExpected);
    assert.deepEqual(clientRows(await list.gets()), listExpected);
  } finally {
    if (db) await db.close();
    native.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function assertProjection(sql) {
  const projection = sql.split(' FROM ', 1)[0];
  assert.match(projection, /"a"\."seq" AS "a__seq"/);
  assert.match(projection, /"a"\."name" AS "a__name"/);
  assert.doesNotMatch(projection, /created_ts|service_seq/);
}

function nativeRows(db, sql, binds) {
  return db.prepare(sql).all(...binds).map((row) => [Number(row.a__seq), row.a__name]);
}

function clientRows(rows) {
  return [...rows].map((row) => [row.getSeq(), row.getName()]);
}

await runCases('coverage_hot_path_read_correctness.mjs', {
  // hot_path_read_correctness: Requirements: PRT-2, PRT-34.
  hot_path_read_correctness: hotPathReadCorrectness,
}, 60_000);
