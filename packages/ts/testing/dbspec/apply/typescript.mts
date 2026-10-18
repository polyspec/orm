// The chain of plans.json (tests/dbspec/plans.json) (create-from-empty and
// rename-table-and-column) is applied to one database with the TypeScript client
// (docs/plans.md "Apply"). The action is apply-first (first plan only), apply (the whole chain),
// stop (stops after statement 1 of the second plan runs), recover (finishes an interrupted plan),
// or rollback (reverts the last plan in history). One of these. stdout gets one result line: "ok", "stopped", or
// "error <code>". Any other error is written to stderr and the process exits with 1.
//
// Usage: node packages/ts/testing/dbspec/apply/typescript.mts <apply-first|apply|stop|recover|rollback> <mysql|postgres|sqlite> <uri> <plans.json>
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { DbspecApplyError, applyPlans, parsePlan, recoverPlans, rollbackPlans, type DbspecApplyHandler, type DbspecPlan } from '../../../dist/dbspec/index.js';
import { readVectors } from '../../../../../tests/dbspec/vectors.mts';

// The statements that every client runs on a new connection (packages/go/internal/dialects connectionRules).
const CONNECTION_RULES = {
  mysql: ["SET time_zone = '+00:00'"],
  postgres: ["SET TimeZone = 'UTC'"],
  sqlite: ['PRAGMA foreign_keys = ON'],
} as const;

const [action, dialect, uri, vectorsPath, ...rest] = process.argv.slice(2);
if (action === undefined || dialect === undefined || uri === undefined || vectorsPath === undefined || rest.length > 0) {
  console.error('usage: node packages/ts/testing/dbspec/apply/typescript.mts <apply-first|apply|stop|recover|rollback> <mysql|postgres|sqlite> <uri> <plans.json>');
  process.exit(2);
}
const url = new URL(uri);

const plans = readVectors(vectorsPath, 'plans')
  .cases.filter(c => c.id === 'create-from-empty' || c.id === 'rename-table-and-column')
  .map(c => {
    const parsed = parsePlan(c.plan.join('\n') + '\n');
    if (parsed.plan === null) throw new Error(`${c.id}: ${JSON.stringify(parsed.diagnostics)}`);
    return parsed.plan;
  });
const [first, second] = plans;
if (plans.length !== 2 || first === undefined || second === undefined || second.from !== first.to) throw new Error('plans.json does not chain create-from-empty and rename-table-and-column');

/** An open connection of one dialect, the statement runner of the connection rules and its close. */
type Opened =
  | { dialect: 'mysql'; connection: mysql.Connection; exec: (sql: string) => Promise<unknown>; close: () => Promise<void> }
  | { dialect: 'postgres'; connection: pg.Client; exec: (sql: string) => Promise<unknown>; close: () => Promise<void> }
  | { dialect: 'sqlite'; connection: DatabaseSync; exec: (sql: string) => Promise<unknown>; close: () => Promise<void> };

// connect opens the URI as the dialect's driver connection.
async function connect(): Promise<Opened> {
  if (dialect === 'mysql' && url.protocol === 'mysql:' && url.search === '') {
    const connection = await mysql.createConnection({
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
      host: url.hostname, port: Number(url.port), database: url.pathname.slice(1),
    });
    return { dialect, connection, exec: sql => connection.query(sql), close: () => connection.end() };
  }
  if (dialect === 'postgres' && url.protocol === 'postgres:') {
    const connection = new pg.Client({ connectionString: uri });
    await connection.connect();
    return { dialect, connection, exec: sql => connection.query(sql), close: () => connection.end() };
  }
  if (dialect === 'sqlite' && url.protocol === 'sqlite:' && url.search === '') {
    const connection = new DatabaseSync(decodeURIComponent(url.pathname));
    return { dialect, connection, exec: async sql => connection.exec(sql), close: async () => connection.close() };
  }
  throw new Error(`${dialect ?? ''}: unsupported URI ${uri ?? ''}`);
}

/** applyPlans, recoverPlans and rollbackPlans take the same arguments for each dialect. */
type Operation = typeof applyPlans;
// operate runs the operation on the open connection of its dialect.
function operate(operation: Operation, opened: Opened, list: readonly DbspecPlan[], events: DbspecApplyHandler | null): Promise<void> {
  switch (opened.dialect) {
    case 'mysql': return operation(opened.connection, 'mysql', list, now, events);
    case 'postgres': return operation(opened.connection, 'postgres', list, now, events);
    case 'sqlite': return operation(opened.connection, 'sqlite', list, now, events);
  }
}

const opened = await connect();
// tool clock: 2026-10-01T00:00:00.123456789Z truncated to microseconds (microseconds since the epoch).
const now = () => Date.UTC(2026, 9, 1, 0, 0, 0) * 1000 + 123456;
const stop = new Error('stop');
let result: string;
try {
  for (const rule of CONNECTION_RULES[opened.dialect]) await opened.exec(rule);
  switch (action) {
    case 'apply-first':
      await operate(applyPlans, opened, [first], null);
      break;
    case 'apply':
      await operate(applyPlans, opened, plans, null);
      break;
    case 'recover':
      await operate(recoverPlans, opened, plans, null);
      break;
    case 'rollback':
      await operate(rollbackPlans, opened, plans, null);
      break;
    case 'stop':
      await operate(applyPlans, opened, plans, event => {
        if (event.kind === 'applied' && event.plan === second.name && event.step === 1) throw stop;
      });
      throw new Error('stop: apply did not stop');
    default:
      throw new Error(`unknown action ${action}`);
  }
  result = 'ok';
} catch (error) {
  if (error === stop) result = 'stopped';
  else if (error instanceof DbspecApplyError) result = `error ${error.code}`;
  else throw error;
} finally {
  await opened.close();
}
console.log(result);
