// feature coverage test 의 공용 실행부. checker 는 `node <file> <case id>...` 로 실행하고
// 출력 전체가 `CASE <id> PASS` 줄뿐이어야 하므로, 요청한 case 만 순서대로 실행하고 통과한
// case 마다 그 한 줄만 쓴다. 실패는 throw 해서 process 가 0 아닌 code 로 끝난다.
import { createRequire } from 'node:module';

const require = createRequire(new URL('../package.json', import.meta.url));

/** The repository root, resolved from this file. */
export const repositoryRoot = new URL('../../..', import.meta.url).pathname;

/**
 * Runs exactly the case IDs of the command line in their order; an unknown,
 * repeated or missing ID is an error. Each case is stopped after timeoutMs of
 * wall-clock time, because it waits on a database or another process.
 */
export async function runCases(file, cases, timeoutMs) {
  const requested = process.argv.slice(2);
  if (requested.length === 0 || new Set(requested).size !== requested.length ||
      requested.some(id => !Object.hasOwn(cases, id))) {
    throw new Error(`usage: ${file} ${Object.keys(cases).join('|')}...; got ${JSON.stringify(requested)}`);
  }
  for (const id of requested) {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`case ${id} exceeded ${timeoutMs} ms`)), timeoutMs);
    });
    try { await Promise.race([cases[id](), deadline]); } finally { clearTimeout(timer); }
    console.log(`CASE ${id} PASS`);
  }
}

/** The database and DSN the checker selected; a database case fails without them. */
export function featureDatabase() {
  const { ORM_FEATURE_DATABASE: driver, ORM_FEATURE_DSN: dsn } = process.env;
  if (!['mysql', 'postgres', 'sqlite'].includes(driver) || !dsn) {
    throw new Error('ORM_FEATURE_DATABASE (mysql|postgres|sqlite) and ORM_FEATURE_DSN are required');
  }
  return { driver, dsn };
}

/**
 * Runs statements on the database of a DSN through its native driver, outside
 * the client under test, and returns the rows of each statement.
 */
export async function nativeQuery(driver, dsn, statements) {
  const url = new URL(dsn);
  const results = [];
  if (driver === 'sqlite') {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(decodeURIComponent(url.pathname));
    try {
      for (const sql of statements) results.push(db.prepare(sql).all());
    } finally { db.close(); }
    return results;
  }
  if (driver === 'mysql') {
    const conn = await require('mysql2/promise').createConnection({
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
      socketPath: url.searchParams.get('socket') ?? undefined, host: url.hostname,
      port: url.port ? Number(url.port) : undefined, database: decodeURIComponent(url.pathname.slice(1)),
    });
    try {
      for (const sql of statements) results.push((await conn.query(sql))[0]);
    } finally { await conn.end(); }
    return results;
  }
  const { Client } = require('pg');
  const client = new Client({
    host: url.searchParams.get('host') ?? url.hostname, port: url.port ? Number(url.port) : undefined,
    database: decodeURIComponent(url.pathname.slice(1)), user: decodeURIComponent(url.username) || undefined,
    password: decodeURIComponent(url.password) || undefined,
  });
  await client.connect();
  try {
    for (const sql of statements) results.push((await client.query(sql)).rows);
  } finally { await client.end(); }
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
