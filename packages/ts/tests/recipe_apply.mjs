// The ops of the dbspec apply API (docs/spec/feature-coverage.md FCV-4): each command is one call of the public API on a named
// connection, and steps nested in its on field run inside the event handler.
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { DbspecApplyError, applyPlans, dbspecManifest, finalizePlans, introspectDbspec, parsePlan, recoverPlans, rollbackPlans } from '../dist/dbspec/index.js';
import { relatedDsn, withCaseDatabase } from './case-database.mjs';
import { mysqlTestOptions } from './mysql-test-options.mjs';
import { markdownSqlite } from './markdown_sqlite.mjs';
import { checkMessageHolds } from './recipe.mjs';

// The fixed clock of the commands in microseconds, 2023-11-14T22:13:20Z.
const NOW = () => 1_700_000_000_000_000;
// The statements that a client runs on a new direct connection.
const CONNECTION_RULES = { mysql: ["SET time_zone = '+00:00'"], postgres: ["SET TimeZone = 'UTC'"], sqlite: ['PRAGMA foreign_keys = ON'] };
// The direct server of each database: MariaDB, a server of the MySQL dialect, is a server of its own (DIA-200, FCV-3).
const SERVER_ENV = { mysql: 'ORM_TEST_MYSQL_SERVER_DSN', mariadb: 'ORM_TEST_MARIADB_SERVER_DSN', postgres: 'ORM_TEST_POSTGRES_SERVER_DSN' };
const COMMANDS = { 'dbspec.apply': applyPlans, 'dbspec.recover': recoverPlans, 'dbspec.rollback': rollbackPlans, 'dbspec.finalize': finalizePlans };
// What an on with stop throws from the event handler, so the code of the command is stopped.
const STOP = new Error('the recipe stops the command');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; run make orm-test-servers, which starts the databases and writes it`);
  return value;
}

/** The SQL dialect of a case database: a corpus runs SQL in SQLite's (DIA-185), MariaDB in MySQL's (DIA-200). */
const dialectOf = database => ({ markdown: 'sqlite', mariadb: 'mysql' })[database] ?? database;
// The server of a case database that the public dbspec calls take (DIA-203): the markdown corpus answers in SQLite's dialect, as its
// server.
const serverOf = database => (database === 'markdown' ? 'sqlite' : database);

/** f called at most once: each later call returns the result of the first. */
function once(f) {
  let result;
  let called = false;
  return () => {
    if (!called) {
      called = true;
      result = f();
    }
    return result;
  };
}

/**
 * A driver connection with the form of statement each driver has: run returns the rows as arrays, close ends it after its
 * statement, and destroy ends it at once, so that a statement that a step guard ended does not hold the case's cleanup.
 */
async function open(database, target) {
  if (database === 'markdown') {
    // A corpus is reached through one session of its flowmark server, which answers SQLite's statements (DIA-185).
    const corpus = await markdownSqlite(target.dsn);
    // A statement of the corpus session runs synchronously, so no statement is running when destroy is called.
    const close = once(() => corpus.close());
    return {
      connection: corpus,
      close,
      destroy: close,
      run: async text => {
        const statement = corpus.prepare(text);
        statement.setReturnArrays(true);
        return statement.all();
      },
    };
  }
  if (database === 'sqlite') {
    const db = new DatabaseSync(target.path);
    // node:sqlite runs a statement synchronously, so no statement is running when destroy is called.
    const close = once(async () => db.close());
    return {
      connection: db,
      close,
      destroy: close,
      run: async text => {
        const statement = db.prepare(text);
        statement.setReturnArrays(true);
        return statement.all();
      },
    };
  }
  const dsn = relatedDsn(required(SERVER_ENV[database]), target.name);
  if (dialectOf(database) === 'mysql') {
    const connection = await mysql.createConnection(mysqlTestOptions(dsn, target.name));
    let destroyed = false;
    return {
      connection,
      // end waits for the running statement; a destroyed connection has nothing to end.
      close: async () => {
        if (!destroyed) await connection.end();
      },
      destroy: () => {
        destroyed = true;
        connection.destroy();
      },
      run: async text => {
        const [rows] = await connection.query({ sql: text, rowsAsArray: true });
        return Array.isArray(rows) ? rows : [];
      },
    };
  }
  return openPostgres(dsn);
}

async function openPostgres(dsn) {
  const client = new pg.Client({ connectionString: dsn });
  await client.connect();
  // end disconnects at once when a statement is running (node-postgres), so destroy is end; the client is ended once.
  const end = once(() => client.end());
  return {
    connection: client,
    close: end,
    destroy: end,
    run: async text => (await client.query({ text, rowMode: 'array' })).rows ?? [],
  };
}

/** Opens a session on the target, runs the rules of a direct connection and closes it with the case. */
async function direct(context, target) {
  const session = await open(context.database, target);
  for (const rule of CONNECTION_RULES[dialectOf(context.database)]) await session.run(rule);
  return session;
}

function sessionOf(s, context) {
  const session = context.bound.get(s.connection);
  if (session?.run === undefined) throw new Error(`connection ${s.connection} is not bound`);
  return session;
}

const cell = value => (value === null ? { null: true } : { text: value instanceof Uint8Array ? Buffer.from(value).toString() : String(value) });

/** Makes one call of the command; its value is the code of its failure, or ok, and the events that count names. */
async function command(s, context, runStep) {
  const session = sessionOf(s, context);
  const plans = s.plans.map(name => {
    const plan = context.bound.get(name);
    if (plan === undefined) throw new Error(`plan ${name} is not bound`);
    return plan;
  });
  const kinds = new Map();
  let events = 0;
  let ran = false;
  const handler = async event => {
    context.guard?.progress();
    events++;
    kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1);
    const on = s.on;
    if (on === undefined || on.event !== event.kind || (ran && on.every !== true)) return;
    if ((on.plan !== undefined && on.plan !== event.plan) || (on.step !== undefined && on.step !== event.step)) return;
    ran = true;
    context.applyStep = event.step;
    for (const nested of on.steps ?? []) await runStep(nested, context);
    if (on.stop === true) throw STOP;
  };
  const started = Date.now();
  let code = 'ok';
  let message;
  try {
    await COMMANDS[s.op](session.connection, dialectOf(context.database), serverOf(context.database), plans, NOW, handler);
  } catch (error) {
    const failure = error instanceof AggregateError ? error.errors[0] : error;
    message = failure.message;
    if (failure === STOP) code = 'stopped';
    else if (failure instanceof DbspecApplyError) code = failure.code;
    else if (s.message !== undefined && failure.message === s.message) code = 'message';
    else throw error;
    if (s.detail !== undefined && !failure.message.toLowerCase().includes(s.detail.toLowerCase())) {
      throw new Error(`the message ${JSON.stringify(failure.message)} does not hold ${JSON.stringify(s.detail)}`, { cause: error });
    }
    checkMessageHolds(failure.message, s.message_holds);
  }
  const elapsed = Date.now() - started;
  if (s.elapsed !== undefined && (elapsed < s.elapsed.at_least_ms || elapsed >= s.elapsed.below_ms)) {
    throw new Error(`the command took ${elapsed} ms, want at least ${s.elapsed.at_least_ms} and below ${s.elapsed.below_ms}`);
  }
  const members = [['code', { text: code }]];
  if (s.count === undefined) members.push(['events', { int: String(events) }]);
  for (const kind of s.count ?? []) members.push([kind, { int: String(kinds.get(kind) ?? 0) }]);
  if (s.with_message === true && message !== undefined) members.push(['message', { text: message }]);
  return { value: { object: members } };
}

/** The ops of the apply API; sql and runStep are those of the recipe helper. */
export function applyOps({ sql, runStep }) {
  const ops = {
    'dbspec.plan': s => {
      const { plan, diagnostics } = parsePlan(`${s.lines.join('\n')}\n`);
      if (plan === null || plan === undefined) throw new Error(`dbspec.plan ${s.as}: ${JSON.stringify(diagnostics)}`);
      return { bind: plan };
    },
    'dbspec.connect': async (s, context) => {
      const target = { name: context.caseName, path: context.casePath, dsn: context.dsn };
      let session;
      if (s.through === 'pooler') session = await openPostgres(relatedDsn(required('ORM_TEST_PGBOUNCER_DSN'), target.name));
      else session = await direct(context, target);
      context.closers.push(() => session.close());
      // A step guard that ends the case ends its sessions at once, which ends the statement that it waited for (FCV-4).
      context.guard?.ended.then(() => session.destroy());
      return { bind: session };
    },
    'dbspec.exec': async (s, context) => {
      const text = sql(s.sql, context).replaceAll('{step}', String(context.applyStep ?? 0));
      const rows = await sessionOf(s, context).run(text);
      return { value: { array: rows.map(row => ({ array: Array.from(row, cell) })) } };
    },
    'dbspec.schema': async (s, context) => {
      const { document, unsupported } = await introspectDbspec(sessionOf(s, context).connection, dialectOf(context.database), serverOf(context.database), 'x');
      if (unsupported.length > 0) throw new Error(`dbspec.schema: unsupported ${JSON.stringify(unsupported)}`);
      return { value: { text: document.tables.length > 0 ? dbspecManifest([document]).manifest.schemaText : '' } };
    },
    'dbspec.other_database': (s, context) => withCaseDatabase(context.database, context.step, async other => {
      const session = await direct(context, { name: other.name, path: other.path, dsn: other.dsn });
      context.guard?.ended.then(() => session.destroy());
      try {
        context.bound.set(s.as, session);
        for (const nested of s.steps) await runStep(nested, context);
      } finally {
        await session.close();
      }
      return {};
    }),
  };
  for (const op of Object.keys(COMMANDS)) ops[op] = (s, context) => command(s, context, runStep);
  return ops;
}
