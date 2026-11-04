// Shared runner of the feature coverage test. The checker runs it as `node <file> <case id>...`, and
// since the whole output must be only `CASE <id> PASS` lines, it runs only the requested cases in order and
// writes only that one line per passing case. A failure throws, so the process ends with a non-zero code.
// When run without a case ID (the parity check's `node --test <file>`), it registers, for each case of the suite,
// a top-level node:test test under that ID.
import { createRequire } from 'node:module';
import { caseTest } from '../../../tests/testcase.mts';

const require = createRequire(new URL('../package.json', import.meta.url));

/** The repository root, resolved from this file. */
export const repositoryRoot = new URL('../../..', import.meta.url).pathname;

/**
 * Runs the cases of a file without a database. The command line gives the case IDs in their order, and each prints
 * `CASE <id> PASS`. An unknown or repeated ID is an error. Each run is stopped after timeoutMs of wall-clock time. Without an ID,
 * each case of suite runs as a node:test test named by its ID.
 */
export async function runCases(file, cases, timeoutMs, suite = cases) {
  return runItems([{ database: 'none', driver: 'none', dsn: null }], file, cases, timeoutMs, suite);
}

/** Runs the cases of a test file on the one database that the file names, with no selection of the manifest. */
export async function runCasesOn(database, file, cases, timeoutMs, dsn = null) {
  return runItems([{ database, driver: database, dsn }], file, cases, timeoutMs, cases);
}

async function runItems(items, file, cases, timeoutMs, suite) {
  const requested = process.argv.slice(2);
  if (requested.length === 0) {
    for (const [id, body] of Object.entries(suite)) {
      for (const item of items) caseTest(item.database === 'none' ? id : `${id} [${item.database}]`, timeoutMs, () => body(item));
    }
    return;
  }
  if (new Set(requested).size !== requested.length ||
      requested.some(id => !Object.hasOwn(cases, id))) {
    throw new Error(`usage: ${file} ${Object.keys(cases).join('|')}...; got ${JSON.stringify(requested)}`);
  }
  for (const id of requested) {
    for (const item of items) {
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`case ${id} exceeded ${timeoutMs} ms`)), timeoutMs);
      });
      try { await Promise.race([cases[id](item), deadline]); } finally { clearTimeout(timer); }
      console.log(item.database === 'none' ? `CASE ${id} PASS` : `CASE ${id} [${item.database}] PASS`);
    }
  }
}

/**
 * Opens one connection on the database of a DSN through its native driver, outside the client under test:
 * query runs a statement and returns its rows, and close ends the connection.
 */
export async function nativeSession(driver, dsn) {
  const url = new URL(dsn);
  if (driver === 'sqlite') {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(decodeURIComponent(url.pathname));
    return { connection: db, query: async sql => db.prepare(sql).all(), close: async () => db.close() };
  }
  if (driver === 'mysql') {
    const conn = await require('mysql2/promise').createConnection({
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
      socketPath: url.searchParams.get('socket') ?? undefined, host: url.hostname,
      port: url.port ? Number(url.port) : undefined, database: decodeURIComponent(url.pathname.slice(1)),
    });
    return { connection: conn, query: async sql => (await conn.query(sql))[0], close: () => conn.end() };
  }
  const { Client } = require('pg');
  const client = new Client({
    host: url.searchParams.get('host') ?? url.hostname, port: url.port ? Number(url.port) : undefined,
    database: decodeURIComponent(url.pathname.slice(1)), user: decodeURIComponent(url.username) || undefined,
    password: decodeURIComponent(url.password) || undefined,
  });
  await client.connect();
  return { connection: client, query: async sql => (await client.query(sql)).rows, close: () => client.end() };
}

/**
 * Runs statements on the database of a DSN through its native driver, outside
 * the client under test, and returns the rows of each statement.
 */
export async function nativeQuery(driver, dsn, statements) {
  const session = await nativeSession(driver, dsn);
  const results = [];
  try {
    for (const sql of statements) results.push(await session.query(sql));
  } finally { await session.close(); }
  return results;
}

/** Reports whether a table exists in the database or schema the DSN connects to. */
export async function tableExists(driver, dsn, table) {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`table name ${table} is not a plain identifier`);
  const sql = {
    mysql: `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}'`,
    postgres: `SELECT COUNT(*)::int AS n FROM pg_tables WHERE schemaname = current_schema() AND tablename = '${table}'`,
    sqlite: `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '${table}'`,
  }[driver];
  const [[row]] = await nativeQuery(driver, dsn, [sql]);
  return Number(row.n) === 1;
}

/** The code of the error a promise rejects with, or null when it resolves. */
export async function errorCode(promise) {
  try { await promise; return null; } catch (error) {
    if (typeof error?.code === 'string' && error.code !== '') return error.code;
    throw error;
  }
}

/**
 * Runs body, then cleanup even when body failed; both failures are reported
 * together so that a failed cleanup never hides the failure of the case.
 */
export async function withCleanup(body, cleanup) {
  let failure = null;
  try { await body(); } catch (error) { failure = error; }
  try { await cleanup(); } catch (error) {
    failure = failure === null ? error : new AggregateError([failure, error], 'the case and its cleanup failed');
  }
  if (failure !== null) throw failure;
}

/**
 * Rejects with the label and the deadline when the promise has no result within `ms`. Every case that streams a large
 * result runs under a deadline: a read that did not stop at its budget would never finish.
 */
export function within(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: no result within ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
