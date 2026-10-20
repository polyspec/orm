// TypeScript side of every shared case, stress document, statement vector, plan vector, and Mermaid vector:
// dbspec results are printed in the line format of tests/dbspec/compare/check.mts. It then prints the positions cases of
// cases.json and the analysis and format of each case of syntax.json.
//
// Usage: node packages/ts/testing/dbspec/compare/typescript.mts <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json> <syntax.json>
// (after the TypeScript build)
import { readFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { parseCases, type Cases } from '../../../../../tests/dbspec/cases.mts';
import { readVectors, vectorProblems } from '../../../../../tests/dbspec/vectors.mts';
import { join, vectorInputs } from '../../../../../scripts/dbspec/syntax-vectors.mts';
import { SchemaError } from '../../../../../scripts/json/schema.mts';
import { errorMessage } from '../../../../../tests/errors.mts';
import { readInput } from '../../../../../tests/dbspec/input.mts';
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
} from '../../../dist/dbspec/index.js';

const [casesPath, stressPath, ddlPath, plansPath, mermaidPath, syntaxPath] = process.argv.slice(2);
if (casesPath === undefined || stressPath === undefined || ddlPath === undefined || plansPath === undefined || mermaidPath === undefined || syntaxPath === undefined) {
  console.error('usage: node packages/ts/testing/dbspec/compare/typescript.mts <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json> <syntax.json>');
  process.exit(2);
}

// fail writes the position and the problem of the vector file to stderr and exits with 1.
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

// write prints the diagnostic of the text, or otherwise its emission.
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

// readDocument reads the dbspec document file at path with readDbspecFile. A file that cannot be read
// is reported as "<path>: <reason>", and a file without a signature writes its diagnostic message to stderr and exits with 1.
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
// The files case passes the path to readDbspecFile as "files/<id>", and passes the file bytes to readDbspecBytes
// with the case path as name as "files/<id>/bytes", and reads the diagnostic and its message, or otherwise
// the emission is printed. The name before the message is written as "<name>".
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

// parseDocuments parses the documents of a case in name order. It returns the diagnostics of the first document that is
// not valid, in place of the documents.
function parseDocuments(c: { documents: Record<string, string[]> }): { documents: DbspecDocument[] } | { diagnostics: readonly DbspecDiagnostic[] } {
  const documents: DbspecDocument[] = [];
  for (const name of Object.keys(c.documents).sort()) {
    const result = parseDbspec(join(c.documents[name] ?? [], false), others(c.documents, name));
    const document = documentOf(result);
    if (document === null) return { diagnostics: result.diagnostics };
    documents.push(document);
  }
  return { documents };
}

// writeManifest prints the hash and text of the case's document set, or the diagnostic of a document or set.
function writeManifest(c: { documents: Record<string, string[]> }): void {
  const parsed = parseDocuments(c);
  if ('diagnostics' in parsed) {
    for (const d of parsed.diagnostics) out.push(`! ${d.rule} ${d.line} ${d.column}`);
    return;
  }
  const documents = parsed.documents;
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

// writeRender prints the statements of the case's document set for each dialect, or
// the diagnostic of a document or set.
function writeRender(c: { documents: Record<string, string[]>; id: string }): void {
  const parsed = parseDocuments(c);
  if ('diagnostics' in parsed) {
    out.push(`render/${c.id}`);
    for (const d of parsed.diagnostics) out.push(`! ${d.rule} ${d.line} ${d.column}`);
    return;
  }
  const documents = parsed.documents;
  for (const dialect of DIALECTS) {
    out.push(`render/${c.id}/${dialect}`);
    const result = renderDbspec(documents, dialect);
    for (const d of result.diagnostics) out.push(`! ${d.rule} ${d.line} ${d.column}`);
    for (const s of result.statements ?? []) out.push(`| ${s}`);
  }
}

for (const c of readVectors(ddlPath, 'ddl').cases) writeRender(c);

// writeStep writes one step as a statement line and its attribute lines (tests/dbspec/compare/check.mts).
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

// writePlanDiagnostics prints the diagnostics. Plan, chain, and compare diagnostics all
// end with a message that every client shares, while schema diagnostics of the target or source do not.
function writePlanDiagnostics(diagnostics: readonly DbspecDiagnostic[]): void {
  for (const d of diagnostics) {
    out.push(['plan', 'chain', 'compare'].includes(d.rule) ? `! ${d.rule} ${d.line} ${d.column} ${d.message}` : `! ${d.rule} ${d.line} ${d.column}`);
  }
}

// planSource returns the source schema of the plan case, null for an empty schema,
// or undefined if it printed a diagnostic.
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

// writeChanges prints each change as "| kind table name".
function writeChanges(changes: readonly DbspecChange[]): void {
  for (const c of changes) out.push(`| ${c.kind} ${c.table} ${c.name}`);
}

function writeEmittedPlan(plan: DbspecPlan): void {
  for (const line of emitPlan(plan).split('\n')) out.push(`| ${line}`);
}

// planCase writes the header of a plan case and returns its source and parsed plan. It returns undefined when the case has
// no source, or when its plan does not parse; the diagnostics of that plan are written then.
function planCase(header: string, c: { source: string[] | null; plan: string[] }): { source: DbspecDocument | null; plan: DbspecPlan } | undefined {
  out.push(header);
  const source = planSource(c.source);
  if (source === undefined) return undefined;
  const parsed = parsePlan(join(c.plan, false));
  if (parsed.plan === null) {
    writePlanDiagnostics(parsed.diagnostics);
    return undefined;
  }
  return { source, plan: parsed.plan };
}

const plans = readVectors(plansPath, 'plans');
for (const c of plans.cases) {
  const planned = planCase(`plans/cases/${c.id}`, c);
  if (planned === undefined) continue;
  const { source, plan } = planned;
  writeEmittedPlan(plan);
  out.push(`plans/cases/${c.id}/changes`);
  const diff = diffPlan(source, plan);
  writePlanDiagnostics(diff.diagnostics);
  writeChanges(diff.changes ?? []);
  for (const dialect of DIALECTS) {
    out.push(`plans/cases/${c.id}/${dialect}`);
    const result = planSteps(source, plan, dialect);
    writePlanDiagnostics(result.diagnostics);
    for (const s of result.steps ?? []) writeStep(s);
  }
}
for (const c of plans.invalid) {
  const planned = planCase(`plans/invalid/${c.id}`, c);
  if (planned === undefined) continue;
  const diff = diffPlan(planned.source, planned.plan);
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
// writeDropped prints what the export or import dropped as "= kind<TAB>table<TAB>name".
// The reason is not compared.
function writeDropped(dropped: readonly DbspecUnsupported[]): void {
  for (const u of dropped) out.push(`= ${u.kind}\t${u.table}\t${u.name}`);
}

// writeExport prints the document's Mermaid text and the missing objects.
function writeExport(document: DbspecDocument): string {
  const { mermaid, dropped } = exportMermaid(document);
  for (const line of mermaid.split('\n')) out.push(`| ${line}`);
  writeDropped(dropped);
  return mermaid;
}

// writeImport prints the document emitted by the import and the missing objects, or the diagnostic.
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
