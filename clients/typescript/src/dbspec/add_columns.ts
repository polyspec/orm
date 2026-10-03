// 연결의 addColumns가 실행할 step을 쓴다(docs/schema.md "Adding columns").
import { compareSchemas } from './compare.js';
import { emitDocument } from './emit.js';
import type { DbspecUnsupported } from './introspect_catalog.js';
import type { DbspecDiagnostic, DbspecDocument, DbspecTable } from './model.js';
import { parsePlan } from './plan.js';
import { planSteps, type DbspecPlanStep } from './plan_steps.js';
import type { DbspecDialect } from './render.js';
import { dbspecManifest } from './index.js';

/** 더하는 column, step, 차이다. 차이가 있으면 column과 step은 비어 있다. */
export interface DbspecAddColumnSteps {
  readonly added: readonly string[];
  readonly steps: readonly DbspecPlanStep[];
  readonly differences: readonly string[];
}

function qualified(table: string, name: string): string {
  return name === '' ? table : `${table}.${name}`;
}

function schemaDocument(tables: readonly DbspecTable[]): DbspecDocument {
  return { name: 'schema', uses: [], tables, diagrams: [], closingComments: [] };
}

/**
 * live는 연결의 database를 introspect한 문서, unsupported는 introspection이 읽지 못한 객체,
 * target은 document set의 schema text 문서다. 두 쪽에 다 있는 table만 비교하므로 database에 없는
 * set의 table과 set에 없는 database의 table은 그대로 둔다. 차이가 null이거나 default가 있는
 * column의 add_column뿐이면, 그 table들의 live 문서에서 target까지의 plan step(docs/plans.md
 * "Steps")과 더하는 column을 table 이름, column 순서로 "table.column"으로 돌려준다. 다른 차이는
 * step 없이 "<kind> <table>[.<name>]"로 돌려준다.
 */
export function addColumnSteps(live: DbspecDocument, unsupported: readonly DbspecUnsupported[], target: DbspecDocument, dialect: DbspecDialect): DbspecAddColumnSteps {
  const declared = new Map(target.tables.map(t => [t.name, t]));
  const differences: string[] = [];
  const none = (): DbspecAddColumnSteps => ({ added: [], steps: [], differences });
  // set의 table에 읽지 못한 객체가 있으면 그 table은 set과 같다고 할 수 없다.
  for (const u of unsupported) {
    if (declared.has(u.table)) differences.push(`unsupported_${u.kind} ${qualified(u.table, u.name)}: ${u.reason}`);
  }
  const existing = new Set(live.tables.filter(t => declared.has(t.name)).map(t => t.name));
  const source = schemaDocument(live.tables.filter(t => existing.has(t.name)));
  const part = schemaDocument(target.tables.filter(t => existing.has(t.name)));
  if (differences.length > 0 || part.tables.length === 0) return none();
  const comparison = compareSchemas(source, part);
  const diagnostics: DbspecDiagnostic[] = [...comparison.diagnostics];
  const adding = new Set<string>();
  for (const d of comparison.differences ?? []) {
    if (d.kind === 'add_column') {
      const column = declared.get(d.table)!.columns.find(c => c.name === d.name);
      if (column === undefined || column.identity || (!column.nullable && column.default === null)) {
        differences.push(`add_column ${qualified(d.table, d.name)} without null or default`);
        continue;
      }
      adding.add(qualified(d.table, d.name));
      continue;
    }
    differences.push(`${d.kind} ${qualified(d.table, d.name)}`);
  }
  for (const d of diagnostics) differences.push(`${d.rule}: ${d.message}`);
  if (differences.length > 0 || adding.size === 0) return none();
  // 더하는 column은 table 이름 순, table 안에서는 column 순서다.
  const added = part.tables.flatMap(t => t.columns.map(c => qualified(t.name, c.name)).filter(name => adding.has(name)));
  // 더하는 column은 plan 하나로 쓴다. plan은 source schema에서 시작하므로 step은 docs/plans.md의
  // 순서와 rollback을 그대로 갖는다.
  const manifest = dbspecManifest([source]);
  let failed: readonly DbspecDiagnostic[] = manifest.diagnostics;
  let steps: readonly DbspecPlanStep[] = [];
  if (manifest.manifest !== null) {
    const plan = parsePlan(`dbplan 1 add_columns\nfrom ${manifest.manifest.schemaHash}\n\n${emitDocument(part, 'canonical')}`);
    failed = plan.diagnostics;
    if (plan.plan !== null) {
      const written = planSteps(source, plan.plan, dialect);
      failed = written.diagnostics;
      steps = written.steps ?? [];
    }
  }
  for (const d of failed) differences.push(`${d.rule}: ${d.message}`);
  if (differences.length > 0) return none();
  return { added, steps, differences: [] };
}
