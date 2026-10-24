import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { mysqlTestOptions } from './mysql-test-options.mjs';

function mysqlSession(connection) {
  return {
    connection,
    exec: sql => connection.query(sql),
    execute: (target, sql) => target.query(sql),
    rows: async sql => (await connection.query({ sql, rowsAsArray: true }))[0],
    close: () => connection.end(),
  };
}

function postgresSession(client) {
  return {
    connection: client,
    exec: sql => client.query(sql),
    execute: (target, sql) => target.query(sql),
    rows: async sql => (await client.query({ text: sql, rowMode: 'array' })).rows,
    close: () => client.end(),
  };
}

function sqliteSession(db) {
  return {
    connection: db,
    exec: async sql => db.exec(sql),
    execute: (target, sql) => target.exec(sql),
    rows: async sql => {
      const statement = db.prepare(sql);
      statement.setReturnArrays(true);
      return statement.all();
    },
    close: async () => db.close(),
  };
}

/** Runs one physical dbspec test on a fresh database, schema or SQLite file and removes it after the case. */
export async function withDbspecPhysicalDatabase({ dialect, name, mysqlDSN, postgresDSN, sqliteDirectory, postgresSiblingSchema = false, body }) {
  switch (dialect) {
    case 'mysql': {
      const admin = await mysql.createConnection(mysqlTestOptions(mysqlDSN, undefined));
      try {
        await admin.query(`CREATE DATABASE \`${name}\``);
        try {
          const open = async () => mysqlSession(await mysql.createConnection(mysqlTestOptions(mysqlDSN, name)));
          const session = await open();
          try {
            await body(session, open, name);
          } finally {
            await session.close();
          }
        } finally {
          await admin.query(`DROP DATABASE \`${name}\``);
          const [rows] = await admin.query('SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [name]);
          assert.equal(Number(rows[0].n), 0, `database ${name} remains after cleanup`);
        }
      } finally {
        await admin.end();
      }
      return;
    }
    case 'postgres': {
      const admin = new pg.Client({ connectionString: postgresDSN });
      await admin.connect();
      try {
        await admin.query(`CREATE SCHEMA "${name}"`);
        try {
          const open = async () => {
            const client = new pg.Client({ connectionString: postgresDSN });
            await client.connect();
            await client.query('SET client_min_messages = warning');
            await client.query(`SET search_path TO "${name}"`);
            return postgresSession(client);
          };
          const session = await open();
          try {
            await body(session, open, name);
          } finally {
            await session.close();
          }
        } finally {
          if (postgresSiblingSchema) await admin.query(`DROP SCHEMA IF EXISTS "${name}_b" CASCADE`);
          await admin.query(`DROP SCHEMA "${name}" CASCADE`);
          const query = postgresSiblingSchema
            ? await admin.query('SELECT COUNT(*)::int AS n FROM pg_namespace WHERE nspname IN ($1, $2)', [name, `${name}_b`])
            : await admin.query('SELECT COUNT(*)::int AS n FROM pg_namespace WHERE nspname = $1', [name]);
          assert.equal(query.rows[0].n, 0, `schema ${name} remains after cleanup`);
        }
      } finally {
        await admin.end();
      }
      return;
    }
    case 'sqlite': {
      const path = join(sqliteDirectory, `${name}.sqlite`);
      assert(!existsSync(path), `SQLite file ${path} already exists`);
      const session = sqliteSession(new DatabaseSync(path));
      try {
        await body(session, async () => sqliteSession(new DatabaseSync(path)), name);
      } finally {
        await session.close();
        for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(path + suffix, { force: true });
        assert(!existsSync(path), `${path} remains after cleanup`);
      }
      return;
    }
  }
  throw new Error(`unknown dialect ${dialect}`);
}

/** Creates the per-process SQLite directory and uniquely names each physical dbspec fixture. */
export function createDbspecPhysicalDatabaseRunner({ namePrefix, filePrefix = namePrefix, mysqlDSN, postgresDSN, postgresSiblingSchema = false }) {
  const run = `ts${process.pid}`;
  const sqliteDirectory = mkdtempSync(join(tmpdir(), `dbspec-${filePrefix}-${run}-`));
  process.on('exit', () => rmSync(sqliteDirectory, { recursive: true, force: true }));
  let probes = 0;
  return (dialect, body) => withDbspecPhysicalDatabase({
    dialect,
    name: `${namePrefix}_${run}_${String(probes++).padStart(3, '0')}`,
    mysqlDSN,
    postgresDSN,
    sqliteDirectory,
    postgresSiblingSchema,
    body,
  });
}
