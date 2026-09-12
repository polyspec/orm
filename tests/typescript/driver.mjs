import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite } from '../../clients/typescript/dist/index.js';

const root = await mkdtemp(join(tmpdir(), 'orm-typescript-driver-'));
const db = openSqlite(join(root, 'test.sqlite'));
try {
  await db.execute('CREATE TABLE item (seq INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)', []);
  const inserted = await db.execute('INSERT INTO item(name) VALUES (?)', ['first']);
  if (inserted.affected !== 1 || Number(inserted.insertId) !== 1) throw new Error('SQLite insert result differs');
  const selected = await db.execute('SELECT seq, name FROM item WHERE seq = ?', [1]);
  if (selected.columns.join(',') !== 'seq,name' || JSON.stringify(selected.rows) !== '[[1,"first"]]') throw new Error('SQLite positional result differs');

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
} finally {
  await db.close();
  await rm(root, { recursive: true, force: true });
}
console.log('typescript driver: SQLite query, write, commit, rollback, and finished state passed');
