import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest } from '../dist/schema/build.js';
import { parseDiagram } from '../dist/schema/mermaid.js';
import { openToolDb } from '../dist/tools/db.js';
import { readTablesSQLite, renderMermaid } from '../dist/tools/introspect.js';

const dir = await mkdtemp(join(tmpdir(), 'orm-ts-auto-'));
try {
  const { db } = await openToolDb(`sqlite://${join(dir, 'entry.sqlite')}`);
  try {
    await db.exec(await readFile(new URL('../../../tests/schema/sqlite_auto.sql', import.meta.url), 'utf8'));
    await db.exec('CREATE TABLE decimal_case (seq INTEGER PRIMARY KEY, amount DECIMALINT(13,4) NOT NULL, whole DECIMALINT(16,0))');
    const tables = await readTablesSQLite(db);
    assert.equal(tables.length, 2);
    const entry = tables.find(table => table.name === 'entry');
    assert.ok(entry);
    assert.equal(entry.columns[0].type, 'bigint');
    assert.equal(entry.columns[1].type, 'INTEGER');
    const decimal = tables.find(table => table.name === 'decimal_case');
    assert.ok(decimal);
    assert.equal(decimal.columns[1].type, 'decimal(13_4)');
    assert.equal(decimal.columns[2].type, 'decimal(16_0)');
    const manifest = buildManifest([parseDiagram(renderMermaid(tables))]);
    assert.equal(manifest.entities.entry.auto, 'id');
    assert.equal(manifest.entities.entry.columns[0].type, 'i64');
    assert.equal(manifest.entities.entry.columns[1].type, 'i32');
    assert.equal(manifest.entities.decimal_case.columns[1].type, 'decimal');
  } finally {
    await db.close();
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
// query가 붙은 SQLite DSN은 path만으로 file을 만든다(docs/dialects.md "Probe environment").
const named = await mkdtemp(join(tmpdir(), 'orm-ts-tool-name-'));
try {
  const { db } = await openToolDb(`sqlite://${join(named, 'named.sqlite')}?_pragma=busy_timeout(5000)&timezone=%2B00:00`);
  try {
    await db.exec('CREATE TABLE t (a INTEGER)');
  } finally {
    await db.close();
  }
  const names = await readdir(named);
  assert.ok(names.includes('named.sqlite'), `files ${JSON.stringify(names)}: named.sqlite is missing`);
  for (const name of names) assert.ok(['named.sqlite', 'named.sqlite-journal', 'named.sqlite-shm', 'named.sqlite-wal'].includes(name), `files ${JSON.stringify(names)}: ${name} is not named by the path`);
} finally {
  await rm(named, { recursive: true, force: true });
}
console.log('TypeScript SQLite automatic rowid import passed');
