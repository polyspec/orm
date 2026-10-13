// The shared vectors of tests/dbspec through the language service: every canonical and normalize case formats to its
// canonical text, every invalid case reports its errors and is refused by format, formatting keeps the manifest and
// schema hashes and is idempotent, and the tokens of every syntax vector equal the tokens of openDocument after the
// UTF-16 conversion. A sets case whose documents repeat a name is not run: a set is a Record of names to texts, so it
// has no form for that case; the case is reported as skipped with its reason, not dropped.
//
// Usage: node --test packages/dbspec-language/tests/vectors.test.mjs (after the build)
import assert from 'node:assert/strict';
import { caseTest } from '../../../tests/testcase.mjs';
import * as language from '../dist/index.js';
import { parseDbspec } from '@polyspec/orm/dbspec';
import { dbspecManifest } from '@polyspec/orm';
import { codePointIndex, join, parserLines, utf16Index, vectorsFile } from './helpers.mjs';

// The deadline of one case; each case runs through caseTest so it reports its RUN, PASS or FAIL line.
const TIMEOUT = 15000;
const vector = (name, body) => caseTest(name, TIMEOUT, body);

const { openDocument } = language;
const cases = vectorsFile('cases.json');
const syntax = vectorsFile('syntax.json');

/** The text of a document of a case, joined with the case's line ends. */
function textOf(c, name) {
  return join(c.documents[name], c.crlf === true, c.mixed === true);
}

/** The set of a case for one of its documents: the other documents by name. */
function setOf(c, name) {
  const set = {};
  for (const [other, lines] of Object.entries(c.documents)) {
    if (other !== name) set[other] = textOf(c, other);
  }
  return set;
}

/** The name a header line declares. */
const headerName = lines => lines[0].split(' ')[2];

/** The 1-based line and code point column of a range start, with the rule: the form of the case errors. */
function errorOf(text, d) {
  const line = parserLines(text)[d.range.start.line];
  return { line: d.range.start.line + 1, column: codePointIndex(line, d.range.start.character) + 1, rule: d.rule };
}

for (const c of cases.canonical) {
  vector(`canonical ${c.id} formats to itself`, () => {
    const text = textOf(c, c.main);
    const doc = openDocument(text, { set: setOf(c, c.main) });
    assert.deepEqual(doc.diagnostics, []);
    assert.deepEqual(doc.format(), { text: join(c.documents[c.main], false), diagnostics: [] });
  });
}

for (const c of cases.normalize) {
  vector(`normalize ${c.id} formats to its canonical text`, () => {
    const text = textOf(c, c.main);
    const doc = openDocument(text, { set: setOf(c, c.main) });
    assert.deepEqual(doc.diagnostics, []);
    assert.deepEqual(doc.format(), { text: join(c.canonical, false), diagnostics: [] });
  });
}

for (const c of cases.invalid) {
  vector(`invalid ${c.id} is refused with its errors`, () => {
    const text = textOf(c, c.main);
    const doc = openDocument(text, { set: setOf(c, c.main) });
    assert.deepEqual(doc.diagnostics.map(d => errorOf(text, d)), c.errors);
    const formatted = doc.format();
    assert.equal(formatted.text, null);
    assert.deepEqual(formatted.diagnostics, doc.diagnostics);
  });
}

// hashesOf returns the manifest and schema hashes of a document set given as document name to text. Each document is
// parsed with the others as its set; a document or the set that fails is an error, not a skipped hash.
function hashesOf(texts) {
  const documents = Object.keys(texts).sort().map(name => {
    const set = {};
    for (const [other, text] of Object.entries(texts)) if (other !== name) set[other] = text;
    const result = parseDbspec(texts[name], set);
    assert.deepEqual(result.diagnostics, [], `document ${name} parses`);
    return result.document;
  });
  const manifest = dbspecManifest(documents);
  assert.deepEqual(manifest.diagnostics, []);
  return { manifestHash: manifest.manifest.manifestHash, schemaHash: manifest.manifest.schemaHash };
}

for (const c of [...cases.canonical, ...cases.normalize, ...cases.hashes]) {
  vector(`formatting keeps the hashes and is idempotent: ${c.id}`, () => {
    const texts = Object.fromEntries(Object.keys(c.documents).map(name => [name, textOf(c, name)]));
    const before = hashesOf(texts);
    for (const name of Object.keys(c.documents)) {
      const formatted = openDocument(texts[name], { set: setOf(c, name) }).format();
      assert.notEqual(formatted.text, null, `${name} formats`);
      assert.equal(openDocument(formatted.text, { set: setOf(c, name) }).format().text, formatted.text, `${name} is idempotent`);
      assert.deepEqual(hashesOf({ ...texts, [name]: formatted.text }), before, `hashes of ${name} after format`);
    }
  });
}

/**
 * The text and the set of the document a syntax vector id names: `<group>/<case>` for a canonical, normalize or
 * invalid case (its main document), `hashes/<case>/<document>`, and `sets/<case>/<place>` for the document at that
 * 1-based place of a sets case, whose set holds the other documents and the case's external documents.
 */
function syntaxCase(id) {
  const parts = id.split('/');
  const group = parts[0];
  if (group === 'hashes') {
    const c = cases.hashes.find(x => x.id === parts[1]);
    assert.ok(c, `hashes case ${parts[1]}`);
    return { text: join(c.documents[parts[2]], false), set: setOf(c, parts[2]) };
  }
  if (group === 'sets') {
    const c = cases.sets.find(x => x.id === parts[1]);
    assert.ok(c, `sets case ${parts[1]}`);
    const index = Number(parts[2]) - 1;
    const set = {};
    for (const [i, lines] of c.documents.entries()) {
      if (i !== index) set[headerName(lines)] = join(lines, false);
    }
    for (const external of c.external ?? []) set[headerName(external)] = join(external, false);
    return { text: join(c.documents[index], false), set };
  }
  const caseId = parts.slice(1).join('/');
  const c = cases[group].find(x => x.id === caseId);
  assert.ok(c, `${group} case ${caseId}`);
  return { text: textOf(c, c.main), set: setOf(c, c.main) };
}

for (const s of syntax.cases) {
  const parts = s.id.split('/');
  const sets = parts[0] === 'sets';
  // A sets case's id ends with its document's place. A sets case whose documents repeat a name has no Record form and
  // is not run here; the exclusion is checked by the case below, so it is reported and not dropped.
  if (sets) {
    const caseId = parts.slice(1, -1).join('/');
    const c = cases.sets.find(x => x.id === caseId);
    const names = c.documents.map(headerName);
    if (new Set(names).size !== names.length) continue;
  }
  vector(`syntax ${s.id} gives the vector's tokens in UTF-16`, () => {
    const { text, set } = syntaxCase(s.id);
    const lines = parserLines(text);
    const expected = s.tokens.map(([line, start, end, cls]) => ({
      class: cls,
      range: {
        start: { line: line - 1, character: utf16Index(lines[line - 1], start) },
        end: { line: line - 1, character: utf16Index(lines[line - 1], end) },
      },
    }));
    assert.deepEqual(openDocument(text, { set }).tokens, expected);
  });
}

// The sets cases with a repeated document name are the only ones not run as tokens: exactly these two places.
vector('the sets whose documents repeat a name are the only syntax sets without a Record form', () => {
  const repeated = syntax.cases
    .filter(s => s.id.startsWith('sets/'))
    .filter(s => {
      const c = cases.sets.find(x => x.id === s.id.split('/')[1]);
      const names = c.documents.map(headerName);
      return new Set(names).size !== names.length;
    })
    .map(s => s.id);
  assert.deepEqual(repeated, ['sets/repeated-document-name/1', 'sets/repeated-document-name/2']);
});
