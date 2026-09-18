#!/usr/bin/env node
// orm-gen: the TypeScript schema tool.
//
//   orm-gen gen      --schema schema.json --out src/models [--scan <file or directory>]...
//   orm-gen build    <files.mmd...> --out schema.json
//   orm-gen ddl      --schema <source> --dialect mysql|postgres|sqlite --out <file.sql>
//   orm-gen diff     --from <source> --to <source> --dialect mysql|postgres|sqlite --out <file.sql> [--allow-destructive]
//   orm-gen migrate  --dsn <dsn> --schema <source> [--migration-id id] [--name n] [--log-dir dir] [--dry-run]
//   orm-gen plan     --from <source> --to <source> --dialect mysql|postgres|sqlite --out YYYYMMDD-name.json
//   orm-gen apply    --plan YYYYMMDD-name.json --dsn <dsn> --schema schema.json [--allow-destructive]
//   orm-gen recover  (--plan YYYYMMDD-name.json | --migration-id id) --dsn <dsn> --schema schema.json
//   orm-gen rollback --plan YYYYMMDD-name.json --dsn <dsn> [--allow-destructive]
//   orm-gen verify   --dsn <dsn> --schema schema.json
//   orm-gen validate --dsn <dsn> --schema <source>
//   orm-gen import   --dsn <dsn> --out schema/app.mmd [--tables a,b]
//
// A DSN is a URI: mysql://, postgres://, or sqlite:///<absolute path>. A source
// is a .mmd diagram, schema.json, SQL written by `ddl` or `diff`, or db:<dsn>.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { loadManifest } from '../engine/manifest.js';
import { ddlErrorText, renderDDL } from '../engine/ddl.js';
import { generateTypeScript } from '../generate/typescript.js';
import { buildManifest, manifestText, manifestWarnings, type SchemaManifest } from '../schema/build.js';
import { byteOrder, listText } from '../schema/json.js';
import { parseDiagram, SchemaParseError, type Diagram } from '../schema/mermaid.js';
import { alignSourceChecks } from '../tools/checks.js';
import { openToolDb, parseToolDsn, type ToolDb } from '../tools/db.js';
import { loadedOf, renderDiff } from '../tools/diff.js';
import { filterManagedTables, readTables, renderMermaid, withTriggerDirectives } from '../tools/introspect.js';
import { checksumText, migrate, ToolError } from '../tools/migrate.js';
import {
  applyPlan, buildMigrationPlan, migrationPlanId, parsePlan, planSQL, recoverMigrationById, recoverPlan, rollbackPlan,
  validatePlanOperations, validateRollbackPlan, verifySchema, type MigrationPlanFile,
} from '../tools/plan.js';
import { loadSchemaSource } from '../tools/source.js';

const usageText = `usage: orm-gen gen --schema schema.json --out <directory> [--scan <file or directory>]...
       orm-gen build <files.mmd...> --out schema/schema.json
       orm-gen ddl --schema <source> --dialect mysql|postgres|sqlite --out <file.sql>
       orm-gen diff --from <source> --to <source> --dialect mysql|postgres|sqlite --out <file.sql> [--allow-destructive]
       orm-gen migrate --dsn <dsn> --schema <source> [--migration-id id] [--dry-run]
       orm-gen plan --from <source> --to <source> --dialect mysql|postgres|sqlite --out migration.json
       source: schema.mmd | schema.json | orm-gen .sql | db:<dsn>
       orm-gen apply --plan migration.json --dsn <dsn> --schema schema.json [--allow-destructive]
       orm-gen recover (--plan migration.json | --migration-id id) --dsn <dsn> --schema schema.json
       orm-gen rollback --plan YYYYMMDD-name.json --dsn <dsn> [--allow-destructive]
       orm-gen verify --dsn <dsn> --schema schema/schema.json
       orm-gen validate --dsn <dsn> --schema schema/schema.json
       orm-gen import --dsn <dsn> --out schema/app.mmd [--tables a,b]`;

class UsageError extends Error {}

function usage(message?: string): never {
  throw new UsageError(message ?? usageText);
}

/** Accepts -flag as well as --flag. */
function normalize(args: readonly string[]): string[] {
  return args.map(arg => /^-[a-z][a-z-]*(=.*)?$/.test(arg) ? '-' + arg : arg);
}

interface Parsed {
  values: Record<string, string | boolean | Array<string | boolean> | undefined>;
  positionals: string[];
}

function parse(args: readonly string[], options: ParseArgsConfig['options'], positionals = false): Parsed {
  try {
    return parseArgs({ args: normalize(args), options, strict: true, allowPositionals: positionals }) as Parsed;
  } catch (error) {
    return usage(`orm-gen: ${(error as Error).message}\n${usageText}`);
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function message(error: unknown): string {
  return (error as Error).message;
}

function source(path: string, dialect: string): Promise<SchemaManifest> {
  return loadSchemaSource(path, dialect);
}

/** Runs `run` with the database a DSN names and closes it. */
async function withDb<T>(dsn: string, run: (db: ToolDb) => Promise<T>): Promise<T> {
  const { db } = await openToolDb(dsn);
  try { return await run(db); } finally { await db.close(); }
}

function readPlan(path: string, label: string): MigrationPlanFile {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (error) { throw new ToolError(`MIGRATION_SOURCE: read ${label}: ${message(error)}`); }
  return parsePlan(text);
}

function driverMatches(plan: MigrationPlanFile, dsn: string): string {
  const driver = parseToolDsn(dsn).dialect;
  if (driver !== plan.driver) throw new ToolError(`MIGRATION_CONFIG: plan driver=${plan.driver} does not match the DSN driver=${driver}`);
  return driver;
}

function hasMeta(s: string): boolean { return /[*?[]/.test(s); }

function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) throw new ToolError('syntax error in pattern');
      const body = pattern.slice(i + 1, end);
      re += '[' + (body.startsWith('^') ? '^' + body.slice(1) : body).replaceAll('\\', '\\\\') + ']';
      i = end;
    } else if (c === '\\' && i + 1 < pattern.length) re += '\\' + pattern[++i];
    else re += c.replace(/[.+^${}()|]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Expands a file pattern; a name without wildcards must exist. */
function glob(pattern: string): string[] {
  if (!hasMeta(pattern)) {
    try { statSync(pattern); return [pattern]; } catch { return []; }
  }
  const dir = dirname(pattern);
  const dirs = hasMeta(dir) ? glob(dir) : [dir];
  const matcher = globToRegExp(basename(pattern));
  const out: string[] = [];
  for (const d of dirs) {
    let names: string[];
    try { names = readdirSync(d); } catch { continue; }
    for (const name of names.sort(byteOrder)) {
      if (matcher.test(name)) out.push(d === '.' && !pattern.startsWith('./') ? name : join(d, name));
    }
  }
  return out;
}

function gen(args: readonly string[]): number {
  const { values } = parse(args, { schema: { type: 'string' }, out: { type: 'string' }, scan: { type: 'string', multiple: true } });
  const schema = text(values.schema);
  const out = text(values.out);
  if (schema === '' || out === '') usage();
  const loaded = loadManifest(readFileSync(schema, 'utf8'));
  generateTypeScript(loaded, out, (values.scan as string[] | undefined) ?? []);
  console.error(`orm-gen: ${loaded.manifest.order.length} models (schema ${loaded.manifest.schema_hash}) → ${out}/models.ts`);
  return 0;
}

function build(args: readonly string[]): number {
  const { values, positionals } = parse(args, { out: { type: 'string' } }, true);
  const out = text(values.out);
  if (out === '' || positionals.length === 0) usage();
  const files: string[] = [];
  for (const a of positionals) {
    const matches = glob(a);
    if (matches.length === 0) throw new ToolError(`no such file: ${a}`);
    files.push(...matches);
  }
  files.sort(byteOrder);
  const diagrams: Diagram[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    try { diagrams.push(parseDiagram(src)); } catch (error) {
      if (!(error instanceof SchemaParseError)) throw error;
      console.error(`${f}:${error.message}`);
      return 1;
    }
  }
  const m = buildManifest(diagrams);
  for (const w of manifestWarnings(m)) console.error('warning:', w);
  writeFileSync(out, manifestText(m) + '\n');
  process.stdout.write(`orm-gen: ${(m.order ?? []).length} entities → ${out} (schema_hash ${m.schema_hash})\n`);
  return 0;
}

async function ddl(args: readonly string[]): Promise<number> {
  const { values } = parse(args, { schema: { type: 'string' }, dialect: { type: 'string', default: 'mysql' }, out: { type: 'string' } });
  const schema = text(values.schema);
  const out = text(values.out);
  const dialect = text(values.dialect);
  if (schema === '' || out === '') usage('usage: orm-gen ddl --schema schema/schema.json --dialect mysql|postgres|sqlite --out <file.sql>');
  const m = await source(schema, dialect);
  let sql: string;
  try { sql = renderDDL(loadedOf(m), dialect); } catch (error) { throw new ToolError(ddlErrorText(error)); }
  writeFileSync(out, sql);
  console.error(`orm-gen: ${(m.order ?? []).length} tables (${dialect}) → ${out}`);
  return 0;
}

async function diff(args: readonly string[]): Promise<number> {
  const { values } = parse(args, {
    from: { type: 'string' }, to: { type: 'string' }, dialect: { type: 'string', default: 'mysql' },
    out: { type: 'string' }, 'allow-destructive': { type: 'boolean', default: false },
  });
  const from = text(values.from);
  const to = text(values.to);
  const out = text(values.out);
  const dialect = text(values.dialect);
  if (from === '' || to === '' || out === '') {
    usage('usage: orm-gen diff --from old.json --to new.json --dialect mysql|postgres|sqlite --out <file.sql> [--allow-destructive]');
  }
  const fromManifest = await source(from, dialect);
  const toManifest = await source(to, dialect);
  await alignSourceChecks(from, to, fromManifest, toManifest);
  writeFileSync(out, renderDiff(fromManifest, toManifest, dialect, values['allow-destructive'] === true));
  return 0;
}

async function migrateCommand(args: readonly string[]): Promise<number> {
  const { values } = parse(args, {
    dsn: { type: 'string' }, schema: { type: 'string' },
    'migration-id': { type: 'string', default: 'initial' }, name: { type: 'string', default: 'schema sync' },
    'log-dir': { type: 'string', default: 'migrations/logs' }, 'dry-run': { type: 'boolean', default: false },
  });
  const dsn = text(values.dsn);
  const schema = text(values.schema);
  if (dsn === '' || schema === '') throw new ToolError('MIGRATION_CONFIG: --dsn and --schema are required');
  return withDb(dsn, async db => {
    let want: SchemaManifest;
    try { want = await source(schema, db.driver); } catch (error) { throw new ToolError(`MIGRATION_SOURCE: ${message(error)}`); }
    process.stdout.write(await migrate(db, want, {
      migrationId: text(values['migration-id']), name: text(values.name), logDir: text(values['log-dir']), dryRun: values['dry-run'] === true,
    }));
    return 0;
  });
}

async function planCommand(args: readonly string[]): Promise<number> {
  const { values } = parse(args, {
    from: { type: 'string' }, to: { type: 'string' }, dialect: { type: 'string', default: 'mysql' }, out: { type: 'string' },
    'migration-id': { type: 'string', default: '' }, name: { type: 'string', default: 'schema migration' },
  });
  const from = text(values.from);
  const to = text(values.to);
  const out = text(values.out);
  const dialect = text(values.dialect);
  if (from === '' || to === '' || out === '') throw new ToolError('MIGRATION_CONFIG: --from, --to and --out are required');
  const id = migrationPlanId(out, text(values['migration-id']));
  let fromManifest: SchemaManifest;
  try { fromManifest = await source(from, dialect); } catch (error) { throw new ToolError(`MIGRATION_SOURCE: from: ${message(error)}`); }
  let toManifest: SchemaManifest;
  try { toManifest = await source(to, dialect); } catch (error) { throw new ToolError(`MIGRATION_SOURCE: to: ${message(error)}`); }
  try { await alignSourceChecks(from, to, fromManifest, toManifest); } catch (error) { throw new ToolError(`MIGRATION_SOURCE: ${message(error)}`); }
  const plan = buildMigrationPlan(fromManifest, toManifest, dialect, id, text(values.name));
  try { writeFileSync(out, plan); } catch (error) { throw new ToolError(`MIGRATION_PLAN: write ${out}: ${message(error)}`); }
  return 0;
}

async function targetSchema(path: string, driver: string): Promise<SchemaManifest> {
  try { return await source(path, driver); } catch (error) { throw new ToolError(`MIGRATION_SOURCE: target schema: ${message(error)}`); }
}

async function applyCommand(args: readonly string[]): Promise<number> {
  const { values } = parse(args, {
    plan: { type: 'string' }, dsn: { type: 'string' }, schema: { type: 'string' },
    'log-dir': { type: 'string', default: 'migrations/logs' }, 'allow-destructive': { type: 'boolean', default: false },
  });
  const planPath = text(values.plan);
  const dsn = text(values.dsn);
  const schema = text(values.schema);
  if (planPath === '' || dsn === '' || schema === '') throw new ToolError('MIGRATION_CONFIG: --plan, --dsn and --schema are required');
  const plan = readPlan(planPath, 'plan');
  if (plan.version !== 1 || plan.migrationId === '' || plan.driver === '') throw new ToolError('MIGRATION_SOURCE: plan version, migration_id and driver are required');
  const driver = driverMatches(plan, dsn);
  validatePlanOperations('MIGRATION_PLAN', plan.operations, plan.checksum);
  if (plan.toSchema !== null || plan.rollbackOperations.length > 0 || plan.rollbackChecksum !== '') validateRollbackPlan(plan);
  for (const operation of plan.operations) {
    if (operation.destructive && values['allow-destructive'] !== true) throw new ToolError(`MIGRATION_PLAN: destructive operation requires --allow-destructive: ${operation.sql}`);
  }
  const want = await targetSchema(schema, driver);
  if (want.schema_hash !== plan.toHash) {
    throw new ToolError(`MIGRATION_PLAN: target manifest hash does not match plan expected_hash=${plan.toHash} actual_hash=${want.schema_hash}`);
  }
  return withDb(dsn, async db => {
    process.stdout.write(await applyPlan(db, plan, want, text(values['log-dir'])));
    return 0;
  });
}

async function recoverCommand(args: readonly string[]): Promise<number> {
  const { values } = parse(args, {
    plan: { type: 'string', default: '' }, 'migration-id': { type: 'string', default: '' }, dsn: { type: 'string' },
    schema: { type: 'string' }, 'log-dir': { type: 'string', default: 'migrations/logs' },
  });
  const planPath = text(values.plan);
  const id = text(values['migration-id']);
  const dsn = text(values.dsn);
  const schema = text(values.schema);
  if ((planPath === '') === (id === '') || dsn === '' || schema === '') {
    throw new ToolError('MIGRATION_CONFIG: exactly one of --plan or --migration-id, plus --dsn and --schema, is required');
  }
  const driver = parseToolDsn(dsn).dialect;
  let plan: MigrationPlanFile | undefined;
  if (planPath !== '') {
    plan = readPlan(planPath, 'plan');
    if (plan.version !== 1 || plan.migrationId === '' || plan.driver === '') throw new ToolError('MIGRATION_SOURCE: plan version, migration_id and driver are required');
    driverMatches(plan, dsn);
    if (checksumText(planSQL(plan.operations)) !== plan.checksum) throw new ToolError('MIGRATION_PLAN: plan checksum mismatch');
  }
  const want = await targetSchema(schema, driver);
  if (plan && want.schema_hash !== plan.toHash) {
    throw new ToolError(`MIGRATION_PLAN: target manifest hash does not match plan expected_hash=${plan.toHash} actual_hash=${want.schema_hash}`);
  }
  const logDir = text(values['log-dir']);
  return withDb(dsn, async db => {
    process.stdout.write(plan ? await recoverPlan(db, plan, want, logDir) : await recoverMigrationById(db, id, want, logDir));
    return 0;
  });
}

async function rollbackCommand(args: readonly string[]): Promise<number> {
  const { values } = parse(args, {
    plan: { type: 'string' }, dsn: { type: 'string' },
    'log-dir': { type: 'string', default: 'migrations/logs' }, 'allow-destructive': { type: 'boolean', default: false },
  });
  const planPath = text(values.plan);
  const dsn = text(values.dsn);
  if (planPath === '' || dsn === '') throw new ToolError('MIGRATION_CONFIG: --plan and --dsn are required');
  const plan = readPlan(planPath, 'rollback plan');
  validateRollbackPlan(plan);
  driverMatches(plan, dsn);
  if (plan.rollbackDataLossRisk && values['allow-destructive'] !== true) {
    throw new ToolError(`MIGRATION_ROLLBACK_DESTRUCTIVE: migration_id=${plan.migrationId} requires --allow-destructive; schema rollback does not restore removed or overwritten data`);
  }
  return withDb(dsn, async db => {
    process.stdout.write(await rollbackPlan(db, plan, text(values['log-dir'])));
    return 0;
  });
}

async function verifyCommand(args: readonly string[]): Promise<number> {
  const { values } = parse(args, { dsn: { type: 'string' }, schema: { type: 'string' } });
  const dsn = text(values.dsn);
  const schema = text(values.schema);
  if (dsn === '' || schema === '') throw new ToolError('MIGRATION_CONFIG: --dsn and --schema are required');
  return withDb(dsn, async db => {
    let want: SchemaManifest;
    try { want = await source(schema, db.driver); } catch (error) { throw new ToolError(`MIGRATION_SOURCE: ${message(error)}`); }
    process.stdout.write(await verifySchema(db, want));
    return 0;
  });
}

async function validate(args: readonly string[]): Promise<number> {
  const { values } = parse(args, { dsn: { type: 'string' }, schema: { type: 'string' } });
  const dsn = text(values.dsn);
  const schema = text(values.schema);
  if (dsn === '' || schema === '') usage('usage: orm-gen validate --dsn <dsn> --schema schema/schema.json');
  return withDb(dsn, async db => {
    const want = await source(schema, db.driver);
    const tables = filterManagedTables(await readTables(db));
    let diagram: Diagram;
    try { diagram = parseDiagram(renderMermaid(tables)); } catch (error) { throw new ToolError(`live schema does not parse: ${message(error)}`); }
    let lm: SchemaManifest;
    try { lm = buildManifest([diagram]); } catch (error) { throw new ToolError(`live schema does not build: ${message(error)}`); }
    const diffs = diffManifests(want, lm);
    for (const d of diffs) process.stdout.write(d + '\n');
    if (diffs.length > 0) {
      console.error(`orm-gen: ${diffs.length} differences between ${schema} and the live database`);
      return 1;
    }
    console.error(`orm-gen: ${schema} matches the live database (${(want.order ?? []).length} entities)`);
    return 0;
  });
}

/** What the clients would get wrong against the live manifest. */
function diffManifests(want: SchemaManifest, live: SchemaManifest): string[] {
  const out: string[] = [];
  for (const name of want.order ?? []) {
    const we = want.entities![name]!;
    const le = live.entities !== null && Object.hasOwn(live.entities, name) ? live.entities[name] : undefined;
    if (!le) { out.push(`${we.table}: table missing in the database`); continue; }
    const liveCols = new Map((le.columns ?? []).map(c => [c.name, c]));
    for (const wc of we.columns ?? []) {
      const lc = liveCols.get(wc.name);
      if (!lc) { out.push(`${we.table}.${wc.name}: column missing in the database`); continue; }
      if (wc.type !== lc.type) out.push(`${we.table}.${wc.name}: type ${wc.type} in manifest, ${lc.type} in the database`);
      if (Boolean(wc.nullable) !== Boolean(lc.nullable)) out.push(`${we.table}.${wc.name}: nullable ${Boolean(wc.nullable)} in manifest, ${Boolean(lc.nullable)} in the database`);
      if (Boolean(wc.auto) !== Boolean(lc.auto)) out.push(`${we.table}.${wc.name}: auto_increment ${Boolean(wc.auto)} in manifest, ${Boolean(lc.auto)} in the database`);
      if ((wc.styles ?? []).join(',') !== (lc.styles ?? []).join(',')) {
        out.push(`${we.table}.${wc.name}: styles ${listText(wc.styles)} in manifest, ${listText(lc.styles)} in the database`);
      }
    }
    const wantCols = new Set((we.columns ?? []).map(c => c.name));
    for (const lc of le.columns ?? []) {
      if (!wantCols.has(lc.name)) out.push(`${we.table}.${lc.name}: column exists in the database but not in the manifest`);
    }
    if ((we.pk ?? []).join(',') !== (le.pk ?? []).join(',')) out.push(`${we.table}: primary key ${listText(we.pk)} in manifest, ${listText(le.pk)} in the database`);
  }
  return out;
}

async function importCommand(args: readonly string[]): Promise<number> {
  const { values } = parse(args, { dsn: { type: 'string' }, out: { type: 'string' }, tables: { type: 'string', default: '' } });
  const dsn = text(values.dsn);
  const out = text(values.out);
  if (dsn === '' || out === '') usage('usage: orm-gen import --dsn <dsn> --out schema/app.mmd [--tables a,b]');
  const tables = text(values.tables);
  const only = tables === '' ? undefined : new Set(tables.split(',').map(t => t.trim()));
  const { ts, diagram } = await withDb(dsn, async db => {
    const read = await readTables(db, only);
    let previous: string | undefined;
    try { previous = readFileSync(out, 'utf8'); } catch { previous = undefined; }
    let prev: Diagram | undefined;
    if (previous !== undefined) {
      try { prev = parseDiagram(previous); } catch (error) {
        throw new ToolError(`${out}: ${message(error)} (fix or remove it before importing over it)`);
      }
    }
    return { ts: read, diagram: await withTriggerDirectives(db, read, renderMermaid(read, prev)) };
  });
  writeFileSync(out, diagram);
  try { parseDiagram(diagram); } catch (error) { throw new ToolError(`imported diagram does not parse: ${message(error)}`); }
  console.error(`orm-gen: ${ts.length} tables → ${out}`);
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case 'gen': return gen(args);
    case 'build': return build(args);
    case 'ddl': return ddl(args);
    case 'diff': return diff(args);
    case 'migrate': return migrateCommand(args);
    case 'plan': return planCommand(args);
    case 'apply': return applyCommand(args);
    case 'recover': return recoverCommand(args);
    case 'rollback': return rollbackCommand(args);
    case 'verify': return verifyCommand(args);
    case 'validate': return validate(args);
    case 'import': return importCommand(args);
    default: return usage();
  }
}

main(process.argv.slice(2)).then(
  code => { process.exitCode = code; },
  error => {
    if (error instanceof UsageError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    console.error(`orm-gen: ${message(error)}`);
    process.exitCode = 1;
  },
);
