// Schema tool parity test: every `orm-gen` schema command produces the same
// output as the Go `ormgen` for the shared Mermaid cases of
// tests/schema/cases.json, variants of them, and live databases.
//
// SQLite always runs. MySQL and PostgreSQL run when ORM_TOOLS_MYSQL_DSN and
// ORM_TOOLS_POSTGRES_DSN name empty scratch databases; the test drops every
// table in them, e.g.
//   ORM_TOOLS_MYSQL_DSN='mysql://root@localhost/orm_ts_tools?socket=/tmp/mysql.sock'
//   ORM_TOOLS_POSTGRES_DSN='postgres:///orm_ts_tools?host=/tmp'
//
// Usage: node tests/typescript/schema-tools.mjs (after npm run typescript:build; needs go)
import { execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { renderCreateDDL } from '../../clients/typescript/dist/engine/ddl.js';
import { parseDiagram } from '../../clients/typescript/dist/schema/mermaid.js';
import { buildManifest, loadSchemaManifest } from '../../clients/typescript/dist/schema/build.js';
import { alignLiveChecks } from '../../clients/typescript/dist/tools/checks.js';
import { openToolDb } from '../../clients/typescript/dist/tools/db.js';
import { loadedOf, renderDiff } from '../../clients/typescript/dist/tools/diff.js';
import { liveManifest } from '../../clients/typescript/dist/tools/introspect.js';
import { executeMigration, schemaMatches } from '../../clients/typescript/dist/tools/migrate.js';

const require = createRequire(new URL('../../clients/typescript/package.json', import.meta.url));
const root = new URL('../..', import.meta.url).pathname;
const tsBin = join(root, 'clients/typescript/dist/bin/orm-gen.js');
const work = await mkdtemp(join(tmpdir(), 'orm-ts-tools-'));
const goBin = join(work, 'ormgen');

let failures = 0;
let checks = 0;
function check(cond, message) {
  checks++;
  if (!cond) { failures++; console.error(`FAIL: ${message}`); }
}

function run(cmd, args, cwd = work) {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, GOWORK: 'off' } }, (error, stdout, stderr) => {
      resolve({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}
const goTool = (args, cwd) => run(goBin, args, cwd);
const tsTool = (args, cwd) => run(process.execPath, [tsBin, ...args], cwd);

/** The Go tool's output in the TypeScript tool's words. */
function normalize(text) {
  return text.replace(/^ormgen: /gm, 'orm-gen: ').replaceAll(' (5) (SQLITE_BUSY)', '');
}

function same(label, goResult, tsResult) {
  const detail = `${label}\n  go: ${goResult.status} ${JSON.stringify(normalize(goResult.stdout + goResult.stderr)).slice(0, 400)}\n  ts: ${tsResult.status} ${JSON.stringify(tsResult.stdout + tsResult.stderr).slice(0, 400)}`;
  check(goResult.status === tsResult.status && normalize(goResult.stdout) === tsResult.stdout && normalize(goResult.stderr) === tsResult.stderr, detail);
}

async function readOptional(path) {
  try { return await readFile(path, 'utf8'); } catch { return undefined; }
}

async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }));
}

// ---- sources ----

/** The Mermaid sources of the shared cases. */
async function sharedSources() {
  const file = JSON.parse(await readFile(join(root, 'tests/schema/cases.json'), 'utf8'));
  return file.cases.map(c => c.mmd);
}

/** Variants of a source that exercise the migration diff. */
function variants(src) {
  let d;
  try { d = parseDiagram(src); } catch { return []; }
  const entity = d.entities[0];
  if (!entity) return [];
  const lines = src.split('\n');
  const at = (index, ...inserted) => [...lines.slice(0, index), ...inserted, ...lines.slice(index)].join('\n');
  const replaced = (index, line) => lines.map((l, i) => i === index ? line : l).join('\n');
  const out = [
    at(entity.line, '    varchar(40) extra_note "?"'),
    at(entity.line, '    int extra_count'),
    at(entity.line, '    int extra_total "=0"'),
    `${src}\n  extra_table {\n    bigint seq PK "auto"\n    varchar(20) label\n  }\n`,
    `${src}\n  %% table_comment ${entity.name} "probe comment"\n`,
  ];
  const last = entity.columns[entity.columns.length - 1];
  if (last && !last.keys.includes('PK')) {
    const index = last.line - 1;
    out.push(lines.filter((_, i) => i !== index).join('\n'));
    out.push(replaced(index, lines[index].replace(last.type, last.type === 'text' ? 'varchar(64)' : 'text')));
    if (!lines[index].includes('"')) out.push(replaced(index, `${lines[index]} "?"`));
    else if (lines[index].includes('"?"')) out.push(replaced(index, lines[index].replace(' "?"', '')));
    out.push(`${replaced(index, lines[index].replace(` ${last.name}`, ` ${last.name}_renamed`))}\n  %% rename_column ${entity.name} ${last.name}_renamed ${last.name}\n`);
    out.push(`${src}\n  %% index ${entity.name} (${last.name}) ix_probe\n`);
    out.push(`${src}\n  %% column_comment ${entity.name} ${last.name} "probe column"\n`);
  }
  out.push(`${replaced(entity.line - 1, lines[entity.line - 1].replace(entity.name, `${entity.name}_renamed`))}\n  %% rename_table ${entity.name}_renamed ${entity.name}\n`);
  return out;
}

// ---- build, ddl, diff ----

async function buildParity(sources) {
  const built = [];
  await pool(sources, 8, async (src, i) => {
    const dir = join(work, `build-${i}`);
    for (const side of ['go', 'ts']) {
      await mkdir(join(dir, side), { recursive: true });
      await writeFile(join(dir, side, 's.mmd'), src);
    }
    const g = await goTool(['build', 's.mmd', '--out', 'schema.json'], join(dir, 'go'));
    const t = await tsTool(['build', 's.mmd', '--out', 'schema.json'], join(dir, 'ts'));
    same(`build #${i}\n${src}`, g, t);
    const gj = await readOptional(join(dir, 'go', 'schema.json'));
    const tj = await readOptional(join(dir, 'ts', 'schema.json'));
    check(gj === tj, `build #${i} schema.json differs`);
    if (g.status === 0 && gj !== undefined) built[i] = { src, dir, json: join(dir, 'go', 'schema.json'), text: gj };
  });
  return built.filter(Boolean);
}

async function ddlParity(built) {
  const jobs = built.flatMap(b => ['mysql', 'postgres', 'sqlite'].map(dialect => ({ b, dialect })));
  await pool(jobs, 8, async ({ b, dialect }) => {
    const g = await goTool(['ddl', '--schema', b.json, '--dialect', dialect, '--out', `ddl.${dialect}.sql`], join(b.dir, 'go'));
    const t = await tsTool(['ddl', '--schema', b.json, '--dialect', dialect, '--out', `ddl.${dialect}.sql`], join(b.dir, 'ts'));
    same(`ddl ${dialect} ${b.json}`, g, t);
    check(await readOptional(join(b.dir, 'go', `ddl.${dialect}.sql`)) === await readOptional(join(b.dir, 'ts', `ddl.${dialect}.sql`)), `ddl ${dialect} ${b.json} output differs`);
    if (g.status === 0) {
      // the generated SQL is itself a schema source
      const s = await tsTool(['ddl', '--schema', `ddl.${dialect}.sql`, '--dialect', dialect, '--out', `again.${dialect}.sql`], join(b.dir, 'ts'));
      check(s.status === 0 && await readOptional(join(b.dir, 'ts', `again.${dialect}.sql`)) === await readOptional(join(b.dir, 'ts', `ddl.${dialect}.sql`)), `ddl source round trip ${b.json}: ${s.stderr}`);
    }
  });
}

async function diffParity(pairs) {
  const jobs = pairs.flatMap(p => ['mysql', 'postgres', 'sqlite'].map(dialect => ({ ...p, dialect })));
  await pool(jobs, 12, async ({ from, to, dialect }, i) => {
    const fromManifest = loadSchemaManifest(from.text);
    const toManifest = loadSchemaManifest(to.text);
    for (const allow of [false, true]) {
      const out = join(work, `diff-${i}-${allow}.sql`);
      const g = await goTool(['diff', '--from', from.json, '--to', to.json, '--dialect', dialect, '--out', out, ...(allow ? ['--allow-destructive'] : [])]);
      let ts;
      try { ts = { ok: true, text: renderDiff(fromManifest, toManifest, dialect, allow) }; } catch (error) { ts = { ok: false, text: `orm-gen: ${error.message}\n` }; }
      const label = `diff ${dialect} allow=${allow} ${from.json} -> ${to.json}`;
      if (g.status === 0) check(ts.ok && ts.text === await readFile(out, 'utf8'), `${label}\n  ts: ${ts.text.slice(0, 600)}`);
      else check(!ts.ok && ts.text === normalize(g.stderr), `${label}\n  go: ${g.stderr}  ts: ${ts.text}`);
      if (g.status === 0 || !g.stderr.includes('--allow-destructive')) break;
    }
  });
}

// ---- live databases ----

async function resetDatabase(driver, dsn) {
  if (driver === 'sqlite') { await rm(new URL(dsn).pathname, { force: true }); return; }
  const url = new URL(dsn);
  if (driver === 'mysql') {
    const mysql = require('mysql2/promise');
    const conn = await mysql.createConnection({ user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), socketPath: url.searchParams.get('socket') ?? undefined, host: url.hostname, port: url.port ? Number(url.port) : undefined, database: url.pathname.slice(1) });
    const [rows] = await conn.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const row of rows) await conn.query(`DROP TABLE \`${row.TABLE_NAME}\``);
    await conn.end();
    return;
  }
  const { Client } = require('pg');
  const client = new Client({ connectionString: dsn });
  await client.connect();
  await client.query('SET client_min_messages = warning');
  const { rows } = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = current_schema()");
  for (const row of rows) await client.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
  await client.end();
}

async function liveParity(driver, dsn) {
  const dir = join(work, `live-${driver}`);
  await mkdir(join(dir, 'logs'), { recursive: true });
  await resetDatabase(driver, dsn);
  const bench = await readFile(join(root, 'schema/bench.mmd'), 'utf8');
  const a = `${bench}\n  %% table_comment battle "physical battle table"\n  %% column_comment battle name "physical battle name"\n`;
  const c = a.replace('varchar(191) name', 'int name');
  const probe = 'erDiagram\n  migration_probe {\n    bigint seq PK\n    varchar(32) name\n  }\n';
  const p1 = probe;
  const p2 = probe.replace('    varchar(32) name\n', '    text note "?"\n    varchar(32) name\n    int total "=0"\n') + '  %% index migration_probe (name) ix_name\n  %% table_comment migration_probe "probe"\n  %% column_comment migration_probe note "added note"\n';
  const p3 = p2.replace('varchar(32) name', 'varchar(64) name');
  for (const [name, src] of [['a', a], ['c', c], ['p1', p1], ['p2', p2], ['p3', p3]]) {
    await writeFile(join(dir, `${name}.mmd`), src);
    const built = await goTool(['build', `${name}.mmd`, '--out', `${name}.json`], dir);
    check(built.status === 0, `${driver} build ${name}: ${built.stderr}`);
  }
  const migrateArgs = (schema, id, extra = []) => ['migrate', '--dsn', dsn, '--schema', schema, '--migration-id', id, '--log-dir', 'logs', ...extra];
  const both = async (label, goArgs, tsArgs) => {
    const gr = await goTool(goArgs, dir);
    const tr = await tsTool(tsArgs, dir);
    same(`${driver} ${label}`, gr, tr);
    return tr;
  };

  await both('dry run on an empty database', migrateArgs('a.json', 'initial', ['--dry-run']), migrateArgs('a.json', 'initial', ['--dry-run']));
  await both('dry run from the Mermaid source', migrateArgs('a.mmd', 'initial', ['--dry-run']), migrateArgs('a.mmd', 'initial', ['--dry-run']));
  const applied = await tsTool(migrateArgs('a.json', 'initial'), dir);
  check(applied.status === 0 && /^migration_id=initial status=applied from_schema_hash= to_schema_hash=\w+ operations=\d+\n$/.test(applied.stdout), `${driver} apply: ${applied.stdout}${applied.stderr}`);
  await both('noop after apply', migrateArgs('a.json', 'initial'), migrateArgs('a.json', 'initial'));
  await both('history conflict', migrateArgs('c.json', 'initial'), migrateArgs('c.json', 'initial'));
  for (const dialect of [driver]) {
    const gr = await goTool(['diff', '--from', `db:${dsn}`, '--to', 'a.json', '--dialect', dialect, '--out', 'go-live.sql'], dir);
    const tr = await tsTool(['diff', '--from', `db:${dsn}`, '--to', 'a.json', '--dialect', dialect, '--out', 'ts-live.sql'], dir);
    same(`${driver} diff from the live database`, gr, tr);
    check(await readOptional(join(dir, 'go-live.sql')) === await readOptional(join(dir, 'ts-live.sql')), `${driver} live diff output differs`);
    await mkdir(join(dir, 'go'), { recursive: true });
    await mkdir(join(dir, 'ts'), { recursive: true });
    const gd = await goTool(['ddl', '--schema', `db:${dsn}`, '--dialect', dialect, '--out', 'live-ddl.sql'], join(dir, 'go'));
    const td = await tsTool(['ddl', '--schema', `db:${dsn}`, '--dialect', dialect, '--out', 'live-ddl.sql'], join(dir, 'ts'));
    same(`${driver} ddl of the live database`, gd, td);
    check(await readOptional(join(dir, 'go', 'live-ddl.sql')) === await readOptional(join(dir, 'ts', 'live-ddl.sql')), `${driver} live ddl output differs`);
  }
  {
    const sides = async (label, goArgs, tsArgs, file) => {
      const gr = await goTool(goArgs, join(dir, 'go'));
      const tr = await tsTool(tsArgs, join(dir, 'ts'));
      same(`${driver} ${label}`, gr, tr);
      check(await readOptional(join(dir, 'go', file)) === await readOptional(join(dir, 'ts', file)), `${driver} ${label}: ${file} differs`);
    };
    await sides('import', ['import', '--dsn', dsn, '--out', 'import.mmd'], ['import', '--dsn', dsn, '--out', 'import.mmd'], 'import.mmd');
    await writeFile(join(dir, 'go', 'prev.mmd'), a);
    await writeFile(join(dir, 'ts', 'prev.mmd'), a);
    await sides('import over a diagram', ['import', '--dsn', dsn, '--out', 'prev.mmd', '--tables', 'battle,user'], ['import', '--dsn', dsn, '--out', 'prev.mmd', '--tables', 'battle,user'], 'prev.mmd');
    await both('validate', ['validate', '--dsn', dsn, '--schema', 'a.json'], ['validate', '--dsn', dsn, '--schema', 'a.json']);
    await both('validate a changed schema', ['validate', '--dsn', dsn, '--schema', 'c.json'], ['validate', '--dsn', dsn, '--schema', 'c.json']);
  }
  await both('dry run of a changed column', migrateArgs('c.json', 'v2', ['--dry-run']), migrateArgs('c.json', 'v2', ['--dry-run']));

  // incremental migrations on a fresh database
  await resetDatabase(driver, dsn);
  const first = await tsTool(migrateArgs('p1.json', 'p1'), dir);
  check(first.status === 0 && first.stdout.includes('status=applied'), `${driver} apply p1: ${first.stdout}${first.stderr}`);
  await both('dry run of added columns', migrateArgs('p2.json', 'p2', ['--dry-run']), migrateArgs('p2.json', 'p2', ['--dry-run']));
  const second = await tsTool(migrateArgs('p2.mmd', 'p2'), dir);
  check(second.status === 0 && second.stdout.includes('status=applied'), `${driver} apply p2: ${second.stdout}${second.stderr}`);
  const goNoop = await goTool(migrateArgs('p2.json', 'p2'), dir);
  check(goNoop.status === 0 && goNoop.stdout.includes('status=noop'), `${driver} go reads the TypeScript migration history: ${goNoop.stdout}${goNoop.stderr}`);
  await both('dry run of a type change', migrateArgs('p3.json', 'p3', ['--dry-run']), migrateArgs('p3.json', 'p3', ['--dry-run']));
  const logs = await readdir(join(dir, 'logs'));
  // one log per run: the applied record replaces the queued one
  check(['initial', 'p1', 'p2'].every(id => logs.filter(name => name.endsWith(`__${id}.json`)).length === 1), `${driver} migration logs: ${logs.join(', ')}`);
  await resetDatabase(driver, dsn);
}

// ---- incremental migration of a live table ----

const liveDiffBase = `erDiagram
  live_article {
    bigint       seq         PK "auto"
    varchar(191) title
    text         body           "?"
    int          quantity       "=0"
    datetime(6)  created_ts     "=now"
    datetime(6)  updated_ts     "=now onupdate"
  }
  %% fulltext live_article (title, body)
  %% check live_article live_article_quantity : \`quantity\` >= 0 AND \`quantity\` IN (0, 1, 2, 5)
  %% column_comment live_article title "headline"
`;

// a new commented column declared in the middle of the table
const liveDiffTarget = liveDiffBase.replace('    text         body', '    varchar(32)  subtitle       "?"\n    text         body')
  + '  %% column_comment live_article subtitle "secondary headline"\n';

async function liveArticle(db, want) {
  const all = await liveManifest(db);
  const article = all.entities?.live_article;
  if (!article) throw new Error('live_article is missing from the database');
  const live = { schema_hash: all.schema_hash, order: ['live_article'], entities: { live_article: article } };
  await alignLiveChecks(db, live, want);
  return live;
}

/**
 * Creates a table with an automatic key, clock defaults, an update-time
 * column, a full-text index, a CHECK constraint, and comments; compares it
 * with its declaration; adds a commented column in the middle of the
 * declaration; and removes it again.
 */
async function liveCycle(driver, dsn) {
  await resetDatabase(driver, dsn);
  const base = buildManifest([parseDiagram(liveDiffBase)]);
  const target = buildManifest([parseDiagram(liveDiffTarget)]);
  const q = name => driver === 'mysql' ? `\`${name}\`` : `"${name}"`;
  const { db } = await openToolDb(dsn);
  try {
    await executeMigration(db, renderCreateDDL(loadedOf(base), driver));
    await db.exec(`INSERT INTO ${q('live_article')} (${q('title')}, ${q('quantity')}) VALUES ('kept', 2)`);
    let live = await liveArticle(db, base);
    check(schemaMatches(base, live, driver), `${driver} live cycle: created schema does not match`);
    let text = renderDiff(live, base, driver, false);
    check(text.includes('-- no changes'), `${driver} live cycle: unchanged table has a diff:\n${text}`);
    const forward = renderDiff(live, target, driver, false);
    check(!forward.includes('__orm_rebuild_'), `${driver} live cycle: adding a nullable column rebuilds the table:\n${forward}`);
    await executeMigration(db, forward);
    live = await liveArticle(db, target);
    check(schemaMatches(target, live, driver), `${driver} live cycle: added column does not verify`);
    text = renderDiff(live, target, driver, false);
    check(text.includes('-- no changes'), `${driver} live cycle: repeat after add column:\n${text}`);
    await executeMigration(db, renderDiff(live, base, driver, true));
    live = await liveArticle(db, base);
    check(schemaMatches(base, live, driver), `${driver} live cycle: removed column does not verify`);
    text = renderDiff(live, base, driver, false);
    check(text.includes('-- no changes'), `${driver} live cycle: repeat after remove column:\n${text}`);
    const rows = await db.query(`SELECT ${q('title')}, ${q('quantity')} FROM ${q('live_article')}`);
    check(rows.length === 1 && String(rows[0][0]) === 'kept' && Number(rows[0][1]) === 2, `${driver} live cycle: row ${JSON.stringify(rows)}`);
  } finally {
    await db.close();
  }
  await resetDatabase(driver, dsn);
}

// ---- reviewed plans: plan, apply, recover, rollback, verify ----

const lockName = "CONCAT('orm:', LEFT(SHA2(DATABASE(), 256), 60))";

/** Holds the database migration lock from another session until release() is called. */
async function holdMigrationLock(driver, dsn) {
  const url = new URL(dsn);
  if (driver === 'sqlite') {
    const other = new DatabaseSync(url.pathname);
    other.exec('BEGIN IMMEDIATE');
    return async () => { other.exec('ROLLBACK'); other.close(); };
  }
  if (driver === 'mysql') {
    const mysql = require('mysql2/promise');
    const conn = await mysql.createConnection({ user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), socketPath: url.searchParams.get('socket') ?? undefined, host: url.hostname, port: url.port ? Number(url.port) : undefined, database: url.pathname.slice(1) });
    const [rows] = await conn.query(`SELECT GET_LOCK(${lockName}, 0) AS acquired`);
    if (Number(rows[0].acquired) !== 1) throw new Error('test could not take the mysql migration lock');
    return async () => { await conn.query(`SELECT RELEASE_LOCK(${lockName})`); await conn.end(); };
  }
  const { Client } = require('pg');
  const client = new Client({ connectionString: dsn });
  await client.connect();
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext(current_database()), hashtext('polyspec.orm.migration'))");
  return async () => { await client.query('ROLLBACK'); await client.end(); };
}

/** The migration history rows without their times. */
async function historyRows(dsn) {
  const { db } = await openToolDb(dsn);
  try {
    const rows = await db.query('SELECT migration_id, name, from_schema_hash, to_schema_hash, plan_checksum, status, operations, error_detail FROM orm_schema_migrations ORDER BY migration_id');
    return normalize(JSON.stringify(rows.map(row => row.map(v => typeof v === 'number' ? v : String(v)))));
  } finally {
    await db.close();
  }
}

/** The migration log files without their times, in a stable order. */
async function logRecords(dir) {
  const names = await readdir(dir).catch(() => []);
  const records = [];
  for (const name of names) {
    const log = JSON.parse(await readFile(join(dir, name), 'utf8'));
    delete log.started_at;
    delete log.finished_at;
    records.push(normalize(JSON.stringify(log)));
  }
  return records.sort();
}

/**
 * Runs one plan sequence with a tool on a fresh database and returns what it
 * printed and left behind: the plan files, the history rows, and the logs.
 */
async function planSequence(driver, dsn, side, tool) {
  const dir = join(work, `plan-${driver}-${side}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'b1.mmd'), liveDiffBase);
  await writeFile(join(dir, 'b2.mmd'), liveDiffTarget);
  for (const name of ['b1', 'b2']) {
    const built = await goTool(['build', `${name}.mmd`, '--out', `${name}.json`], dir);
    check(built.status === 0, `${driver} plan build ${name}: ${built.stderr}`);
  }
  await resetDatabase(driver, dsn);
  const steps = [];
  const step = async (label, args, expect, statusOnly = false) => {
    const r = await tool(args, dir);
    steps.push(statusOnly ? { label, status: r.status, stdout: '', stderr: '' } : { label, status: r.status, stdout: normalize(r.stdout), stderr: normalize(r.stderr) });
    if (expect) check(expect.test(r.stdout + r.stderr), `${driver} ${side} ${label}: ${r.stdout}${r.stderr}`);
  };
  const logs = ['--log-dir', 'logs'];
  const planFile = '20260101-drop-subtitle.json';
  const apply = (...extra) => ['apply', '--plan', planFile, '--dsn', dsn, '--schema', 'b1.json', ...logs, ...extra];
  const recover = ['recover', '--plan', planFile, '--dsn', dsn, '--schema', 'b1.json', ...logs];
  const rollback = (...extra) => ['rollback', '--plan', planFile, '--dsn', dsn, ...logs, ...extra];
  const underLock = async (label, args, expect) => {
    const release = await holdMigrationLock(driver, dsn);
    try { await step(label, args, expect); } finally { await release(); }
  };

  await step('migrate the base', ['migrate', '--dsn', dsn, '--schema', 'b1.json', '--migration-id', 'live-1', ...logs], /status=applied/);
  await step('migrate the added column', ['migrate', '--dsn', dsn, '--schema', 'b2.mmd', '--migration-id', 'live-2', ...logs], /status=applied/);
  await step('verify the target', ['verify', '--dsn', dsn, '--schema', 'b2.json'], /status=verified/);
  await step('verify another schema', ['verify', '--dsn', dsn, '--schema', 'b1.json'], /MIGRATION_VERIFY_FAILED/);
  await step('plan with a bad file name', ['plan', '--from', 'b2.json', '--to', 'b1.json', '--dialect', driver, '--out', 'drop.json'], /MIGRATION_FILE_NAME/);
  await step('plan with an invalid date', ['plan', '--from', 'b2.json', '--to', 'b1.json', '--dialect', driver, '--out', '20260230-drop.json'], /MIGRATION_FILE_NAME/);
  await step('plan with another id', ['plan', '--from', 'b2.json', '--to', 'b1.json', '--dialect', driver, '--out', planFile, '--migration-id', 'other'], /MIGRATION_FILE_NAME/);
  // The plan comes from the live database; its CHECK text is aligned with
  // b1, so the embedded source schema must carry the matching hash.
  await step('plan from the live database', ['plan', '--from', `db:${dsn}`, '--to', 'b1.json', '--dialect', driver, '--out', planFile, '--name', 'drop subtitle']);
  await step('plan another id from the live database', ['plan', '--from', `db:${dsn}`, '--to', 'b1.json', '--dialect', driver, '--out', '20260101-live.json']);
  await step('apply without --allow-destructive', apply(), /requires --allow-destructive/);
  await step('apply to another schema', ['apply', '--plan', planFile, '--dsn', dsn, '--schema', 'b2.json', ...logs, '--allow-destructive'], /target manifest hash/);
  await step('recover a missing migration', recover, /MIGRATION_HISTORY_MISSING/);
  await underLock('apply while the lock is held', apply('--allow-destructive'), /MIGRATION_/);
  await step('apply after the failure', apply('--allow-destructive'));
  await step('recover', recover);
  await step('recover again', recover);
  await step('apply', apply('--allow-destructive'), /status=(applied|noop)/);
  await step('apply again', apply('--allow-destructive'), /status=noop/);
  await step('verify the plan target', ['verify', '--dsn', dsn, '--schema', 'b1.json'], /status=verified/);
  await underLock('recover while the lock is held', recover, /MIGRATION_LOCK_BUSY/);
  await step('rollback without --allow-destructive', rollback(), /MIGRATION_ROLLBACK_DESTRUCTIVE/);
  await step('rollback', rollback('--allow-destructive'), /status=rolled_back/);
  await step('rollback again', rollback('--allow-destructive'), /status=noop/);
  await step('verify the rollback', ['verify', '--dsn', dsn, '--schema', 'b2.json'], /status=verified/);
  await step('apply after the rollback', apply('--allow-destructive'), /status=applied/);
  await step('recover by id at another schema', ['recover', '--migration-id', 'live-2', '--dsn', dsn, '--schema', 'b1.json', ...logs], /MIGRATION_HISTORY_CONFLICT/);
  await step('recover by id', ['recover', '--migration-id', 'live-2', '--dsn', dsn, '--schema', 'b2.json', ...logs], /MIGRATION_/);
  await step('migrate while a plan is recorded', ['migrate', '--dsn', dsn, '--schema', 'b1.json', '--migration-id', 'live-2', ...logs], /MIGRATION_/);
  await step('recover with a changed plan', ['recover', '--plan', '20260101-live.json', '--dsn', dsn, '--schema', 'b1.json', ...logs]);
  await step('migrate with a sqlite path', ['migrate', '--dsn', '/tmp/orm.sqlite', '--schema', 'b1.json'], /MIGRATION_CONFIG/);
  // the flag is gone; each tool prints its own usage
  await step('migrate with --driver', ['migrate', '--driver', driver, '--dsn', dsn, '--schema', 'b1.json'], undefined, true);
  await step('db source of another dialect', ['diff', '--from', `db:${dsn}`, '--to', 'b1.json', '--dialect', driver === 'mysql' ? 'postgres' : 'mysql', '--out', 'other.sql'], /MIGRATION_CONFIG/);
  const files = {};
  for (const name of [planFile, '20260101-live.json']) files[name] = await readOptional(join(dir, name));
  const result = { steps, files, history: await historyRows(dsn), logs: await logRecords(join(dir, 'logs')) };
  await resetDatabase(driver, dsn);
  return result;
}

async function planParity(driver, dsn) {
  const go = await planSequence(driver, dsn, 'go', goTool);
  const ts = await planSequence(driver, dsn, 'ts', tsTool);
  go.steps.forEach((g, i) => {
    const t = ts.steps[i];
    check(g.status === t.status && g.stdout === t.stdout && g.stderr === t.stderr, `${driver} plan sequence: ${g.label}\n  go: ${g.status} ${JSON.stringify(g.stdout + g.stderr).slice(0, 600)}\n  ts: ${t.status} ${JSON.stringify(t.stdout + t.stderr).slice(0, 600)}`);
  });
  for (const name of Object.keys(go.files)) check(go.files[name] === ts.files[name], `${driver} plan file ${name} differs`);
  check(go.files['20260101-drop-subtitle.json'] !== undefined, `${driver} plan file was not written`);
  check(go.history === ts.history, `${driver} migration history differs\n  go: ${go.history}\n  ts: ${ts.history}`);
  check(JSON.stringify(go.logs) === JSON.stringify(ts.logs), `${driver} migration logs differ\n  go: ${go.logs.join('\n      ')}\n  ts: ${ts.logs.join('\n      ')}`);
}

try {
  const built = spawnSync('go', ['build', '-o', goBin, './cmd/ormgen'], { cwd: root, encoding: 'utf8', env: { ...process.env, GOWORK: 'off' } });
  if (built.status !== 0) throw new Error(`go build ./cmd/ormgen: ${built.stderr}`);
  const bench = await readFile(join(root, 'schema/bench.mmd'), 'utf8');
  const base = [...new Set([bench, ...await sharedSources()])];
  const groups = base.map(src => ({ src, variants: variants(src).filter(v => !base.includes(v)) }));
  const sources = [...new Set([...base, ...groups.flatMap(g => g.variants)])];
  const manifests = await buildParity(sources);
  console.log(`build: ${sources.length} sources, ${manifests.length} manifests`);
  await ddlParity(manifests);
  console.log('ddl: done');
  const bySource = new Map(manifests.map(m => [m.src, m]));
  const pairs = [];
  const bases = base.map(src => bySource.get(src)).filter(Boolean);
  for (let i = 0; i + 1 < bases.length; i++) pairs.push({ from: bases[i], to: bases[i + 1] });
  for (const g of groups) {
    const from = bySource.get(g.src);
    if (!from) continue;
    for (const v of g.variants) {
      const to = bySource.get(v);
      if (to) pairs.push({ from, to }, { from: to, to: from });
    }
  }
  console.log(`diff: ${pairs.length} pairs`);
  await diffParity(pairs);
  const targets = [['sqlite', `sqlite://${join(work, 'live.sqlite')}`]];
  if (process.env.ORM_TOOLS_MYSQL_DSN) targets.push(['mysql', process.env.ORM_TOOLS_MYSQL_DSN]);
  if (process.env.ORM_TOOLS_POSTGRES_DSN) targets.push(['postgres', process.env.ORM_TOOLS_POSTGRES_DSN]);
  for (const [driver, dsn] of targets) {
    await liveParity(driver, dsn);
    await liveCycle(driver, dsn);
    await planParity(driver, dsn);
    console.log(`live ${driver}: done`);
  }
} catch (error) {
  failures++;
  console.error('FAIL:', error);
} finally {
  await rm(work, { recursive: true, force: true });
}
if (failures > 0) {
  console.error(`typescript schema tool test: ${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`typescript schema tool test passed (${checks} checks)`);
