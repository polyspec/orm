// schema_definition coverage: contracts/fixtures/schema_definition.json 의 문서로 parse 후 emit,
// manifest hash, dialect 별 rendered statement 를 확인한다. It also checks the tokens of syntax analysis, formatting
// and its refusal, and the declaration positions of a parse. 기대값은 fixture 에서만 읽는다.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dbspecManifest, emitDbspec, parseDbspec, renderDbspec } from '../dist/index.js';
// Syntax analysis and formatting are exported by the dbspec entry of the package (@polyspec/orm/dbspec).
import { analyzeDbspec, formatDbspec } from '../dist/dbspec/entry.js';
import { repositoryRoot, runCases } from './coverage_case.mjs';

const fixture = JSON.parse(await readFile(join(repositoryRoot, 'contracts/fixtures/schema_definition.json'), 'utf8'));

/** The fixture case of an ID with its operation; a missing or repeated case is an error. */
function fixtureCase(id, operation) {
  const found = fixture.cases.filter(c => c.id === id);
  assert.equal(found.length, 1, `schema_definition.json holds case ${id} once`);
  assert.equal(found[0].operation, operation, `operation of case ${id}`);
  return found[0];
}

/** Reads the documents of a case and returns each text with its parsed document. */
async function documents(paths) {
  assert.ok(Array.isArray(paths) && paths.length > 0, 'the case names documents');
  const out = [];
  for (const path of paths) {
    const text = await readFile(join(repositoryRoot, path), 'utf8');
    const parsed = parseDbspec(text, {});
    assert.deepEqual(parsed.diagnostics, [], `${path} parses`);
    out.push({ path, text, document: parsed.document });
  }
  return out;
}

await runCases('coverage_schema_definition.mjs', {
  async dbspec_emit_round_trip() {
    const c = fixtureCase('dbspec_emit_round_trip', 'parse_emit');
    assert.equal(c.expected.identical, true, 'the fixture expects identical text');
    for (const { path, text, document } of await documents(c.input.documents)) {
      assert.equal(emitDbspec(document), text, `${path} emits its canonical text`);
    }
  },

  async dbspec_manifest_hash() {
    const c = fixtureCase('dbspec_manifest_hash', 'manifest');
    const { manifest, diagnostics } = dbspecManifest((await documents(c.input.documents)).map(d => d.document));
    assert.deepEqual(diagnostics, [], 'the document set has a manifest');
    assert.equal(manifest.manifestHash, c.expected.manifest_hash, 'manifest hash');
  },

  async dbspec_render_ddl() {
    const c = fixtureCase('dbspec_render_ddl', 'render');
    const set = (await documents(c.input.documents)).map(d => d.document);
    assert.deepEqual(Object.keys(c.expected).sort(), ['mysql', 'postgres', 'sqlite'], 'the fixture names every dialect');
    for (const [dialect, statements] of Object.entries(c.expected)) {
      const rendered = renderDbspec(set, dialect);
      assert.deepEqual(rendered.diagnostics, [], `${dialect} renders`);
      assert.deepEqual(rendered.statements, statements, `${dialect} statements`);
    }
  },

  async dbspec_analyze_tokens() {
    const c = fixtureCase('dbspec_analyze_tokens', 'analyze');
    for (const { path, text, document } of await documents(c.input.documents)) {
      const analysis = analyzeDbspec(text, {});
      const parsed = parseDbspec(text, {});
      assert.deepEqual(analysis.diagnostics, [], `${path} analyzes without a diagnostic`);
      assert.equal(emitDbspec(analysis.document), emitDbspec(document), `${path}: the analysis holds the parsed document`);
      assert.deepEqual(analysis.positions, parsed.positions, `${path}: the analysis holds the positions of the parse`);
      assert.deepEqual(analysis.tokens.map(t => [t.line, t.start, t.end, t.class]), c.expected.tokens, `${path} tokens`);
    }
  },

  async dbspec_format() {
    const c = fixtureCase('dbspec_format', 'format');
    const formatted = formatDbspec(`${c.input.text.join('\n')}\n`, {});
    assert.deepEqual(formatted.diagnostics, [], 'the text formats');
    assert.equal(formatted.text, `${c.expected.text.join('\n')}\n`, 'formatted text');
    assert.equal(formatDbspec(formatted.text, {}).text, formatted.text, 'a formatted text is its own format');
  },

  async dbspec_format_refusal() {
    const c = fixtureCase('dbspec_format_refusal', 'format');
    const formatted = formatDbspec(`${c.input.text.join('\n')}\n`, {});
    assert.equal(formatted.text, null, 'a document with a diagnostic is not rewritten');
    assert.deepEqual(formatted.diagnostics.map(d => ({ rule: d.rule, line: d.line, column: d.column })), c.expected.diagnostics, 'diagnostics');
  },

  async dbspec_parse_positions() {
    const c = fixtureCase('dbspec_parse_positions', 'parse_positions');
    for (const { path, text } of await documents(c.input.documents)) {
      const parsed = parseDbspec(text, {});
      assert.deepEqual(parsed.positions.map(p => ({ kind: p.kind, path: [...p.path], line: p.line, column: p.column })), c.expected.positions, `${path} positions`);
    }
  },
}, 60_000);
