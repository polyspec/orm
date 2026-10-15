// mermaid_case.mjs holds the dbspec Mermaid vectors (tests/dbspec/mermaid.json, docs/mermaid.md) for the TypeScript
// client: the helpers and one function per section; each dbspec-mermaid-<section>.mjs calls one. After the cases of a
// section ran, the section checks that every one of its cases ran.
import { caseTest } from '../../../tests/testcase.mts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emitDbspec, exportMermaid, importMermaid, parseDbspec, readDbspecFile } from '../dist/dbspec/index.js';

export const root = new URL('../../../', import.meta.url);
export const vectors = JSON.parse(readFileSync(new URL('tests/dbspec/mermaid.json', root), 'utf8'));
// TIMEOUT은 case 하나의 기한(ms)이다. Mermaid vector 하나는 memory 안에서 문서 하나를 바꾼다.
const TIMEOUT = 5000;

// vector runs one case with its own deadline and reports its start, result
// and elapsed time.
export function vector(name, body) {
  caseTest(name, TIMEOUT, body);
}

const text = lines => lines.join('\n') + '\n';
const drops = dropped => dropped.map(u => [u.kind, u.table, u.name]);

assert.equal(vectors.version, 1, 'mermaid vectors version');
assert(
  vectors.export.length > 0 && vectors.import.length > 0 && vectors.invalid.length > 0 && vectors.round_trip.length > 0,
  'mermaid vectors have export, import, invalid and round trip cases',
);
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


// exportCases registers each case of vectors.export as a top-level test named by its id.
export function exportCases() {
  let runs = 0;
  for (const c of vectors.export) {
    vector(c.id, () => {
      const documents = Object.fromEntries(Object.entries(c.documents).map(([name, lines]) => [name, text(lines)]));
      const parsed = parseDbspec(text(c.document), documents);
      assert.deepEqual(parsed.diagnostics, [], 'document diagnostics');
      const { mermaid, dropped } = exportMermaid(parsed.document);
      assert.equal(mermaid, text(c.mermaid), 'mermaid text');
      assert.deepEqual(drops(dropped), c.dropped, 'dropped');
      runs++;
    });
  }
  after(() => {
    assert.equal(runs, vectors.export.length, 'every case of vectors.export ran');
    console.log(`mermaid cases: ${runs} of vectors.export`);
  });
}

// importCases registers each case of vectors.import as a top-level test named by its id.
export function importCases() {
  let runs = 0;
  for (const c of vectors.import) {
    vector(c.id, () => {
      const result = importMermaid(text(c.mermaid), 'imported');
      assert.deepEqual(result.diagnostics, [], 'diagnostics');
      assert.equal(emitDbspec(result.document), text(c.document), 'document');
      assert.deepEqual(drops(result.dropped), c.dropped, 'dropped');
      runs++;
    });
  }
  after(() => {
    assert.equal(runs, vectors.import.length, 'every case of vectors.import ran');
    console.log(`mermaid cases: ${runs} of vectors.import`);
  });
}

// invalidCases registers each case of vectors.invalid as a top-level test named by its id.
export function invalidCases() {
  let runs = 0;
  for (const c of vectors.invalid) {
    vector(c.id, () => {
      const result = importMermaid(text(c.mermaid), 'imported');
      assert.equal(result.document, null, 'document of an invalid diagram');
      assert.deepEqual(result.diagnostics.map(d => [d.rule, d.line, d.column]), c.errors, 'diagnostics');
      runs++;
    });
  }
  after(() => {
    assert.equal(runs, vectors.invalid.length, 'every case of vectors.invalid ran');
    console.log(`mermaid cases: ${runs} of vectors.invalid`);
  });
}

// roundTripCases registers each case of vectors.round_trip as a top-level test named by its id.
export function roundTripCases() {
  let runs = 0;
  for (const c of vectors.round_trip) {
    vector(c.id, () => {
      const read = readDbspecFile(fileURLToPath(new URL(c.path, root)));
      assert.deepEqual(read.diagnostics, [], 'file diagnostics');
      const parsed = parseDbspec(read.text, {});
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
  after(() => {
    assert.equal(runs, vectors.round_trip.length, 'every case of vectors.round_trip ran');
    console.log(`mermaid cases: ${runs} of vectors.round_trip`);
  });
}
