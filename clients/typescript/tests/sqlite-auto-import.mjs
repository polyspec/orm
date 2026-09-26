import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
console.log('TypeScript SQLite automatic rowid import passed');
