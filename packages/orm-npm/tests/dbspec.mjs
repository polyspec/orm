// dbspec shared vectors (tests/dbspec/cases.json): canonical documents emit
// unchanged, normalize documents emit their canonical lines, and invalid
// documents report exactly the listed diagnostics in source order.
//
// Usage: node --test packages/orm-npm/tests/dbspec.mjs (after the build)
import { caseTest } from '../../../tests/testcase.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dbspecManifest, emitDbspec, parseDbspec, readDbspecBytes, readDbspecFile, renderDbspec } from '../dist/dbspec/index.js';

const root = new URL('../../../', import.meta.url);
const cases = JSON.parse(readFileSync(new URL('tests/dbspec/cases.json', root), 'utf8'));
// TIMEOUT은 case 하나의 기한(ms)이다. vector 하나는 memory 안에서 문서 하나를 parse하고 emit한다.
const TIMEOUT = 15000;

// vector runs one case with its own deadline and reports its start, result
// and elapsed time.
export function vector(name, body) {
  caseTest(name, TIMEOUT, body);
}

// join writes the lines with LF, with CRLF when crlf is true, or with
// alternating CRLF and LF and no final line end when mixed is true.
function join(lines, crlf, mixed = false) {
  if (mixed) return lines.map((line, i) => (i === lines.length - 1 ? line : line + (i % 2 === 0 ? '\r\n' : '\n'))).join('');
  const end = crlf ? '\r\n' : '\n';
  return lines.join(end) + end;
}

function documentSet(c) {
  const set = {};
  for (const [name, lines] of Object.entries(c.documents)) if (name !== c.main) set[name] = join(lines, c.crlf === true, c.mixed === true);
  return set;
}

function parsed(text, set) {
  const result = parseDbspec(text, set);
  assert.deepEqual(result.diagnostics, [], 'diagnostics of a valid document');
  assert.notEqual(result.document, null);
  return result.document;
}

assert(cases.canonical.length > 0 && cases.normalize.length > 0 && cases.invalid.length > 0);
const ids = [...cases.canonical, ...cases.normalize, ...cases.invalid, ...cases.sets, ...cases.files].map(c => c.id);
assert.equal(new Set(ids).size, ids.length, 'unique case ids');

for (const c of cases.canonical) {
  vector(`canonical ${c.id}`, () => {
    const text = join(c.documents[c.main], c.crlf === true, c.mixed === true);
    const set = documentSet(c);
    const emitted = emitDbspec(parsed(text, set));
    assert.equal(emitted, text);
    assert.equal(emitDbspec(parsed(emitted, set)), emitted);
  });
}

for (const c of cases.normalize) {
  vector(`normalize ${c.id}`, () => {
    const text = join(c.documents[c.main], c.crlf === true, c.mixed === true);
    const set = documentSet(c);
    const canonical = join(c.canonical, false);
    const emitted = emitDbspec(parsed(text, set));
    assert.equal(emitted, canonical);
    assert.equal(emitDbspec(parsed(emitted, set)), emitted);
  });
}

for (const c of cases.invalid) {
  vector(`invalid ${c.id}`, () => {
    const text = join(c.documents[c.main], c.crlf === true, c.mixed === true);
    const result = parseDbspec(text, documentSet(c));
    assert.equal(result.document, null);
    assert.deepEqual(result.diagnostics.map(d => ({ line: d.line, column: d.column, rule: d.rule })), c.errors);
    for (const d of result.diagnostics) {
      assert.deepEqual(Object.keys(d).sort(), ['column', 'line', 'message', 'rule']);
      assert.equal(typeof d.message, 'string');
      assert(d.message.length > 0);
    }
  });
}

// files cases are read twice: with readDbspecFile given the path and with readDbspecBytes
// given the file bytes and the case path as name. Bytes without the signature give one
// "<name> is not a dbspec document" diagnostic, bytes that are not UTF-8 one
// "<name> is not valid UTF-8" diagnostic, and no text; any other file gives its bytes,
// which parse and emit unchanged.
const fileMessages = { signature: ' is not a dbspec document', encoding: ' is not valid UTF-8' };
assert(cases.files.length > 0, 'files cases');
for (const c of cases.files) {
  const path = fileURLToPath(new URL(`tests/dbspec/${c.path}`, root));
  const readers = { file: [path, () => readDbspecFile(path)], bytes: [c.path, () => readDbspecBytes(c.path, readFileSync(path))] };
  for (const [kind, [name, read]] of Object.entries(readers)) {
    vector(`files ${c.id} ${kind}`, () => {
      const result = read();
      if (c.errors.length > 0) {
        assert.equal(result.text, null);
        assert.deepEqual(result.diagnostics.map(d => ({ line: d.line, column: d.column, rule: d.rule })), c.errors);
        for (const d of result.diagnostics) assert.equal(d.message, name + fileMessages[d.rule]);
        return;
      }
      assert.deepEqual(result.diagnostics, []);
      assert.equal(result.text, readFileSync(path, 'utf8'));
      assert.equal(emitDbspec(parsed(result.text, {})), result.text);
    });
  }
}

// parseSet parses every document of a hashes case against the others, in document name order.
function parseSet(c) {
  return Object.keys(c.documents).sort().map(name => {
    const set = {};
    for (const [other, lines] of Object.entries(c.documents)) if (other !== name) set[other] = join(lines, false);
    return parsed(join(c.documents[name], false), set);
  });
}

function expectManifest(c, documents) {
  const result = dbspecManifest(documents);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.manifest.manifestText, join(c.manifestText, false));
  assert.equal(result.manifest.schemaText, join(c.schemaText, false));
  assert.equal(result.manifest.manifestHash, c.manifestHash);
  assert.equal(result.manifest.schemaHash, c.schemaHash);
}

assert(cases.hashes.length > 0, 'hashes cases');
for (const c of cases.hashes) {
  vector(`hashes ${c.id}`, () => {
    const documents = parseSet(c);
    expectManifest(c, documents);
    // The set is ordered by document name, not by the order given.
    expectManifest(c, [...documents].reverse());
  });
}

vector('manifest rejects a repeated document name', () => {
  const text = join(['dbspec 1 shop', '', 'table users {', '  id i64 identity', '  primary key (id)', '}'], false);
  const result = dbspecManifest([parsed(text, {}), parsed(text, {})]);
  assert.equal(result.manifest, null);
  assert.deepEqual(result.diagnostics.map(d => [d.rule, d.line, d.column]), [['name.duplicate', 1, 10]]);
});

// headerName is the document name of a document's header line.
const headerName = lines => lines[0].split(' ')[2];

// expectErrors asserts that a set result carries exactly the expected errors.
function expectErrors(diagnostics, errors) {
  assert.deepEqual(diagnostics.map(d => ({ line: d.line, column: d.column, rule: d.rule })), errors);
  for (const d of diagnostics) {
    assert.deepEqual(Object.keys(d).sort(), ['column', 'line', 'message', 'rule']);
    assert(typeof d.message === 'string' && d.message.length > 0);
  }
}

assert(cases.sets.length > 0, 'sets cases');
// textOf joins lines with LF; no lines is the empty text.
const textOf = lines => (lines.length === 0 ? '' : join(lines, false));
// createdTables are the table names that the CREATE TABLE statements create, in statement order.
const createdTables = statements => statements
  .filter(s => s.startsWith('CREATE TABLE '))
  .map(s => s.slice('CREATE TABLE '.length).split(' ')[0].replace(/^[`"]|[`"]$/g, ''));
for (const c of cases.sets) {
  vector(`sets ${c.id}`, () => {
    // 각 문서는 다른 소유 문서, 외부 문서, parsing 문서를 집합으로 파싱한다. 외부 문서는 external로 표시한다.
    const owned = c.documents.length;
    const all = [...c.documents, ...(c.external ?? [])];
    const documents = all.map((lines, i) => {
      const set = {};
      for (const [name, other] of Object.entries(c.parsing)) set[name] = join(other, false);
      all.forEach((other, j) => {
        if (j !== i) set[headerName(other)] = join(other, false);
      });
      const parsed = parseDbspec(join(lines, false), set);
      const result = parsed.document !== null && i >= owned ? { ...parsed, document: Object.freeze({ ...parsed.document, external: true }) } : parsed;
      assert.deepEqual(result.diagnostics, [], 'diagnostics of a valid document');
      return result.document;
    });
    const manifest = dbspecManifest(documents);
    expectErrors(manifest.diagnostics, c.errors);
    assert.equal(manifest.manifest === null, c.errors.length > 0);
    if (c.manifest !== undefined) {
      for (const [field, want] of [
        ['manifestText', textOf(c.manifest.manifestText)],
        ['externalText', textOf(c.manifest.externalText)],
        ['schemaText', textOf(c.manifest.schemaText)],
        ['manifestHash', c.manifest.manifestHash],
        ['schemaHash', c.manifest.schemaHash],
      ]) assert.equal(manifest.manifest[field], want, field);
    }
    for (const dialect of ['mysql', 'postgres', 'sqlite']) {
      const rendered = renderDbspec(documents, dialect);
      assert(Object.isFrozen(rendered) && Object.isFrozen(rendered.diagnostics));
      expectErrors(rendered.diagnostics, c.errors);
      assert.equal(rendered.statements === null, c.errors.length > 0, `statements of ${dialect}`);
      if (c.manifest !== undefined) assert.deepEqual(createdTables(rendered.statements), c.manifest.created, `tables that ${dialect} creates`);
    }
  });
}
