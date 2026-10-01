// dbspec Mermaid diagrams (tests/dbspec/mermaid.json, docs/mermaid.md):
// every export case writes exactly its Mermaid lines and dropped objects;
// every import case reads its Mermaid lines into exactly its document and
// dropped objects; every invalid case reports exactly its diagnostics; every
// round trip case exports its document and imports the export with exactly
// its dropped objects and gets back its tables, columns, primary keys and
// foreign keys.
//
// Usage: node --test clients/typescript/tests/dbspec-mermaid.mjs (after the build)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { emitDbspec, exportMermaid, importMermaid, parseDbspec } from '../dist/dbspec/index.js';

const root = new URL('../../../', import.meta.url);
const vectors = JSON.parse(readFileSync(new URL('tests/dbspec/mermaid.json', root), 'utf8'));
const TIMEOUT = 5000;

// vector runs one case with its own deadline and reports its start, result
// and elapsed time.
function vector(name, body) {
  test(name, { timeout: TIMEOUT }, async () => {
    const started = performance.now();
    console.log(`start ${name}`);
    try {
      await body();
    } catch (error) {
      console.log(`result ${name}: FAIL after ${(performance.now() - started).toFixed(1)} ms`);
      throw error;
    }
    console.log(`result ${name}: PASS after ${(performance.now() - started).toFixed(1)} ms`);
  });
}

const text = lines => lines.join('\n') + '\n';
const drops = dropped => dropped.map(u => [u.kind, u.table, u.name]);

assert.equal(vectors.version, 1, 'mermaid vectors version');
assert(
  vectors.export.length > 0 && vectors.import.length > 0 && vectors.invalid.length > 0 && vectors.round_trip.length > 0,
  'mermaid vectors have export, import, invalid and round trip cases',
);
let runs = 0;

for (const c of vectors.export) {
  vector(`mermaid export ${c.id}`, () => {
    const documents = Object.fromEntries(Object.entries(c.documents).map(([name, lines]) => [name, text(lines)]));
    const parsed = parseDbspec(text(c.document), documents);
    assert.deepEqual(parsed.diagnostics, [], 'document diagnostics');
    const { mermaid, dropped } = exportMermaid(parsed.document);
    assert.equal(mermaid, text(c.mermaid), 'mermaid text');
    assert.deepEqual(drops(dropped), c.dropped, 'dropped');
    runs++;
  });
}

for (const c of vectors.import) {
  vector(`mermaid import ${c.id}`, () => {
    const result = importMermaid(text(c.mermaid), 'imported');
    assert.deepEqual(result.diagnostics, [], 'diagnostics');
    assert.equal(emitDbspec(result.document), text(c.document), 'document');
    assert.deepEqual(drops(result.dropped), c.dropped, 'dropped');
    runs++;
  });
}

for (const c of vectors.invalid) {
  vector(`mermaid invalid ${c.id}`, () => {
    const result = importMermaid(text(c.mermaid), 'imported');
    assert.equal(result.document, null, 'document of an invalid diagram');
    assert.deepEqual(result.diagnostics.map(d => [d.rule, d.line, d.column]), c.errors, 'diagnostics');
    runs++;
  });
}

// skeleton은 Mermaid가 옮기는 table, column, primary key, foreign key를 table 이름
// 순서의 줄로 쓴다. foreign key action은 Mermaid가 옮기지 않으므로 뺀다.
function skeleton(document) {
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const out = [];
  for (const t of [...document.tables].sort(byName)) {
    out.push(`table ${t.name}`);
    for (const c of t.columns) {
      const dflt = c.default === null ? '-' : c.default.kind === 'now' ? 'now' : c.default.text;
      out.push(`column ${c.name} ${JSON.stringify(c.type)} null=${c.nullable} identity=${c.identity} default=${dflt}`);
    }
    out.push(`primary key ${t.primaryKey.columns.join(', ')}`);
    for (const f of [...t.foreignKeys].sort(byName)) {
      out.push(`foreign key ${f.name} (${f.columns.join(', ')}) references ${f.table} (${f.references.join(', ')})`);
    }
  }
  return out;
}

for (const c of vectors.round_trip) {
  vector(`mermaid round_trip ${c.id}`, () => {
    const parsed = parseDbspec(readFileSync(new URL(c.path, root), 'utf8'), {});
    assert.deepEqual(parsed.diagnostics, [], 'document diagnostics');
    const exported = exportMermaid(parsed.document);
    assert.deepEqual(drops(exported.dropped), c.dropped, 'export dropped');
    const imported = importMermaid(exported.mermaid, parsed.document.name);
    assert.deepEqual(imported.diagnostics, [], 'import diagnostics');
    assert.deepEqual(drops(imported.dropped), c.imported, 'import dropped');
    assert.deepEqual(skeleton(imported.document), skeleton(parsed.document), 'tables, columns, primary keys and foreign keys');
    console.log(`round_trip ${c.id}: exported=${exported.dropped.length} imported=${imported.dropped.length}`);
    runs++;
  });
}

vector('every mermaid case runs', () => {
  const cases = vectors.export.length + vectors.import.length + vectors.invalid.length + vectors.round_trip.length;
  assert.equal(runs, cases);
  console.log(
    `mermaid cases: ${runs} (${vectors.export.length} export, ${vectors.import.length} import, ${vectors.invalid.length} invalid, ${vectors.round_trip.length} round trip)`,
  );
});
