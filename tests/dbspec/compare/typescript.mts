// 모든 공유 case, stress 문서, statement vector, plan vector, Mermaid vector의 TypeScript
// dbspec 결과를 tests/dbspec/compare/check.mts의 줄 형식으로 출력한다. It then prints the positions cases of
// cases.json and the analysis and format of each case of syntax.json.
//
// Usage: node tests/dbspec/compare/typescript.mts <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json> <syntax.json>
// (TypeScript build 뒤)
import { readFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { parseCases, type Cases } from '../cases.mts';
import { readVectors, vectorProblems } from '../vectors.mts';
import { join, vectorInputs } from '../../../scripts/dbspec/syntax-vectors.mts';
import { SchemaError } from '../../../scripts/json/schema.mts';
import { errorMessage } from '../../errors.mts';
import { readInput } from '../input.mts';
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
  type DbspecChange,
  type DbspecDiagnostic,
  type DbspecDialect,
  type DbspecDocument,
  type DbspecPlan,
  type DbspecPlanStep,
  type DbspecReadResult,
  type DbspecUnsupported,
} from '../../../packages/ts/dist/dbspec/index.js';

const [casesPath, stressPath, ddlPath, plansPath, mermaidPath, syntaxPath] = process.argv.slice(2);
if (casesPath === undefined || stressPath === undefined || ddlPath === undefined || plansPath === undefined || mermaidPath === undefined || syntaxPath === undefined) {
  console.error('usage: node tests/dbspec/compare/typescript.mts <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json> <syntax.json>');
  process.exit(2);
}

// fail은 vector file의 위치와 문제를 stderr에 쓰고 1로 끝낸다.
function fail(path: string, location: string, problem: string): never {
  console.error(`${path}: ${location} ${problem}`);
  process.exit(1);
}

// readShared reads cases.json strictly (tests/dbspec/cases.mts) and checks that each document of a sets case names
// itself in its header, which the analysis inputs of syntax.json use as the document's name.
function readShared(path: string): Cases {
  let cases: Cases;
  try {
    cases = parseCases(readInput(path), path);
  } catch (error) {
    if (error instanceof SchemaError) for (const line of vectorProblems(path, error)) console.error(line);
    else console.error(errorMessage(error));
    process.exit(1);
  }
  cases.sets.forEach((c, index) => {
    for (const key of ['documents', 'external'] as const)
      (c[key] ?? []).forEach((lines, i) => {
        if (lines[0]?.split(' ')[2] === undefined) fail(path, `sets[${index}].${key}[${i}][0]`, 'has no document name');
      });
  });
  return cases;
}

const out: string[] = [];
const DIALECTS: readonly DbspecDialect[] = ['mysql', 'postgres', 'sqlite'];

// documentOf is the document of a parse without diagnostics; the parse gives a document exactly when it reports none.
function documentOf(result: { document: DbspecDocument | null; diagnostics: readonly unknown[] }): DbspecDocument | null {
  if (result.diagnostics.length > 0) return null;
  if (result.document === null) throw new Error('parseDbspec reported no diagnostic and no document');
  return result.document;
}

// others is the documents of a case other than name, each joined with its line ends.
function others(documents: Record<string, string[]>, name: string, crlf = false, mixed = false): Record<string, string> {
  return Object.fromEntries(Object.entries(documents).filter(([other]) => other !== name).map(([other, lines]) => [other, join(lines, crlf, mixed)]));
}

// write는 text의 diagnostic을, 없으면 그 emission을 출력한다.
function write(text: string, set: Record<string, string>, stress: boolean): void {
  const result = parseDbspec(text, set);
  const document = documentOf(result);
  if (document === null) {
    for (const d of result.diagnostics) out.push(`! ${d.rule} ${d.line} ${d.column}`);
    return;
  }
  const emitted = emitDbspec(document);
  if (stress) out.push(emitted === text ? '= unchanged' : '= changed');
  else for (const line of emitted.split('\n')) out.push(`| ${line}`);
}

// readDocument는 path의 dbspec document 파일을 readDbspecFile로 읽는다. 읽을 수 없는 파일은
// "<path>: <reason>"을, signature가 없는 파일은 그 diagnostic message를 stderr에 쓰고 1로 끝낸다.
function readDocument(path: string): string {
  let read: DbspecReadResult;
  try {
    read = readDbspecFile(path);
  } catch (error) {
    console.error(`${path}: ${errorMessage(error)}`);
    process.exit(1);
  }
  if (read.text === null) {
    console.error(read.diagnostics.map(d => d.message).join('\n'));
    process.exit(1);
  }
  return read.text;
}

const shared = readShared(casesPath);
for (const kind of ['canonical', 'normalize', 'invalid'] as const) {
  for (const c of shared[kind]) {
    const crlf = c.crlf === true;
    const mixed = c.mixed === true;
    out.push(`${kind}/${c.id}`);
    write(join(c.documents[c.main] ?? [], crlf, mixed), others(c.documents, c.main, crlf, mixed), false);
  }
}
out.push('stress');
write(readDocument(stressPath), {}, true);
// files case는 readDbspecFile에 path를 주어 "files/<id>"로, readDbspecBytes에 파일 byte와
// case path를 이름으로 주어 "files/<id>/bytes"로 읽어 diagnostic과 그 message를, 없으면
// emission을 출력한다. message 앞의 이름은 "<name>"으로 쓴다.
for (const c of shared.files) {
  const path = joinPath(dirname(casesPath), c.path);
  let reads: [string, string, DbspecReadResult][];
  try {
    reads = [[`files/${c.id}`, path, readDbspecFile(path)], [`files/${c.id}/bytes`, c.path, readDbspecBytes(c.path, readFileSync(path))]];
  } catch (error) {
    console.error(`${path}: ${errorMessage(error)}`);
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
function writeManifest(c: { documents: Record<string, string[]> }): void {
  const documents: DbspecDocument[] = [];
  for (const name of Object.keys(c.documents).sort()) {
    const result = parseDbspec(join(c.documents[name] ?? [], false), others(c.documents, name));
    const document = documentOf(result);
    if (document === null) {
      for (const d of result.diagnostics) out.push(`! ${d.rule} ${d.line} ${d.column}`);
      return;
    }
    documents.push(document);
  }
  const result = dbspecManifest(documents);
  if (result.diagnostics.length > 0) {
    for (const d of result.diagnostics) out.push(`! ${d.rule} ${d.line} ${d.column}`);
    return;
  }
  const m = result.manifest;
  if (m === null) throw new Error('dbspecManifest reported no diagnostic and no manifest');
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
function writeRender(c: { documents: Record<string, string[]>; id: string }): void {
  const documents: DbspecDocument[] = [];
  for (const name of Object.keys(c.documents).sort()) {
    const result = parseDbspec(join(c.documents[name] ?? [], false), others(c.documents, name));
    const document = documentOf(result);
    if (document === null) {
      out.push(`render/${c.id}`);
      for (const d of result.diagnostics) out.push(`! ${d.rule} ${d.line} ${d.column}`);
      return;
    }
    documents.push(document);
  }
  for (const dialect of DIALECTS) {
    out.push(`render/${c.id}/${dialect}`);
    const result = renderDbspec(documents, dialect);
    for (const d of result.diagnostics) out.push(`! ${d.rule} ${d.line} ${d.column}`);
    for (const s of result.statements ?? []) out.push(`| ${s}`);
  }
}

for (const c of readVectors(ddlPath, 'ddl').cases) writeRender(c);

// writeStep은 step 하나를 statement 줄과 그 속성 줄로 쓴다(tests/dbspec/compare/check.mts).
function writeStep(s: DbspecPlanStep): void {
  out.push(`| ${s.statement}`);
  if (s.finalize) out.push('  finalize');
  else if (s.rollback !== '') out.push(`  rollback: ${s.rollback}`);
  else out.push(`  irreversible: ${s.irreversible}`);
  out.push(`  effect: ${effectText(s.effect)}`);
  if (s.restore !== '') out.push(`  restore: ${s.restore}`);
  if (s.rollbackRestore !== '') out.push(`  rollback_restore: ${s.rollbackRestore}`);
  if (s.restore !== '' || s.rollbackRestore !== '') {
    if (s.restoreIf === null) throw new Error(`the step ${s.statement} restores without its condition`);
    out.push(`  restore_if: ${effectText(s.restoreIf)}`);
  }
  for (const c of s.nullChecks) out.push(`  null_check: ${c.table} ${c.column} ${c.default ?? 'none'}`);
}

// writePlanDiagnostics는 diagnostic을 출력한다. plan, chain, compare diagnostic은 모든
// client가 공유하는 message로 끝나고, target이나 source의 schema diagnostic은 그렇지 않다.
function writePlanDiagnostics(diagnostics: readonly DbspecDiagnostic[]): void {
  for (const d of diagnostics) {
    out.push(['plan', 'chain', 'compare'].includes(d.rule) ? `! ${d.rule} ${d.line} ${d.column} ${d.message}` : `! ${d.rule} ${d.line} ${d.column}`);
  }
}

// planSource는 plan case의 source schema를, 빈 schema이면 null을, diagnostic을 출력했으면
// undefined를 돌려준다.
function planSource(lines: string[] | null): DbspecDocument | null | undefined {
  if (lines === null) return null;
  const result = parseDbspec(join(lines, false), {});
  const document = documentOf(result);
  if (document === null) {
    writePlanDiagnostics(result.diagnostics);
    return undefined;
  }
  return document;
}

// writeChanges는 change를 "| kind table name"으로 출력한다.
function writeChanges(changes: readonly DbspecChange[]): void {
  for (const c of changes) out.push(`| ${c.kind} ${c.table} ${c.name}`);
}

function writeEmittedPlan(plan: DbspecPlan): void {
  for (const line of emitPlan(plan).split('\n')) out.push(`| ${line}`);
}

const plans = readVectors(plansPath, 'plans');
for (const c of plans.cases) {
  out.push(`plans/cases/${c.id}`);
  const source = planSource(c.source);
  if (source === undefined) continue;
  const parsed = parsePlan(join(c.plan, false));
  if (parsed.plan === null) {
    writePlanDiagnostics(parsed.diagnostics);
    continue;
  }
  writeEmittedPlan(parsed.plan);
  out.push(`plans/cases/${c.id}/changes`);
  const diff = diffPlan(source, parsed.plan);
  writePlanDiagnostics(diff.diagnostics);
  writeChanges(diff.changes ?? []);
  for (const dialect of DIALECTS) {
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
  const parsed = parsePlan(join(c.plan, false));
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
  const parsed = c.plans.map(lines => parsePlan(join(lines, false)));
  for (const p of parsed) writePlanDiagnostics(p.diagnostics);
  const chained = parsed.flatMap(p => (p.plan === null ? [] : [p.plan]));
  if (chained.length !== parsed.length) continue;
  const chain = chainPlans(chained);
  writePlanDiagnostics(chain.diagnostics);
  for (const p of chain.plans ?? []) out.push(`| ${p.name}`);
}
for (const c of plans.parse) {
  out.push(`plans/parse/${c.id}`);
  const parsed = parsePlan(join(c.plan, false));
  if (parsed.plan === null) writePlanDiagnostics(parsed.diagnostics);
  else writeEmittedPlan(parsed.plan);
}
for (const c of plans.comparisons) {
  out.push(`plans/comparisons/${c.id}`);
  const source = parseDbspec(join(c.source, false), {});
  writePlanDiagnostics(source.diagnostics);
  const target = parseDbspec(join(c.target, false), {});
  writePlanDiagnostics(target.diagnostics);
  if (source.document === null || target.document === null) continue;
  const result = compareSchemas(source.document, target.document);
  writePlanDiagnostics(result.diagnostics);
  for (const d of result.differences ?? []) out.push(`| ${d.kind} ${d.table} ${d.name}`);
}
// writeDropped는 export나 import가 뺀 것을 "= kind<TAB>table<TAB>name"으로 출력한다.
// 이유는 비교하지 않는다.
function writeDropped(dropped: readonly DbspecUnsupported[]): void {
  for (const u of dropped) out.push(`= ${u.kind}\t${u.table}\t${u.name}`);
}

// writeExport는 문서의 Mermaid text와 빠진 객체를 출력한다.
function writeExport(document: DbspecDocument): string {
  const { mermaid, dropped } = exportMermaid(document);
  for (const line of mermaid.split('\n')) out.push(`| ${line}`);
  writeDropped(dropped);
  return mermaid;
}

// writeImport는 import의 emit한 문서와 빠진 객체를, 또는 diagnostic을 출력한다.
function writeImport(text: string) {
  const result = importMermaid(text, 'imported');
  if (result.document === null) {
    writePlanDiagnostics(result.diagnostics);
    return;
  }
  for (const line of emitDbspec(result.document).split('\n')) out.push(`| ${line}`);
  writeDropped(result.dropped);
}

const mermaid = readVectors(mermaidPath, 'mermaid');
for (const c of mermaid.export) {
  out.push(`mermaid/export/${c.id}`);
  const set = Object.fromEntries(Object.entries(c.documents).map(([name, lines]) => [name, join(lines, false)]));
  const parsed = parseDbspec(join(c.document, false), set);
  if (parsed.document === null) writePlanDiagnostics(parsed.diagnostics);
  else writeExport(parsed.document);
}
for (const kind of ['import', 'invalid'] as const) {
  for (const c of mermaid[kind]) {
    out.push(`mermaid/${kind}/${c.id}`);
    writeImport(join(c.mermaid, false));
  }
}
for (const c of mermaid.round_trip) {
  out.push(`mermaid/round_trip/${c.id}`);
  let read: DbspecReadResult;
  try {
    read = readDbspecFile(c.path);
  } catch (error) {
    console.error(`${c.path}: ${errorMessage(error)}`);
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
  const result = parseDbspec(join(c.documents[c.main] ?? [], false), others(c.documents, c.main));
  for (const d of result.diagnostics) out.push(`! ${d.rule} ${d.line} ${d.column}`);
  for (const p of result.positions ?? []) out.push(`| ${[p.kind, p.line, p.column, ...p.path].join('\t')}`);
}

// The input of every analysis that syntax.json names, by its id, is the one scripts/dbspec/syntax-vectors.mts derives
// from cases.json (vectorInputs), so the generator and this runner read the same inputs.

// Each case of syntax.json prints its tokens ("| line start end class") and the diagnostics of its analysis, then
// "syntax/<id>/format" and the formatted text or the diagnostics of the refusal.
const inputs = new Map(vectorInputs(shared).map(input => [input.id, input]));
readVectors(syntaxPath, 'syntax').cases.forEach((c, i) => {
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
