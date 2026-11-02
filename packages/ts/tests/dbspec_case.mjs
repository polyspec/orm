// dbspec_case.mjs holds the shared vectors of tests/dbspec/cases.json for the TypeScript client: the reader, the
// helpers and one function per section that registers each case of that section as a top-level test named by its id.
// The sections that remain in cases.json are hashes and sets; the document cases (canonical, normalize, invalid,
// positions, files and set-parse) run from their recipes in tests/dbspec/*.json (recipe_<section>.mjs).
// Each binding file of config/parity.json (dbspec-<section>.mjs) calls one of them, so a file runs one suite.
import { caseTest } from '../../../tests/testcase.mts';
import assert from 'node:assert/strict';
import { join } from '../../../tests/dbspec/join.mjs';
import { dbspecManifest, parseDbspec, parseDbspecSet, renderDbspec } from '../dist/dbspec/index.js';
import { readCases } from '../../../tests/dbspec/cases.mts';

export const root = new URL('../../../', import.meta.url);
// readCases refuses, through the schema of cases.json, a missing or unknown section or field of every section.
export const cases = readCases();
// TIMEOUT is the deadline (ms) of one case. One vector parses and emits one document in memory.
const TIMEOUT = 15000;

// vector runs one case with its own deadline and reports its start, result
// and elapsed time.
export function vector(name, body) {
  caseTest(name, TIMEOUT, body);
}

export { join };

export function parsed(text, set) {
  const result = parseDbspec(text, set);
  assert.deepEqual(result.diagnostics, [], 'diagnostics of a valid document');
  assert.notEqual(result.document, null);
  return result.document;
}

assert(cases.hashes.length > 0 && cases.sets.length > 0);
const ids = [...cases.hashes, ...cases.sets].map(c => c.id);
assert.equal(new Set(ids).size, ids.length, 'unique case ids');

// hashCases registers the cases of its section.
export function hashCases() {
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
    vector(c.id, () => {
      const documents = parseSet(c);
      expectManifest(c, documents);
      // The set is ordered by document name, not by the order given.
      expectManifest(c, [...documents].reverse());
    });
  }
}

// setCases registers the cases of its section.
export function setCases() {
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
    vector(c.id, () => {
      // Each document is parsed as a set with the other owned documents, the external documents, and the parsing documents. External documents are marked as external.
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
        // The runtime model is built from the manifest text and the external text, so they parse back as a set
        // without diagnostics (docs/spec/dbspec.md "Manifest and hashes").
        const split = text => (text === '' ? [] : text.split(/(?<=\n)(?=dbspec )/));
        for (const r of parseDbspecSet(split(manifest.manifest.manifestText), split(manifest.manifest.externalText))) {
          assert.deepEqual(r.diagnostics, [], `manifest and external text of ${r.name}`);
        }
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
}
