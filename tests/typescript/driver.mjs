import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalPrepare = DatabaseSync.prototype.prepare;
let prepareCount = 0;
DatabaseSync.prototype.prepare = function (...args) {
  prepareCount++;
  return originalPrepare.apply(this, args);
};
const { openSqlite } = await import('../../clients/typescript/dist/index.js');

const root = await mkdtemp(join(tmpdir(), 'orm-typescript-driver-'));
const db = openSqlite(join(root, 'test.sqlite'), 2);
try {
  await db.execute('CREATE TABLE item (seq INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)', []);
  const inserted = await db.execute('INSERT INTO item(name) VALUES (?)', ['first']);
  if (inserted.affected !== 1 || Number(inserted.insertId) !== 1) throw new Error('SQLite insert result differs');
  const selected = await db.execute('SELECT seq, name FROM item WHERE seq = ?', [1]);
  if (selected.columns.join(',') !== 'seq,name' || JSON.stringify(selected.rows) !== '[[1,"first"]]') throw new Error('SQLite positional result differs');
  await db.execute('INSERT INTO item(name) VALUES (?), (?)', ['second', 'third']);
  const streamed = [];
  const stopped = await db.stream('SELECT seq, name FROM item ORDER BY seq', [], row => { streamed.push([...row]); return streamed.length < 2; });
  if (stopped.exhausted || stopped.count !== 2 || JSON.stringify(streamed) !== '[[1,"first"],[2,"second"]]') throw new Error('SQLite stream stop differs');
  const exhausted = await db.stream('SELECT seq, name FROM item ORDER BY seq', [], () => true);
  if (!exhausted.exhausted || exhausted.count !== 3) throw new Error('SQLite stream exhaustion differs');

  const beforeCache = prepareCount;
  await db.execute('SELECT 110', []);
  await db.execute('SELECT 110', []);
  await db.execute('SELECT 120', []);
  await db.execute('SELECT 130', []);
  await db.execute('SELECT 110', []);
  if (prepareCount - beforeCache !== 4) throw new Error(`SQLite statement cache prepare count was ${prepareCount - beforeCache}, want 4`);

  const rollback = await db.begin();
  await rollback.execute('UPDATE item SET name = ? WHERE seq = ?', ['rollback', 1]);
  await rollback.rollback();
  if ((await db.execute('SELECT name FROM item WHERE seq = ?', [1])).rows[0]?.[0] !== 'first') throw new Error('SQLite rollback failed');

  const commit = await db.begin();
  await commit.execute('UPDATE item SET name = ? WHERE seq = ?', ['commit', 1]);
  await commit.commit();
  if ((await db.execute('SELECT name FROM item WHERE seq = ?', [1])).rows[0]?.[0] !== 'commit') throw new Error('SQLite commit failed');
  let finished = false;
  try { await commit.execute('SELECT 1', []); } catch (error) { finished = error?.code === 'CONFIG'; }
  if (!finished) throw new Error('finished transaction accepted a statement');
  try { await db.begin({ readOnly: true }); throw new Error('SQLite read-only transaction option was accepted'); }
  catch (error) { if (error?.code !== 'CONFIG') throw error; }
} finally {
  await db.close();
  await rm(root, { recursive: true, force: true });
}
console.log('typescript driver: SQLite query, stream, write, commit, rollback, and finished state passed');
