// 한 database를 TypeScript client로 introspect해 tests/dbspec/introspect의 출력
// 형식으로 쓴다: stdout에 canonical 문서와 미지원 객체 줄
// "! kind<TAB>table<TAB>name", stderr에 "elapsed <ms>".
//
// Usage: node packages/ts/testing/dbspec/introspect/typescript.mts <mysql|postgres|sqlite> <uri>
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { emitDbspec, introspectDbspec, type DbspecIntrospection } from '../../../dist/index.js';

const [dialect, uri, ...rest] = process.argv.slice(2);
if (dialect === undefined || uri === undefined || rest.length > 0) {
  console.error('usage: node packages/ts/testing/dbspec/introspect/typescript.mts <mysql|postgres|sqlite> <uri>');
  process.exit(2);
}
const url = new URL(uri);

// timed는 introspection 하나의 결과와 그 milliseconds다. 연결을 열고 닫는 시간은 들지 않는다.
async function timed(work: () => Promise<DbspecIntrospection>): Promise<[DbspecIntrospection, number]> {
  const start = process.hrtime.bigint();
  const result = await work();
  return [result, Number(process.hrtime.bigint() - start) / 1e6];
}

// introspect는 URI를 dialect의 driver connection으로 열어 introspect하고 닫는다.
async function introspect(): Promise<[DbspecIntrospection, number]> {
  if (dialect === 'mysql' && url.protocol === 'mysql:' && url.search === '') {
    const connection = await mysql.createConnection({
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
      host: url.hostname, port: Number(url.port), database: url.pathname.slice(1),
    });
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
