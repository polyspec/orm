// 모든 공유 case, stress 문서, statement vector, plan vector, Mermaid vector의 TypeScript
// dbspec 결과를 tests/dbspec/compare/check.mjs의 줄 형식으로 출력한다. It then prints the positions cases of
// cases.json and the analysis and format of each case of syntax.json.
//
// Usage: node tests/dbspec/compare/typescript.mjs <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json> <syntax.json>
// (TypeScript build 뒤)
import { readFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { checkCases as checkSharedCases } from '../cases.mjs';
import { readInput } from '../input.mjs';
import {
  analyzeDbspec,
  chainPlans,
  compareSchemas,
  dbspecManifest,
  diffPlan,
  emitDbspec,
  emitPlan,
  exportMermaid,
  formatDbspec,
  importMermaid,
  parseDbspec,
  parsePlan,
  planSteps,
  effectText,
  readDbspecBytes,
  readDbspecFile,
  renderDbspec,
} from '../../../packages/orm-npm/dist/dbspec/index.js';

const [casesPath, stressPath, ddlPath, plansPath, mermaidPath, syntaxPath] = process.argv.slice(2);
if (casesPath === undefined || stressPath === undefined || ddlPath === undefined || plansPath === undefined || mermaidPath === undefined || syntaxPath === undefined) {
  console.error('usage: node tests/dbspec/compare/typescript.mjs <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json> <syntax.json>');
  process.exit(2);
}

// fail은 vector file의 위치와 문제를 stderr에 쓰고 1로 끝낸다.
function fail(path, location, problem) {
  console.error(`${path}: ${location} ${problem}`);
  process.exit(1);
}

// readVectors는 vector file을 JSON으로 읽고 check로 모양을 확인한다.
function readVectors(path, check) {
  const text = readInput(path);
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    console.error(`${path}: ${error.message}`);
    process.exit(1);
  }
  if (!isObject(value)) fail(path, '$', 'is not an object');
  check(path, value);
  return value;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// field는 object의 key가 있고 kind에 맞는지 확인해 그 값을 돌려준다.
function field(path, object, location, key, kind) {
  const at = location === '' ? key : `${location}.${key}`;
  if (!Object.hasOwn(object, key)) fail(path, at, 'is missing');
  const value = object[key];
  if (kind === 'string' && typeof value !== 'string') fail(path, at, 'is not a string');
  if (kind === 'boolean' && typeof value !== 'boolean') fail(path, at, 'is not a boolean');
  if (kind === 'object' && !isObject(value)) fail(path, at, 'is not an object');
  if (kind === 'array' && !Array.isArray(value)) fail(path, at, 'is not an array');
  return value;
}

// checkLines는 value가 string의 array인지 확인한다.
function checkLines(path, value, at) {
  if (!Array.isArray(value)) fail(path, at, 'is not an array');
  value.forEach((line, i) => {
    if (typeof line !== 'string') fail(path, `${at}[${i}]`, 'is not a string');
  });
}

function lines(path, object, location, key) {
  checkLines(path, field(path, object, location, key, 'array'), `${location}.${key}`);
}

// documents는 이름마다 line array를 가진 object인지 확인한다.
function documents(path, object, location, key) {
  const value = field(path, object, location, key, 'object');
  for (const [name, text] of Object.entries(value)) checkLines(path, text, `${location}.${key}.${name}`);
  return value;
}

// cases는 section의 각 case가 object인지 확인하고 check로 그 field를 확인한다.
function cases(path, object, key, check) {
  field(path, object, '', key, 'array').forEach((c, i) => {
    const at = `${key}[${i}]`;
    if (!isObject(c)) fail(path, at, 'is not an object');
    field(path, c, at, 'id', 'string');
    check(c, at);
  });
}

// checkCases reads cases.json strictly (tests/dbspec/cases.mjs) and checks that each document of a sets case names
// itself in its header.
function checkCases(path, v) {
  try {
    checkSharedCases(v, path);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  cases(path, v, 'sets', (c, at) => {
    namedDocuments(path, c, at, 'documents');
    if (Object.hasOwn(c, 'external')) namedDocuments(path, c, at, 'external');
  });
}

// headerName is the third word of the first line, the document name of a dbspec header, split at single spaces.
function headerName(lines) {
  return lines.length === 0 ? undefined : lines[0].split(' ')[2];
}

// namedDocuments checks an array of documents, each a line array whose first line is a header that names it.
function namedDocuments(path, object, location, key) {
  field(path, object, location, key, 'array').forEach((lines, i) => {
    const at = `${location}.${key}[${i}]`;
    checkLines(path, lines, at);
    if (headerName(lines) === undefined) fail(path, `${at}[0]`, 'has no document name');
  });
}

// checkSyntax checks tests/dbspec/syntax.json: the id of each case. The expected tokens are the runtime tests' to
// check; this runner compares what each client gives.
function checkSyntax(path, v) {
  cases(path, v, 'cases', () => {});
}

function checkDdl(path, v) {
  cases(path, v, 'cases', (c, at) => documents(path, c, at, 'documents'));
}

function checkPlans(path, v) {
  for (const kind of ['cases', 'invalid']) {
    cases(path, v, kind, (c, at) => {
      if (field(path, c, at, 'source', 'any') !== null) checkLines(path, c.source, `${at}.source`);
      lines(path, c, at, 'plan');
    });
  }
  cases(path, v, 'chains', (c, at) => field(path, c, at, 'plans', 'array').forEach((p, i) => checkLines(path, p, `${at}.plans[${i}]`)));
  cases(path, v, 'parse', (c, at) => lines(path, c, at, 'plan'));
  cases(path, v, 'comparisons', (c, at) => {
    lines(path, c, at, 'source');
    lines(path, c, at, 'target');
  });
}

function checkMermaid(path, v) {
  cases(path, v, 'export', (c, at) => {
    lines(path, c, at, 'document');
    documents(path, c, at, 'documents');
  });
  for (const kind of ['import', 'invalid']) cases(path, v, kind, (c, at) => lines(path, c, at, 'mermaid'));
  cases(path, v, 'round_trip', (c, at) => field(path, c, at, 'path', 'string'));
}

// join은 줄을 LF로, crlf이면 CRLF로, mixed이면 CRLF와 LF를 번갈아 마지막 줄 끝 없이 잇는다.
function join(lines, crlf, mixed) {
  if (mixed) return lines.map((line, i) => (i === lines.length - 1 ? line : line + (i % 2 === 0 ? '\r\n' : '\n'))).join('');
  const end = crlf ? '\r\n' : '\n';
  return lines.join(end) + end;
}

const out = [];

// write는 text의 diagnostic을, 없으면 그 emission을 출력한다.
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

// readDocument는 path의 dbspec document 파일을 readDbspecFile로 읽는다. 읽을 수 없는 파일은
// "<path>: <reason>"을, signature가 없는 파일은 그 diagnostic message를 stderr에 쓰고 1로 끝낸다.
function readDocument(path) {
  let read;
  try {
    read = readDbspecFile(path);
  } catch (error) {
    console.error(`${path}: ${error.message}`);
    process.exit(1);
  }
  if (read.text === null) {
    console.error(read.diagnostics[0].message);
    process.exit(1);
  }
  return read.text;
}

const shared = readVectors(casesPath, checkCases);
for (const kind of ['canonical', 'normalize', 'invalid']) {
  for (const c of shared[kind]) {
    const crlf = c.crlf === true;
    const mixed = c.mixed === true;
    const set = {};
    for (const [name, lines] of Object.entries(c.documents)) if (name !== c.main) set[name] = join(lines, crlf, mixed);
    out.push(`${kind}/${c.id}`);
    write(join(c.documents[c.main], crlf, mixed), set, false);
  }
}
out.push('stress');
write(readDocument(stressPath), {}, true);
// files case는 readDbspecFile에 path를 주어 "files/<id>"로, readDbspecBytes에 파일 byte와
// case path를 이름으로 주어 "files/<id>/bytes"로 읽어 diagnostic과 그 message를, 없으면
// emission을 출력한다. message 앞의 이름은 "<name>"으로 쓴다.
for (const c of shared.files) {
  const path = joinPath(dirname(casesPath), c.path);
  let reads;
  try {
    reads = [[`files/${c.id}`, path, readDbspecFile(path)], [`files/${c.id}/bytes`, c.path, readDbspecBytes(c.path, readFileSync(path))]];
  } catch (error) {
    console.error(`${path}: ${error.message}`);
    process.exit(1);
  }
  for (const [label, name, read] of reads) {
    out.push(label);
    if (read.text !== null) {
      write(read.text, {}, false);
      continue;
    }
    for (const d of read.diagnostics) {
      out.push(`! ${d.rule} ${d.line} ${d.column}`);
      out.push(`= ${d.message.startsWith(name) ? '<name>' + d.message.slice(name.length) : d.message}`);
    }
  }
}

// writeManifest는 case 문서 집합의 hash와 text를, 또는 문서나 집합의 diagnostic을 출력한다.
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

for (const c of shared.hashes) {
  out.push(`hashes/${c.id}`);
  writeManifest(c);
}

// writeRender는 case 문서 집합의 statement를 dialect마다, 또는 문서나 집합의 diagnostic을
// 출력한다.
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

for (const c of readVectors(ddlPath, checkDdl).cases) writeRender(c);

// writeStep은 step 하나를 statement 줄과 그 속성 줄로 쓴다(tests/dbspec/compare/check.mjs).
function writeStep(s) {
  out.push(`| ${s.statement}`);
  if (s.finalize) out.push('  finalize');
  else if (s.rollback !== '') out.push(`  rollback: ${s.rollback}`);
  else out.push(`  irreversible: ${s.irreversible}`);
  out.push(`  effect: ${effectText(s.effect)}`);
  if (s.restore !== '') out.push(`  restore: ${s.restore}`);
  if (s.rollbackRestore !== '') out.push(`  rollback_restore: ${s.rollbackRestore}`);
  if (s.restore !== '' || s.rollbackRestore !== '') out.push(`  restore_if: ${effectText(s.restoreIf)}`);
  for (const c of s.nullChecks) out.push(`  null_check: ${c.table} ${c.column} ${c.default ?? 'none'}`);
}

// writePlanDiagnostics는 diagnostic을 출력한다. plan, chain, compare diagnostic은 모든
// client가 공유하는 message로 끝나고, target이나 source의 schema diagnostic은 그렇지 않다.
function writePlanDiagnostics(diagnostics) {
  for (const d of diagnostics) {
    out.push(['plan', 'chain', 'compare'].includes(d.rule) ? `! ${d.rule} ${d.line} ${d.column} ${d.message}` : `! ${d.rule} ${d.line} ${d.column}`);
  }
}

// planSource는 plan case의 source schema를, 빈 schema이면 null을, diagnostic을 출력했으면
// undefined를 돌려준다.
function planSource(lines) {
  if (lines === null) return null;
  const result = parseDbspec(join(lines, false, false), {});
  if (result.document === null) {
    writePlanDiagnostics(result.diagnostics);
    return undefined;
  }
  return result.document;
}

// writeChanges는 change를 "| kind table name"으로 출력한다.
function writeChanges(changes) {
  for (const c of changes) out.push(`| ${c.kind} ${c.table} ${c.name}`);
}

function writeEmittedPlan(plan) {
  for (const line of emitPlan(plan).split('\n')) out.push(`| ${line}`);
}

const plans = readVectors(plansPath, checkPlans);
for (const c of plans.cases) {
  out.push(`plans/cases/${c.id}`);
  const source = planSource(c.source);
  if (source === undefined) continue;
  const parsed = parsePlan(join(c.plan, false, false));
  if (parsed.plan === null) {
    writePlanDiagnostics(parsed.diagnostics);
    continue;
  }
  writeEmittedPlan(parsed.plan);
  out.push(`plans/cases/${c.id}/changes`);
  const diff = diffPlan(source, parsed.plan);
  writePlanDiagnostics(diff.diagnostics);
  writeChanges(diff.changes ?? []);
  for (const dialect of ['mysql', 'postgres', 'sqlite']) {
    out.push(`plans/cases/${c.id}/${dialect}`);
    const result = planSteps(source, parsed.plan, dialect);
    writePlanDiagnostics(result.diagnostics);
    for (const s of result.steps ?? []) writeStep(s);
  }
}
for (const c of plans.invalid) {
  out.push(`plans/invalid/${c.id}`);
  const source = planSource(c.source);
  if (source === undefined) continue;
  const parsed = parsePlan(join(c.plan, false, false));
  if (parsed.plan === null) {
    writePlanDiagnostics(parsed.diagnostics);
    continue;
  }
  const diff = diffPlan(source, parsed.plan);
  writePlanDiagnostics(diff.diagnostics);
  writeChanges(diff.changes ?? []);
}
for (const c of plans.chains) {
  out.push(`plans/chains/${c.id}`);
  const parsed = c.plans.map(lines => parsePlan(join(lines, false, false)));
  for (const p of parsed) writePlanDiagnostics(p.diagnostics);
  if (parsed.some(p => p.plan === null)) continue;
  const chain = chainPlans(parsed.map(p => p.plan));
  writePlanDiagnostics(chain.diagnostics);
  for (const p of chain.plans ?? []) out.push(`| ${p.name}`);
}
for (const c of plans.parse) {
  out.push(`plans/parse/${c.id}`);
  const parsed = parsePlan(join(c.plan, false, false));
  if (parsed.plan === null) writePlanDiagnostics(parsed.diagnostics);
  else writeEmittedPlan(parsed.plan);
}
for (const c of plans.comparisons) {
  out.push(`plans/comparisons/${c.id}`);
  const source = parseDbspec(join(c.source, false, false), {});
  writePlanDiagnostics(source.diagnostics);
  const target = parseDbspec(join(c.target, false, false), {});
  writePlanDiagnostics(target.diagnostics);
  if (source.document === null || target.document === null) continue;
  const result = compareSchemas(source.document, target.document);
  writePlanDiagnostics(result.diagnostics);
  for (const d of result.differences ?? []) out.push(`| ${d.kind} ${d.table} ${d.name}`);
}
// writeDropped는 export나 import가 뺀 것을 "= kind<TAB>table<TAB>name"으로 출력한다.
// 이유는 비교하지 않는다.
function writeDropped(dropped) {
  for (const u of dropped) out.push(`= ${u.kind}\t${u.table}\t${u.name}`);
}

// writeExport는 문서의 Mermaid text와 빠진 객체를 출력한다.
function writeExport(document) {
  const { mermaid, dropped } = exportMermaid(document);
  for (const line of mermaid.split('\n')) out.push(`| ${line}`);
  writeDropped(dropped);
  return mermaid;
}

// writeImport는 import의 emit한 문서와 빠진 객체를, 또는 diagnostic을 출력한다.
function writeImport(text) {
  const result = importMermaid(text, 'imported');
  if (result.document === null) {
    writePlanDiagnostics(result.diagnostics);
    return;
  }
  for (const line of emitDbspec(result.document).split('\n')) out.push(`| ${line}`);
  writeDropped(result.dropped);
}

const mermaid = readVectors(mermaidPath, checkMermaid);
for (const c of mermaid.export) {
  out.push(`mermaid/export/${c.id}`);
  const set = Object.fromEntries(Object.entries(c.documents).map(([name, lines]) => [name, join(lines, false, false)]));
  const parsed = parseDbspec(join(c.document, false, false), set);
  if (parsed.document === null) writePlanDiagnostics(parsed.diagnostics);
  else writeExport(parsed.document);
}
for (const kind of ['import', 'invalid']) {
  for (const c of mermaid[kind]) {
    out.push(`mermaid/${kind}/${c.id}`);
    writeImport(join(c.mermaid, false, false));
  }
}
for (const c of mermaid.round_trip) {
  out.push(`mermaid/round_trip/${c.id}`);
  let read;
  try {
    read = readDbspecFile(c.path);
  } catch (error) {
    console.error(`${c.path}: ${error.message}`);
    process.exit(1);
  }
  if (read.text === null) {
    writePlanDiagnostics(read.diagnostics);
    continue;
  }
  const parsed = parseDbspec(read.text, {});
  if (parsed.document === null) {
    writePlanDiagnostics(parsed.diagnostics);
    continue;
  }
  const text = writeExport(parsed.document);
  out.push(`mermaid/round_trip/${c.id}/import`);
  writeImport(text);
}
// The declaration positions of the main document of each positions case, as "| kind<TAB>line<TAB>column<TAB>path..."
// lines, or its diagnostics.
for (const c of shared.positions) {
  out.push(`positions/${c.id}`);
  const set = {};
  for (const [name, lines] of Object.entries(c.documents)) if (name !== c.main) set[name] = join(lines, false, false);
  const result = parseDbspec(join(c.documents[c.main], false, false), set);
  for (const d of result.diagnostics) out.push(`! ${d.rule} ${d.line} ${d.column}`);
  for (const p of result.positions ?? []) out.push(`| ${[p.kind, p.line, p.column, ...p.path].join('\t')}`);
}

// syntaxInputs gives the input of every analysis that syntax.json names, by its id, as
// scripts/dbspec/syntax-vectors.mjs derives it from cases.json: the main document of each canonical, normalize and
// invalid case ("<section>/<id>"), each document of a sets case with the parsing documents and the other documents of
// the case by header name ("sets/<id>/<place>", 1-based), and each document of a hashes case with the others
// ("hashes/<id>/<name>").
function syntaxInputs() {
  const inputs = new Map();
  for (const kind of ['canonical', 'normalize', 'invalid']) {
    for (const c of shared[kind]) {
      const crlf = c.crlf === true;
      const mixed = c.mixed === true;
      const set = {};
      for (const [name, lines] of Object.entries(c.documents)) if (name !== c.main) set[name] = join(lines, crlf, mixed);
      inputs.set(`${kind}/${c.id}`, { text: join(c.documents[c.main], crlf, mixed), documents: set });
    }
  }
  for (const c of shared.sets) {
    const every = [...c.documents, ...(c.external ?? [])];
    c.documents.forEach((lines, i) => {
      const set = {};
      for (const [name, other] of Object.entries(c.parsing)) set[name] = join(other, false, false);
      every.forEach((other, j) => {
        if (j !== i) set[headerName(other)] = join(other, false, false);
      });
      inputs.set(`sets/${c.id}/${i + 1}`, { text: join(lines, false, false), documents: set });
    });
  }
  for (const c of shared.hashes) {
    for (const name of Object.keys(c.documents)) {
      const set = {};
      for (const [other, lines] of Object.entries(c.documents)) if (other !== name) set[other] = join(lines, false, false);
      inputs.set(`hashes/${c.id}/${name}`, { text: join(c.documents[name], false, false), documents: set });
    }
  }
  return inputs;
}

// Each case of syntax.json prints its tokens ("| line start end class") and the diagnostics of its analysis, then
// "syntax/<id>/format" and the formatted text or the diagnostics of the refusal.
const inputs = syntaxInputs();
readVectors(syntaxPath, checkSyntax).cases.forEach((c, i) => {
  const input = inputs.get(c.id);
  if (input === undefined) fail(syntaxPath, `cases[${i}].id`, 'names no input of the shared cases');
  out.push(`syntax/${c.id}`);
  const analysis = analyzeDbspec(input.text, input.documents);
  for (const t of analysis.tokens) out.push(`| ${t.line} ${t.start} ${t.end} ${t.class}`);
  for (const d of analysis.diagnostics) out.push(`! ${d.rule} ${d.line} ${d.column}`);
  out.push(`syntax/${c.id}/format`);
  const formatted = formatDbspec(input.text, input.documents);
  for (const d of formatted.diagnostics) out.push(`! ${d.rule} ${d.line} ${d.column}`);
  if (formatted.text !== null) for (const line of formatted.text.split('\n')) out.push(`| ${line}`);
});
process.stdout.write(out.join('\n') + '\n');
