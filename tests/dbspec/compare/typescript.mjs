// Prints the TypeScript dbspec result of every shared case and of the stress
// document in the line format of tests/dbspec/compare/check.mjs.
//
// Usage: node tests/dbspec/compare/typescript.mjs <cases.json> <stress document> <ddl.json>
// (after the TypeScript build)
import { readFileSync } from 'node:fs';
import { dbspecManifest, emitDbspec, parseDbspec, renderDbspec } from '../../../clients/typescript/dist/dbspec/index.js';

const [casesPath, stressPath, ddlPath] = process.argv.slice(2);
if (casesPath === undefined || stressPath === undefined || ddlPath === undefined) {
  console.error('usage: node tests/dbspec/compare/typescript.mjs <cases.json> <stress document> <ddl.json>');
  process.exit(2);
}

// join writes the lines with LF, with CRLF when crlf is true, or with
// alternating CRLF and LF and no final line end when mixed is true.
function join(lines, crlf, mixed) {
  if (mixed) return lines.map((line, i) => (i === lines.length - 1 ? line : line + (i % 2 === 0 ? '\r\n' : '\n'))).join('');
  const end = crlf ? '\r\n' : '\n';
  return lines.join(end) + end;
}

const out = [];

// write prints the diagnostics of text, or its emission when it has none.
function write(text, set, stress) {
  const result = parseDbspec(text, set);
  if (result.diagnostics.length > 0) {
    for (const d of result.diagnostics) out.push(`! ${d.rule} ${d.line} ${d.column}`);
    return;
  }
  const emitted = emitDbspec(result.document);
  if (stress) out.push(emitted === text ? '= unchanged' : '= changed');
  else for (const line of emitted.split('\n')) out.push(`| ${line}`);
}

const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
for (const kind of ['canonical', 'normalize', 'invalid']) {
  for (const c of cases[kind]) {
    const crlf = c.crlf === true;
    const mixed = c.mixed === true;
    const set = {};
    for (const [name, lines] of Object.entries(c.documents)) if (name !== c.main) set[name] = join(lines, crlf, mixed);
    out.push(`${kind}/${c.id}`);
    write(join(c.documents[c.main], crlf, mixed), set, false);
  }
}
out.push('stress');
write(readFileSync(stressPath, 'utf8'), {}, true);

// writeManifest prints the hashes and texts of the case's document set, or the
// diagnostics of a document or of the set.
function writeManifest(c) {
  const documents = [];
  for (const name of Object.keys(c.documents).sort()) {
    const set = {};
    for (const [other, lines] of Object.entries(c.documents)) if (other !== name) set[other] = join(lines, false, false);
    const result = parseDbspec(join(c.documents[name], false, false), set);
    if (result.diagnostics.length > 0) {
      for (const d of result.diagnostics) out.push(`! ${d.rule} ${d.line} ${d.column}`);
      return;
    }
    documents.push(result.document);
  }
  const result = dbspecManifest(documents);
  if (result.diagnostics.length > 0) {
    for (const d of result.diagnostics) out.push(`! ${d.rule} ${d.line} ${d.column}`);
    return;
  }
  const m = result.manifest;
  out.push(`= manifestHash ${m.manifestHash}`, `= schemaHash ${m.schemaHash}`, '= manifestText');
  for (const line of m.manifestText.split('\n')) out.push(`| ${line}`);
  out.push('= schemaText');
  for (const line of m.schemaText.split('\n')) out.push(`| ${line}`);
}

for (const c of cases.hashes) {
  out.push(`hashes/${c.id}`);
  writeManifest(c);
}

// writeRender prints the statements of the case's document set in every
// dialect, or the diagnostics of a document or of the set.
function writeRender(c) {
  const documents = [];
  for (const name of Object.keys(c.documents).sort()) {
    const set = {};
    for (const [other, lines] of Object.entries(c.documents)) if (other !== name) set[other] = join(lines, false, false);
    const result = parseDbspec(join(c.documents[name], false, false), set);
    if (result.diagnostics.length > 0) {
      out.push(`render/${c.id}`);
      for (const d of result.diagnostics) out.push(`! ${d.rule} ${d.line} ${d.column}`);
      return;
    }
    documents.push(result.document);
  }
  for (const dialect of ['mysql', 'postgres', 'sqlite']) {
    out.push(`render/${c.id}/${dialect}`);
    const result = renderDbspec(documents, dialect);
    for (const d of result.diagnostics) out.push(`! ${d.rule} ${d.line} ${d.column}`);
    for (const s of result.statements ?? []) out.push(`| ${s}`);
  }
}

for (const c of JSON.parse(readFileSync(ddlPath, 'utf8')).cases) writeRender(c);
process.stdout.write(out.join('\n') + '\n');
