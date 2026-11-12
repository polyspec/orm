// The dbspec.introspect op (docs/spec/feature-coverage.md FCV-4, DIA-133, DIA-198) of the recipe runner.
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { dbspecManifest, emitDbspec, introspectDbspec, parseDbspec, parsePlan, planSteps, readDbspecFile, renderDbspec } from '../dist/dbspec/index.js';
import { readPlanCases } from '../../../../tests/dbspec/vectors.mts';
import { nativeSession } from './coverage_case.mjs';

const CONNECTION_RULES = {
  mysql: ["SET time_zone = '+00:00'"],
  postgres: ['SET client_min_messages = warning', "SET TimeZone = 'UTC'"],
  sqlite: ['PRAGMA foreign_keys = ON'],
};

// counting wraps a native connection so that each catalog query of the introspection is counted: query on MySQL and
// PostgreSQL, prepare on SQLite.
function counting(database, connection) {
  const counter = { count: 0 };
  const method = database === 'sqlite' ? 'prepare' : 'query';
  const proxy = new Proxy(connection, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property !== method) return value.bind(target);
      return (...args) => {
        counter.count++;
        return value.apply(target, args);
      };
    },
  });
  return { proxy, counter };
}

// sourceOf is the documents of a step by name and its vector, which is empty for a step with paths.
function sourceOf(step, dir) {
  if (step.paths !== undefined) {
    const texts = {};
    for (const path of step.paths) {
      const read = readDbspecFile(resolve(dir, path));
      if (read.text === null) throw new Error(`${path}: ${JSON.stringify(read.diagnostics)}`);
      texts[basename(path, '.dbs')] = read.text;
    }
    return { texts, vector: {} };
  }
  const vectors = JSON.parse(readFileSync(resolve(dir, step.vectors), 'utf8'));
  const vector = vectors.cases.find(candidate => candidate.id === step.case);
  if (vector === undefined) throw new Error(`the vectors have no case ${step.case}`);
  const texts = {};
  for (const [name, lines] of Object.entries(vector.documents)) texts[name] = `${lines.join('\n')}\n`;
  return { texts, vector };
}

function parseSet(texts) {
  return Object.keys(texts).sort().map(name => {
    const others = { ...texts };
    delete others[name];
    const { document, diagnostics } = parseDbspec(texts[name], others);
    if (document === null) throw new Error(`${name}: ${JSON.stringify(diagnostics)}`);
    return document;
  });
}

const byteOrder = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

// schemaText is the schema text of one document that holds the tables of documents in name order.
function schemaText(documents) {
  const tables = documents.flatMap(document => document.tables).sort((a, b) => byteOrder(a.name, b.name));
  const { manifest, diagnostics } = dbspecManifest([{ name: 'introspected', uses: [], tables, diagrams: [], closingComments: [] }]);
  if (manifest === null || manifest === undefined) throw new Error(`the manifest is refused: ${JSON.stringify(diagnostics)}`);
  return manifest.schemaText;
}

// schemaName is what {schema} of a vector statement names on the case database.
function schemaName(database, dsn) {
  if (database === 'mysql') return decodeURIComponent(new URL(dsn).pathname.slice(1));
  return database === 'postgres' ? 'public' : 'main';
}

// catalogQueryFailure introspects the empty case database with the catalog queries of another dialect: their failure is the
// error of the call (DIA-133). The connection answers query as the driver of that dialect does, so that what fails is the SQL.
async function catalogQueryFailure(dialect, database, dsn) {
  const session = await nativeSession(database, dsn);
  try {
    const answering = { query: async statement => [await session.query(statement.sql ?? statement)] };
    const failure = await introspectDbspec(answering, dialect, dialect, 'introspected').then(() => null, error => error);
    if (failure === null) throw new Error(`the ${dialect} catalog queries did not fail on ${database}`);
    if (failure instanceof TypeError) throw failure;
    return { failed: true };
  } finally {
    await session.close();
  }
}

// The SQL dialect of a case database: a corpus runs SQL in SQLite's (DIA-185), and MariaDB in MySQL's (DIA-200).
const sqlDialect = database => ({ markdown: 'sqlite', mariadb: 'mysql' })[database] ?? database;

// The server of a case database that the public dbspec calls take (DIA-203): the markdown corpus answers in SQLite's dialect, as its
// server.
const serverOf = database => (database === 'markdown' ? 'sqlite' : database);

// refusable reports whether the expect of dbspec.introspect on the case database names refused, an integer: the expect of the
// database, else of its dialect, as the runner reads it (FCV-3).
function refusable(step, native, database) {
  const expect = step.expect ?? {};
  const outcome = expect[Object.hasOwn(expect, native) ? native : database];
  return outcome !== null && typeof outcome === 'object' && Number.isInteger(outcome.refused);
}

// introspectStep runs a dbspec.introspect step: on one native connection of the case database, the connection rules, the
// rendered documents and the statements of the vector, then the public introspectDbspec. A vector with a document compares
// the emitted document and the unsupported objects; any other requires none unsupported and the schema text of the source.
// Its result is the number of catalog queries, which the expect of the database compares (DIA-133, DIA-198). Where that expect
// names refused, a statement of the vector that the server refuses ends the step with the server's error number, which the expect
// compares; a refusal elsewhere, and of a statement other than the vector's, is an error (DIA-200, rule 4).
export async function introspectStep(step, context) {
  const { dsn, dir } = context;
  // A corpus runs SQL in SQLite's dialect (DIA-185): its native session is its flowmark server's, and its SQL is SQLite's;
  // MariaDB runs SQL in MySQL's (DIA-200).
  const native = context.database;
  const database = sqlDialect(native);
  if (step.catalog_of !== undefined) return catalogQueryFailure(step.catalog_of, native, dsn);
  const { texts, vector } = sourceOf(step, dir);
  const documents = parseSet(texts);
  const rendered = renderDbspec(documents, database);
  if (rendered.diagnostics.length > 0) throw new Error(`render: ${JSON.stringify(rendered.diagnostics)}`);
  // tests/dbspec/ddl.json holds the rendered statements of each dialect as an object; only a list runs.
  const extra = Array.isArray(vector.statements) ? vector.statements : [];
  const session = await nativeSession(native, dsn);
  let result;
  let counter;
  try {
    const schema = schemaName(database, dsn);
    const refuses = refusable(step, native, database);
    const statements = [...CONNECTION_RULES[database], ...rendered.statements, ...extra];
    for (const [i, sql] of statements.entries()) {
      const refused = await session.query(sql.replaceAll('{schema}', schema)).then(() => null, error => error);
      if (refused === null) continue;
      // A refusal is an error packet of a server of the MySQL protocol, which mysql2 gives with its SQLSTATE and error number;
      // the error decides it, not the name of the database, as in every runtime (DIA-200, rule 1).
      if (refuses && i >= statements.length - extra.length && typeof refused.sqlState === 'string' && Number.isInteger(refused.errno)) return { refused: refused.errno };
      throw refused;
    }
    if (refuses) throw new Error(`the statements of vector ${step.case} ran on ${native}, whose expect names their refusal`);
    const counted = counting(database, session.connection);
    counter = counted.counter;
    result = await introspectDbspec(counted.proxy, database, serverOf(native), 'introspected');
  } finally {
    await session.close();
  }
  const { document, unsupported } = result;
  // A vector may state the answer of MariaDB where the server itself answers otherwise, in place of its document and unsupported
  // objects (DIA-200, rule 4).
  if (native === 'mariadb' && vector.mariadb !== undefined) {
    vector.document = vector.mariadb.document;
    vector.unsupported = vector.mariadb.unsupported;
  }
  if (vector.document !== undefined) {
    const got = emitDbspec(document);
    if (got !== `${vector.document.join('\n')}\n`) throw new Error(`the introspected document differs:\n${got}`);
    const triples = JSON.stringify(unsupported.map(item => [item.kind, item.table, item.name]));
    const want = JSON.stringify(vector.unsupported.map(entry => entry.slice(0, 3)));
    if (triples !== want) throw new Error(`unsupported objects ${triples}, want ${want}`);
    for (const item of unsupported) {
      if (item.reason.length === 0) throw new Error(`the reason of ${item.kind} ${item.table} ${item.name} is empty`);
    }
    vector.unsupported.forEach((entry, index) => {
      if (entry.length === 4 && !unsupported[index].reason.includes(entry[3])) {
        throw new Error(`the reason of ${entry.slice(0, 3).join(' ')}: ${unsupported[index].reason}, want rule ${entry[3]}`);
      }
    });
  } else {
    if (unsupported.length > 0) throw new Error(`unsupported objects ${JSON.stringify(unsupported)}`);
    const got = schemaText([document]);
    const want = schemaText(documents);
    if (got !== want) throw new Error(`the schema text differs:\n${got}\nwant\n${want}`);
  }
  return { queries: counter.count };
}

// The number of tables and columns whose name begins with dbspec$ in the database.
const PLAN_HIDDEN_LEFT = {
  mysql: "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME LIKE 'dbspec$%' OR COLUMN_NAME LIKE 'dbspec$%')",
  postgres:
    "SELECT COUNT(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND (c.relname LIKE 'dbspec$%' OR a.attname LIKE 'dbspec$%')",
  sqlite: "SELECT COUNT(*) FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND (m.name LIKE 'dbspec$%' OR p.name LIKE 'dbspec$%')",
};

const documentText = lines => `${lines.join('\n')}\n`;

// planPhysicalStep runs a dbspec.plan_physical step on one native connection of the case database (PLN-102): the connection
// rules, the rendered source and the before steps; the plan steps before finalize, on SQLite with foreign keys off and no row
// of foreign_key_check, and the public introspectDbspec reads the target with nothing unsupported; without an irreversible
// step, the rollback statements return to the source and the steps run again; then the after steps and the finalize steps
// run, the target is read again and no table or column named dbspec$ remains.
export async function planPhysicalStep(step, context) {
  const { dsn, dir } = context;
  // A corpus runs SQL in SQLite's dialect (DIA-185): its native session is its flowmark server's, and its SQL is SQLite's;
  // MariaDB runs SQL in MySQL's (DIA-200).
  const native = context.database;
  const database = sqlDialect(native);
  const id = step.case;
  const vector = readPlanCases(resolve(dir, step.vectors)).find(candidate => candidate.id === id);
  if (vector === undefined) throw new Error(`the vectors have no case ${id}`);
  const parsed = parsePlan(documentText(vector.plan));
  if (parsed.diagnostics.length > 0) throw new Error(`the plan: ${JSON.stringify(parsed.diagnostics)}`);
  const target = dbspecManifest([parsed.plan.schema]).manifest.schemaText;
  let source = null;
  let setup = [];
  let sourceText = '';
  if (vector.source !== null) {
    const document = parseDbspec(documentText(vector.source), {});
    if (document.diagnostics.length > 0) throw new Error(`the source: ${JSON.stringify(document.diagnostics)}`);
    source = document.document;
    const rendered = renderDbspec([source], database);
    if (rendered.diagnostics.length > 0) throw new Error(`the render of the source: ${JSON.stringify(rendered.diagnostics)}`);
    setup = rendered.statements;
    sourceText = dbspecManifest([source]).manifest.schemaText;
  }
  const planned = planSteps(source, parsed.plan, database);
  if (planned.diagnostics.length > 0) throw new Error(`the plan steps: ${JSON.stringify(planned.diagnostics)}`);
  const steps = planned.steps;
  const reversible = steps.every(s => s.finalize || s.rollback !== '');
  const sqlite = database === 'sqlite';
  const session = await nativeSession(native, dsn);
  try {
    const value = async query => {
      const rows = await session.query(query);
      if (rows.length === 0) throw new Error(`${query}: no row`);
      const first = Object.values(rows[0])[0];
      if (first === null) throw new Error(`${query}: NULL value`);
      return String(first);
    };
    const behavior = async entries => {
      for (const entry of entries) {
        if (entry.dialects !== undefined && !entry.dialects.includes(database)) continue;
        if (entry.sql !== undefined) {
          const refused = await session.query(entry.sql).then(() => null, error => error);
          if (entry.fails && refused === null) throw new Error(`${entry.sql} must fail`);
          if (!entry.fails && refused !== null) throw new Error(`${entry.sql}: ${refused.message}`, { cause: refused });
          continue;
        }
        const got = await value(entry.query);
        if (got !== entry.want) throw new Error(`${entry.query}: got ${got}, want ${entry.want}`);
      }
    };
    const foreignKeys = async () => {
      if (!sqlite) return;
      const violations = await value('SELECT COUNT(*) FROM pragma_foreign_key_check');
      if (violations !== '0') throw new Error(`foreign_key_check returns ${violations} rows`);
    };
    const schemaIs = async (what, want) => {
      const { document, unsupported } = await introspectDbspec(session.connection, database, serverOf(native), 'introspected');
      if (unsupported.length > 0) throw new Error(`${what}: unsupported objects ${JSON.stringify(unsupported)}`);
      const got = document.tables.length > 0 ? dbspecManifest([document]).manifest.schemaText : '';
      if (got !== want) throw new Error(`${what}: the schema text differs\n--- want\n${want}--- got\n${got}`);
    };
    const forward = async restore => {
      for (const s of steps) {
        if (s.finalize) break;
        await session.query(restore && s.restore !== '' ? s.restore : s.statement);
      }
      await foreignKeys();
    };
    for (const sql of [...CONNECTION_RULES[database], ...setup]) await session.query(sql);
    await behavior(vector.before);
    // SQLite turns foreign keys off while it recreates a table, and checks them afterwards.
    if (sqlite) {
      await session.query('PRAGMA foreign_keys = OFF');
      await session.query('PRAGMA legacy_alter_table = OFF');
    }
    await forward(false);
    await schemaIs('applied', target);
    if (reversible) {
      // A rollback that goes all the way back recreates the old table with the added column hidden.
      for (const s of [...steps].reverse()) if (!s.finalize) await session.query(s.rollbackRestore !== '' ? s.rollbackRestore : s.rollback);
      await foreignKeys();
      await schemaIs('rolled back', sourceText);
      await forward(true);
      await schemaIs('applied again', target);
    }
    if (sqlite) await session.query('PRAGMA foreign_keys = ON');
    await behavior(vector.after);
    // Finalize also runs with SQLite foreign keys off, as apply does: hidden tables can reference each other.
    if (sqlite) await session.query('PRAGMA foreign_keys = OFF');
    for (const s of steps) if (s.finalize) await session.query(s.statement);
    await foreignKeys();
    if (sqlite) await session.query('PRAGMA foreign_keys = ON');
    await schemaIs('finalized', target);
    const hidden = await value(PLAN_HIDDEN_LEFT[database]);
    if (hidden !== '0') throw new Error(`${hidden} tables or columns named dbspec$ remain after finalize`);
  } finally {
    await session.close();
  }
  return {};
}
