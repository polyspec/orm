// The ops of the dbspec apply API (docs/spec/feature-coverage.md FCV-4): each command is one call of the public API on a named
// connection, and steps nested in its on field run inside the event handler.
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { DbspecApplyError, applyPlans, dbspecManifest, finalizePlans, introspectDbspec, parsePlan, recoverPlans, rollbackPlans } from '../dist/dbspec/index.js';
import { relatedDsn, withCaseDatabase } from './case-database.mjs';
import { mysqlTestOptions } from './mysql-test-options.mjs';

// The fixed clock of the commands in microseconds, 2023-11-14T22:13:20Z.
const NOW = () => 1_700_000_000_000_000;
// The statements that a client runs on a new direct connection.
const CONNECTION_RULES = { mysql: ["SET time_zone = '+00:00'"], postgres: ["SET TimeZone = 'UTC'"], sqlite: ['PRAGMA foreign_keys = ON'] };
const SERVER_ENV = { mysql: 'ORM_TEST_MYSQL_SERVER_DSN', postgres: 'ORM_TEST_POSTGRES_SERVER_DSN' };
const COMMANDS = { 'dbspec.apply': applyPlans, 'dbspec.recover': recoverPlans, 'dbspec.rollback': rollbackPlans, 'dbspec.finalize': finalizePlans };
// What an on with stop throws from the event handler, so the code of the command is stopped.
const STOP = new Error('the recipe stops the command');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; run make orm-test-servers, which starts the databases and writes it`);
  return value;
}

/** A driver connection with the form of statement each driver has: run returns the rows as arrays, close ends it. */
async function open(database, target) {
  if (database === 'sqlite') {
    const db = new DatabaseSync(target.path);
    return {
      connection: db,
      close: async () => db.close(),
      run: async text => {
        const statement = db.prepare(text);
        statement.setReturnArrays(true);
        return statement.all();
      },
    };
  }
  const dsn = relatedDsn(required(SERVER_ENV[database]), target.name);
  if (database === 'mysql') {
    const connection = await mysql.createConnection(mysqlTestOptions(dsn, target.name));
    return {
      connection,
      close: () => connection.end(),
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
  return {
    connection: client,
    close: () => client.end(),
    run: async text => (await client.query({ text, rowMode: 'array' })).rows ?? [],
  };
}

/** Opens a session on the target, runs the rules of a direct connection and closes it with the case. */
async function direct(context, target) {
  const session = await open(context.database, target);
  for (const rule of CONNECTION_RULES[context.database]) await session.run(rule);
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
  try {
    await COMMANDS[s.op](session.connection, context.database, plans, NOW, handler);
  } catch (error) {
    const failure = error instanceof AggregateError ? error.errors[0] : error;
    if (failure === STOP) code = 'stopped';
    else if (failure instanceof DbspecApplyError) code = failure.code;
    else if (s.message !== undefined && failure.message === s.message) code = 'message';
    else throw error;
    if (s.detail !== undefined && !failure.message.toLowerCase().includes(s.detail.toLowerCase())) {
      throw new Error(`the message ${JSON.stringify(failure.message)} does not hold ${JSON.stringify(s.detail)}`, { cause: error });
    }
  }
  const elapsed = Date.now() - started;
  if (s.elapsed !== undefined && (elapsed < s.elapsed.at_least_ms || elapsed >= s.elapsed.below_ms)) {
    throw new Error(`the command took ${elapsed} ms, want at least ${s.elapsed.at_least_ms} and below ${s.elapsed.below_ms}`);
  }
  const members = [['code', { text: code }]];
  if (s.count === undefined) members.push(['events', { int: String(events) }]);
  for (const kind of s.count ?? []) members.push([kind, { int: String(kinds.get(kind) ?? 0) }]);
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
      const target = { name: context.caseName, path: context.casePath };
      let session;
      if (s.through === 'pooler') session = await openPostgres(relatedDsn(required('ORM_TEST_PGBOUNCER_DSN'), target.name));
      else session = await direct(context, target);
      context.closers.push(() => session.close());
      return { bind: session };
    },
    'dbspec.exec': async (s, context) => {
      const text = sql(s.sql, context).replaceAll('{step}', String(context.applyStep ?? 0));
      const rows = await sessionOf(s, context).run(text);
      return { value: { array: rows.map(row => ({ array: Array.from(row, cell) })) } };
    },
    'dbspec.schema': async (s, context) => {
      const { document, unsupported } = await introspectDbspec(sessionOf(s, context).connection, context.database, 'x');
      if (unsupported.length > 0) throw new Error(`dbspec.schema: unsupported ${JSON.stringify(unsupported)}`);
      return { value: { text: document.tables.length > 0 ? dbspecManifest([document]).manifest.schemaText : '' } };
    },
    'dbspec.other_database': (s, context) => withCaseDatabase(context.database, context.step, async other => {
      const session = await direct(context, { name: other.name, path: other.path });
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
