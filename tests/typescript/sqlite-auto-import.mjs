import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest } from '../../clients/typescript/dist/schema/build.js';
import { parseDiagram } from '../../clients/typescript/dist/schema/mermaid.js';
import { openToolDb } from '../../clients/typescript/dist/tools/db.js';
import { readTablesSQLite, renderMermaid } from '../../clients/typescript/dist/tools/introspect.js';

const dir = await mkdtemp(join(tmpdir(), 'orm-ts-auto-'));
try {
  const { db } = await openToolDb(`sqlite://${join(dir, 'entry.sqlite')}`);
  try {
    await db.exec(await readFile(new URL('../schema/sqlite_auto.sql', import.meta.url), 'utf8'));
    const tables = await readTablesSQLite(db);
    assert.equal(tables.length, 1);
    assert.equal(tables[0].columns[0].type, 'bigint');
    assert.equal(tables[0].columns[1].type, 'INTEGER');
    const manifest = buildManifest([parseDiagram(renderMermaid(tables))]);
    assert.equal(manifest.entities.entry.auto, 'id');
    assert.equal(manifest.entities.entry.columns[0].type, 'i64');
    assert.equal(manifest.entities.entry.columns[1].type, 'i32');
  } finally {
    await db.close();
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log('TypeScript SQLite automatic rowid import passed');
