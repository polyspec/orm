// Introspects one database with the TypeScript client and writes the output in the format of tests/dbspec/introspect:
// to stdout, the canonical document and the unsupported object lines
// "! kind<TAB>table<TAB>name", and "elapsed <ms>" to stderr.
//
// Usage: node packages/ts/testing/dbspec/introspect/typescript.mts <mysql|postgres|sqlite> <uri>
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { emitDbspec, introspectDbspec, type DbspecIntrospection } from '../../../dist/index.js';
import { connectMysql } from '../connect.mts';

const [dialect, uri, ...rest] = process.argv.slice(2);
if (dialect === undefined || uri === undefined || rest.length > 0) {
  console.error('usage: node packages/ts/testing/dbspec/introspect/typescript.mts <mysql|postgres|sqlite> <uri>');
  process.exit(2);
}
const url = new URL(uri);

// timed is the result of one introspection and its milliseconds. The time to open and close the connection is not included.
async function timed(work: () => Promise<DbspecIntrospection>): Promise<[DbspecIntrospection, number]> {
  const start = process.hrtime.bigint();
  const result = await work();
  return [result, Number(process.hrtime.bigint() - start) / 1e6];
}

// introspect opens the URI as the dialect's driver connection, introspects, and closes it.
async function introspect(): Promise<[DbspecIntrospection, number]> {
  if (dialect === 'mysql' && url.protocol === 'mysql:' && url.search === '') {
    const connection = await connectMysql(url);
    try { return await timed(() => introspectDbspec(connection, 'mysql', 'introspected')); } finally { await connection.end(); }
  }
  if (dialect === 'postgres' && url.protocol === 'postgres:') {
    const client = new pg.Client({ connectionString: uri });
    await client.connect();
    try { return await timed(() => introspectDbspec(client, 'postgres', 'introspected')); } finally { await client.end(); }
  }
  if (dialect === 'sqlite' && url.protocol === 'sqlite:' && url.search === '') {
    const db = new DatabaseSync(decodeURIComponent(url.pathname));
    try { return await timed(() => introspectDbspec(db, 'sqlite', 'introspected')); } finally { db.close(); }
  }
  throw new Error(`${dialect}: unsupported URI ${uri}`);
}

const [{ document, unsupported }, elapsed] = await introspect();
let out = emitDbspec(document);
for (const u of unsupported) out += `! ${u.kind}\t${u.table}\t${u.name}\n`;
process.stdout.write(out);
console.error(`elapsed ${elapsed.toFixed(1)}`);
