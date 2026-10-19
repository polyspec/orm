// introspect_case.mjs holds the helpers of the dbspec introspection tests on MySQL, PostgreSQL and SQLite: the
// round-trip sets, the parse of a document set, and withDatabase, which gives each probe an empty database, schema or
// file and checks that nothing remains after it.
import { caseTest } from '../../../tests/testcase.mts';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { dbspecManifest, parseDbspec, readDbspecFile } from '../dist/dbspec/index.js';

export const root = new URL('../../../', import.meta.url);
// TIMEOUT is the deadline (ms) of one case. One round trip applies one document set to one database, introspects it, then drops it.
const TIMEOUT = 30000;
export const DIALECTS = ['mysql', 'postgres', 'sqlite'];
// The number of catalog queries that must be the same for each dialect in every set (docs/spec/dialects.md "Introspection").
export const QUERIES = { mysql: 9, postgres: 7, sqlite: 3 };
// The statements that every client runs on a new connection (packages/go/internal/dialects connectionRules).
export const CONNECTION_RULES = {
  mysql: ["SET time_zone = '+00:00'"],
  postgres: ["SET TimeZone = 'UTC'"],
  sqlite: ['PRAGMA foreign_keys = ON'],
};
// The *.dbs files in the same directories as packages/go/internal/dialects schemaDocumentPatterns.
const SCHEMA_DIRECTORIES = ['contracts/fixtures/bench', 'contracts/fixtures'];

const mysqlDSN = process.env.ORM_TEST_MYSQL_DSN;
const postgresDSN = process.env.ORM_TEST_POSTGRES_DSN;
if (!mysqlDSN || !postgresDSN) throw new Error('ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; pass TEST_ENV');

export const text = lines => lines.join('\n') + '\n';

// vector runs one case with its own deadline and reports its start, result
// and elapsed time.
export function vector(name, body) {
  caseTest(name, TIMEOUT, body);
}

// roundTripSets returns every case of ddl.json and every schema document as a
// set of document texts by name.
export function roundTripSets() {
  const out = [];
  const ddl = JSON.parse(readFileSync(new URL('tests/dbspec/ddl.json', root), 'utf8'));
  for (const c of ddl.cases) {
    const documents = {};
    for (const [name, lines] of Object.entries(c.documents)) documents[name] = text(lines);
    out.push({ id: 'ddl_' + c.id.replaceAll('-', '_'), documents });
  }
  for (const directory of SCHEMA_DIRECTORIES) {
    // Each schema document is one set with the documents of its directory that it uses.
    const texts = {};
    for (const file of readdirSync(new URL(directory + '/', root)).filter(f => f.endsWith('.dbs')).sort()) {
      const read = readDbspecFile(fileURLToPath(new URL(`${directory}/${file}`, root)));
      if (read.text === null) throw new Error(read.diagnostics[0].message);
      texts[file.slice(0, -'.dbs'.length)] = read.text;
    }
    for (const [name, source] of Object.entries(texts)) {
      const others = { ...texts };
      delete others[name];
      const { document, diagnostics } = parseDbspec(source, others);
      if (document === null) throw new Error(`${directory}/${name}.dbs: ${JSON.stringify(diagnostics)}`);
      const documents = { [name]: source };
      for (const use of document.uses) documents[use.document] = texts[use.document];
      out.push({ id: 'schema_' + name, documents });
    }
  }
  return out;
}

// parseSet parses every document of a set against the others, in name order.
export function parseSet(id, documents) {
  return Object.keys(documents).sort().map(name => {
    const set = {};
    for (const [other, source] of Object.entries(documents)) if (other !== name) set[other] = source;
    const result = parseDbspec(documents[name], set);
    assert.deepEqual(result.diagnostics, [], `${id}/${name}`);
    return result.document;
  });
}

const byteOrder = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

// expectedSchemaText is the schema text of one document holding every table of the set in name order.
export function expectedSchemaText(documents) {
  const tables = documents.flatMap(d => d.tables).sort((a, b) => byteOrder(a.name, b.name));
  const result = dbspecManifest([{ name: 'introspected', uses: [], tables, diagrams: [], closingComments: [] }]);
  assert.deepEqual(result.diagnostics, []);
  return result.manifest.schemaText;
}

function mysqlOptions(database) {
  const url = new URL(mysqlDSN);
  return {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    socketPath: url.searchParams.get('socket') ?? undefined,
    host: url.hostname || undefined,
    port: url.port ? Number(url.port) : undefined,
    database,
  };
}

const run = `ts${process.pid}`;
const sqliteDirectory = mkdtempSync(join(tmpdir(), `dbspec-introspect-${run}-`));
process.on('exit', () => rmSync(sqliteDirectory, { recursive: true, force: true }));
let probes = 0;

// withDatabase creates an empty database, schema or file named after the
// language, the pid and the probe, gives a connection to it, an exec function
// and its name to body, and drops it and checks that nothing remains.
export async function withDatabase(dialect, body) {
  const name = `dbspec_${run}_${String(probes++).padStart(3, '0')}`;
  switch (dialect) {
    case 'mysql': {
      const admin = await mysql.createConnection(mysqlOptions(undefined));
      try {
        await admin.query(`CREATE DATABASE \`${name}\``);
        try {
          const connection = await mysql.createConnection(mysqlOptions(name));
          try {
            await body(connection, (connection, sql) => connection.query(sql), name);
          } finally {
            await connection.end();
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
          const client = new pg.Client({ connectionString: postgresDSN });
          await client.connect();
          try {
            await client.query('SET client_min_messages = warning');
            await client.query(`SET search_path TO "${name}"`);
            await body(client, (client, sql) => client.query(sql), name);
          } finally {
            await client.end();
          }
        } finally {
          // A case that needs a second schema creates it as <schema>_b.
          await admin.query(`DROP SCHEMA IF EXISTS "${name}_b" CASCADE`);
          await admin.query(`DROP SCHEMA "${name}" CASCADE`);
          const { rows } = await admin.query('SELECT COUNT(*)::int AS n FROM pg_namespace WHERE nspname IN ($1, $2)', [name, `${name}_b`]);
          assert.equal(rows[0].n, 0, `schema ${name} remains after cleanup`);
        }
      } finally {
        await admin.end();
      }
      return;
    }
    case 'sqlite': {
      const path = join(sqliteDirectory, `${name}.sqlite`);
      assert(!existsSync(path), `SQLite file ${path} already exists`);
      const db = new DatabaseSync(path);
      try {
        await body(db, (db, sql) => db.exec(sql), name);
      } finally {
        db.close();
        for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(path + suffix, { force: true });
        assert(!existsSync(path), `${path} remains after cleanup`);
      }
      return;
    }
  }
  throw new Error(`unknown dialect ${dialect}`);
}

// counting wraps a connection so that every catalog query the introspection
// sends is counted: query on MySQL and PostgreSQL, prepare on SQLite.
export function counting(dialect, connection) {
  const counter = { count: 0 };
  const method = dialect === 'sqlite' ? 'prepare' : 'query';
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

