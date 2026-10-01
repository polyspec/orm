// dbspec introspection on MySQL, PostgreSQL and SQLite (docs/dialects.md
// "Introspection"). Every case of tests/dbspec/ddl.json and every schema
// document is rendered, applied to an empty database, schema or file and
// introspected: the schema text of the result equals the schema text of the
// source with its tables in name order, nothing is unsupported, and every set
// takes the same number of catalog queries per dialect. Every case of
// tests/dbspec/introspect.json is applied with its statements and expects its
// document and unsupported objects.
//
// Usage: ORM_TEST_MYSQL_DSN=... ORM_TEST_POSTGRES_DSN=... node --test clients/typescript/tests/dbspec-introspect.mjs (after the build)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { dbspecManifest, emitDbspec, introspectDbspec, parseDbspec, renderDbspec } from '../dist/dbspec/index.js';

const root = new URL('../../../', import.meta.url);
const TIMEOUT = 30000;
const DIALECTS = ['mysql', 'postgres', 'sqlite'];
// 모든 집합에서 dialect마다 같아야 하는 catalog query 수다(docs/dialects.md "Introspection").
const QUERIES = { mysql: 9, postgres: 7, sqlite: 3 };
// 모든 client가 새 connection에서 실행하는 문장이다(tests/dialects connectionRules).
const CONNECTION_RULES = {
  mysql: ["SET time_zone = '+00:00'"],
  postgres: ["SET TimeZone = 'UTC'"],
  sqlite: ['PRAGMA foreign_keys = ON'],
};
// tests/dialects schemaDocumentPatterns와 같은 디렉터리의 *.dbspec이다.
const SCHEMA_DIRECTORIES = ['schema', 'contracts/fixtures'];

const mysqlDSN = process.env.ORM_TEST_MYSQL_DSN;
const postgresDSN = process.env.ORM_TEST_POSTGRES_DSN;
if (!mysqlDSN || !postgresDSN) throw new Error('ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; pass TEST_ENV');

const text = lines => lines.join('\n') + '\n';

// vector runs one case with its own deadline and reports its start, result
// and elapsed time.
function vector(name, body) {
  test(name, { timeout: TIMEOUT }, async () => {
    const started = performance.now();
    console.log(`start ${name}`);
    try {
      await body();
    } catch (error) {
      console.log(`result ${name}: FAIL after ${(performance.now() - started).toFixed(1)} ms`);
      throw error;
    }
    console.log(`result ${name}: PASS after ${(performance.now() - started).toFixed(1)} ms`);
  });
}

// roundTripSets returns every case of ddl.json and every schema document as a
// set of document texts by name.
function roundTripSets() {
  const out = [];
  const ddl = JSON.parse(readFileSync(new URL('tests/dbspec/ddl.json', root), 'utf8'));
  for (const c of ddl.cases) {
    const documents = {};
    for (const [name, lines] of Object.entries(c.documents)) documents[name] = text(lines);
    out.push({ id: 'ddl_' + c.id.replaceAll('-', '_'), documents });
  }
  for (const directory of SCHEMA_DIRECTORIES) {
    const files = readdirSync(new URL(directory + '/', root)).filter(f => f.endsWith('.dbspec')).sort();
    for (const file of files) {
      const name = file.slice(0, -'.dbspec'.length);
      out.push({ id: 'schema_' + name, documents: { [name]: readFileSync(new URL(`${directory}/${file}`, root), 'utf8') } });
    }
  }
  return out;
}

// parseSet parses every document of a set against the others, in name order.
function parseSet(id, documents) {
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
function expectedSchemaText(documents) {
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
async function withDatabase(dialect, body) {
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
          // 두 번째 schema가 필요한 case는 그것을 <schema>_b로 만든다.
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
function counting(dialect, connection) {
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

const sets = roundTripSets();
assert(sets.length > 0, 'round-trip sets');
const queries = { mysql: new Map(), postgres: new Map(), sqlite: new Map() };

for (const s of sets) {
  for (const dialect of DIALECTS) {
    vector(`${dialect}.introspect.${s.id}`, async () => {
      const documents = parseSet(s.id, s.documents);
      const want = expectedSchemaText(documents);
      const rendered = renderDbspec(documents, dialect);
      assert.deepEqual(rendered.diagnostics, []);
      await withDatabase(dialect, async (connection, exec) => {
        for (const sql of [...CONNECTION_RULES[dialect], ...rendered.statements]) await exec(connection, sql);
        const { proxy, counter } = counting(dialect, connection);
        const { document, unsupported } = await introspectDbspec(proxy, dialect, 'introspected');
        const ids = queries[dialect].get(counter.count) ?? [];
        ids.push(`${s.id} (${document.tables.length} tables)`);
        queries[dialect].set(counter.count, ids);
        assert.deepEqual(unsupported, [], 'unsupported objects');
        const manifest = dbspecManifest([document]);
        assert.deepEqual(manifest.diagnostics, []);
        assert.equal(manifest.manifest.schemaText, want);
      });
    });
  }
}

vector('introspection query count per dialect', () => {
  for (const dialect of DIALECTS) {
    const counts = queries[dialect];
    assert.equal(counts.size, 1, `${dialect}: introspection query counts differ between sets: ${JSON.stringify([...counts])}`);
    const [[count, ids]] = counts;
    assert.equal(ids.length, sets.length, `${dialect}: every set is introspected`);
    assert.equal(count, QUERIES[dialect], `${dialect}: query count`);
    console.log(`${dialect}: ${count} queries for every one of ${ids.length} sets`);
  }
});

const cases = JSON.parse(readFileSync(new URL('tests/dbspec/introspect.json', root), 'utf8')).cases;
assert(cases.length > 0, 'introspect cases');
for (const c of cases) {
  vector(`${c.dialect}.introspect.${c.id}`, async () => {
    const sources = {};
    for (const [name, lines] of Object.entries(c.documents)) sources[name] = text(lines);
    const rendered = renderDbspec(parseSet(c.id, sources), c.dialect);
    assert.deepEqual(rendered.diagnostics, []);
    await withDatabase(c.dialect, async (connection, exec, name) => {
      // {schema}는 이 case의 database 또는 schema 이름이다.
      const statements = c.statements.map(sql => sql.replaceAll('{schema}', name));
      for (const sql of [...CONNECTION_RULES[c.dialect], ...rendered.statements, ...statements]) await exec(connection, sql);
      const { document, unsupported } = await introspectDbspec(connection, c.dialect, 'introspected');
      assert.equal(emitDbspec(document), text(c.document));
      assert.deepEqual(unsupported.map(u => [u.kind, u.table, u.name]), c.unsupported);
      for (const u of unsupported) assert(u.reason.length > 0, `reason of ${u.kind} ${u.table} ${u.name}`);
    });
  });
}

vector('introspection rejects an unknown dialect', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    await assert.rejects(introspectDbspec(db, 'oracle', 'introspected'), { name: 'TypeError', message: /oracle/ });
  } finally {
    db.close();
  }
});

vector('introspection reports a failing catalog query', async () => {
  const db = new DatabaseSync(':memory:');
  db.close();
  await assert.rejects(introspectDbspec(db, 'sqlite', 'introspected'), { message: /not open/ });
});
