// 연결의 addTablesAndColumns가 실행할 step을 쓴다(docs/schema.md "Adding tables and columns").
import { compareSchemas } from './compare.js';
import { emitDocument } from './emit.js';
import type { DbspecUnsupported } from './introspect_catalog.js';
import type { DbspecDiagnostic, DbspecDocument, DbspecTable } from './model.js';
import { planTo } from './plan.js';
import { planSteps, type DbspecPlanStep } from './plan_steps.js';
import type { DbspecDialect } from './render.js';
import { dbspecManifest } from './index.js';

/** 만드는 table과 더하는 column, step, 차이다. 차이가 있으면 목록과 step은 비어 있다. */
export interface DbspecAddTablesAndColumnsSteps {
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
 * database가 document set과 같은지 확인한다(docs/schema.md "Schema installation"). live는 연결의
 * database를 introspect한 문서, unsupported는 introspection이 읽지 못한 객체, target은 document
 * set의 schema text 문서다. set에 없는 database의 table은 비교하지 않는다. set의 table에 읽지 못한
 * 객체가 있으면 그 객체를 "unsupported_<kind> <table>[.<name>]: <reason>"로, 아니면 database에 있는
 * set의 table에서 set까지의 모든 차이를 "<kind> <table>[.<name>]"로 돌려준다. 빈 목록이면 같다.
 */
export function installedDifferences(live: DbspecDocument, unsupported: readonly DbspecUnsupported[], target: DbspecDocument): readonly string[] {
  const { comparison, differences } = compareSet(live, unsupported, target);
  for (const d of comparison?.differences ?? []) differences.push(`${d.kind} ${qualified(d.table, d.name)}`);
  return differences;
}

/**
 * database에 있는 set의 table(source)과 set을 비교한다. set의 table에 읽지 못한 객체가 있으면
 * source 없이 그 객체를 차이로 돌려준다. 아니면 set의 table 이름별 정의, source, 비교 결과와 그
 * diagnostic을 돌려준다.
 */
function compareSet(live: DbspecDocument, unsupported: readonly DbspecUnsupported[], target: DbspecDocument): {
  declared: Map<string, DbspecTable>;
  source: DbspecDocument | null;
  comparison: ReturnType<typeof compareSchemas> | null;
  differences: string[];
} {
  const declared = new Map(target.tables.map(t => [t.name, t]));
  const differences: string[] = [];
  // set의 table에 읽지 못한 객체가 있으면 그 table은 set과 같다고 할 수 없다.
  for (const u of unsupported) {
    if (declared.has(u.table)) differences.push(`unsupported_${u.kind} ${qualified(u.table, u.name)}: ${u.reason}`);
  }
  if (differences.length > 0) return { declared, source: null, comparison: null, differences };
  const source = schemaDocument(live.tables.filter(t => declared.has(t.name)));
  const comparison = compareSchemas(source, target);
  for (const d of comparison.diagnostics) differences.push(`${d.rule}: ${d.message}`);
  return { declared, source, comparison, differences };
}

/**
 * live는 연결의 database를 introspect한 문서, unsupported는 introspection이 읽지 못한 객체,
 * target은 document set의 schema text 문서다. set에 없는 database의 table은 비교하지도 바꾸지도
 * 않는다. database에 있는 set의 table과 set의 차이가 database에 없는 table의 create_table과
 * null이거나 default가 있는 column의 add_column뿐이면, database에 있는 set의 table에서 set까지의
 * plan step(docs/plans.md "Steps")과, table 이름 순으로 만드는 table은 "table", 더하는 column은
 * column 순서로 "table.column"인 목록을 돌려준다. 다른 차이는 step 없이 "<kind> <table>[.<name>]"로
 * 돌려준다.
 */
export function addTablesAndColumnsSteps(live: DbspecDocument, unsupported: readonly DbspecUnsupported[], target: DbspecDocument, dialect: DbspecDialect): DbspecAddTablesAndColumnsSteps {
  const { declared, source, comparison, differences } = compareSet(live, unsupported, target);
  const none = (): DbspecAddTablesAndColumnsSteps => ({ added: [], steps: [], differences });
  if (source === null || comparison === null) return none();
  const adding = new Set<string>();
  for (const d of comparison.differences ?? []) {
    if (d.kind === 'create_table') {
      adding.add(d.table);
      continue;
    }
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
  if (differences.length > 0 || adding.size === 0) return none();
  // 만드는 table과 더하는 column은 table 이름 순, table 안에서는 column 순서다.
  const added = target.tables.flatMap(t => adding.has(t.name)
    ? [t.name]
    : t.columns.map(c => qualified(t.name, c.name)).filter(name => adding.has(name)));
  // 더하는 table과 column은 plan 하나로 쓴다. plan은 database에 있는 set의 table에서 시작하므로
  // (하나도 없으면 빈 database) step은 docs/plans.md의 순서와 rollback을 그대로 갖는다.
  let failed: readonly DbspecDiagnostic[] = [];
  let from: string | null = null;
  if (source.tables.length > 0) {
    const manifest = dbspecManifest([source]);
    failed = manifest.diagnostics;
    if (manifest.manifest !== null) from = manifest.manifest.schemaHash;
  }
  let steps: readonly DbspecPlanStep[] = [];
  if (failed.length === 0) {
    // target은 외부 문서를 쓰는 set의 schema text일 수 있으므로 plan 문서를 parse하지 않고 target으로 plan을 만든다.
    const plan = planTo(
      { name: 'add_tables_and_columns', from, renameTables: [], renameColumns: [], dropTables: [], dropColumns: [] },
      target,
      emitDocument(target, 'canonical'),
    );
    failed = plan.diagnostics;
    if (plan.plan !== null) {
      const written = planSteps(source.tables.length > 0 ? source : null, plan.plan, dialect);
      failed = written.diagnostics;
      steps = written.steps ?? [];
    }
  }
  for (const d of failed) differences.push(`${d.rule}: ${d.message}`);
  if (differences.length > 0) return none();
  return { added, steps, differences: [] };
}
