// schema_definition coverage: contracts/fixtures/schema_definition.json 의 문서로 parse 후 emit,
// manifest hash, dialect 별 rendered statement 를 확인한다. 기대값은 fixture 에서만 읽는다.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dbspecManifest, emitDbspec, parseDbspec, renderDbspec } from '../dist/index.js';
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
}, 60_000);
