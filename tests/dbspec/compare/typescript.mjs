// Prints the TypeScript dbspec result of every shared case, of the stress
// document, of the statement vectors, of the plan vectors and of the Mermaid
// vectors in the line format of tests/dbspec/compare/check.mjs.
//
// Usage: node tests/dbspec/compare/typescript.mjs <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json>
// (after the TypeScript build)
import { readInput } from '../input.mjs';
import {
  chainPlans,
  compareSchemas,
  dbspecManifest,
  diffPlan,
  emitDbspec,
  emitPlan,
  exportMermaid,
  importMermaid,
  parseDbspec,
  parsePlan,
  planStatements,
  renderDbspec,
} from '../../../clients/typescript/dist/dbspec/index.js';

const [casesPath, stressPath, ddlPath, plansPath, mermaidPath] = process.argv.slice(2);
if (casesPath === undefined || stressPath === undefined || ddlPath === undefined || plansPath === undefined || mermaidPath === undefined) {
  console.error('usage: node tests/dbspec/compare/typescript.mjs <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json>');
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

// optionalBoolean은 key가 없으면 false를, 있으면 boolean인지 확인한 값을 돌려준다.
function optionalBoolean(path, object, location, key) {
  return Object.hasOwn(object, key) ? field(path, object, location, key, 'boolean') : false;
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

function checkCases(path, v) {
  for (const kind of ['canonical', 'normalize', 'invalid']) {
    cases(path, v, kind, (c, at) => {
      const main = field(path, c, at, 'main', 'string');
      const set = documents(path, c, at, 'documents');
      if (!Object.hasOwn(set, main)) fail(path, `${at}.documents.${main}`, 'is missing');
      optionalBoolean(path, c, at, 'crlf');
      optionalBoolean(path, c, at, 'mixed');
    });
  }
  cases(path, v, 'hashes', (c, at) => documents(path, c, at, 'documents'));
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
write(readInput(stressPath), {}, true);

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

for (const c of shared.hashes) {
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

for (const c of readVectors(ddlPath, checkDdl).cases) writeRender(c);

// writePlanDiagnostics prints diagnostics; a plan or chain diagnostic ends with
// its message, which every client shares, and a schema diagnostic of the
// target or source does not.
function writePlanDiagnostics(diagnostics) {
  for (const d of diagnostics) {
    out.push(['plan', 'chain', 'compare'].includes(d.rule) ? `! ${d.rule} ${d.line} ${d.column} ${d.message}` : `! ${d.rule} ${d.line} ${d.column}`);
  }
}

// planSource gives the source schema of a plan case, null for the empty
// schema, or undefined after printing its diagnostics.
function planSource(lines) {
  if (lines === null) return null;
  const result = parseDbspec(join(lines, false, false), {});
  if (result.document === null) {
    writePlanDiagnostics(result.diagnostics);
    return undefined;
  }
  return result.document;
}

// writeChanges prints the changes as "| kind table name".
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
    const result = planStatements(source, parsed.plan, dialect);
    writePlanDiagnostics(result.diagnostics);
    for (const s of result.statements ?? []) out.push(`| ${s}`);
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
// writeDropped prints what an export or import left out as
// "= kind<TAB>table<TAB>name"; reasons are not compared.
function writeDropped(dropped) {
  for (const u of dropped) out.push(`= ${u.kind}\t${u.table}\t${u.name}`);
}

// writeExport prints the Mermaid text and the dropped objects of a document.
function writeExport(document) {
  const { mermaid, dropped } = exportMermaid(document);
  for (const line of mermaid.split('\n')) out.push(`| ${line}`);
  writeDropped(dropped);
  return mermaid;
}

// writeImport prints the emitted document and the dropped objects of an
// import, or its diagnostics.
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
  const parsed = parseDbspec(readInput(c.path), {});
  if (parsed.document === null) {
    writePlanDiagnostics(parsed.diagnostics);
    continue;
  }
  const text = writeExport(parsed.document);
  out.push(`mermaid/round_trip/${c.id}/import`);
  writeImport(text);
}
process.stdout.write(out.join('\n') + '\n');
