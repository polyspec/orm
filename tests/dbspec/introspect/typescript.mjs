// 한 database를 TypeScript client로 introspect해 tests/dbspec/introspect의 출력
// 형식으로 쓴다: stdout에 canonical 문서와 미지원 객체 줄
// "! kind<TAB>table<TAB>name", stderr에 "elapsed <ms>".
//
// Usage: node tests/dbspec/introspect/typescript.mjs <mysql|postgres|sqlite> <uri>
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { emitDbspec, introspectDbspec } from '../../../packages/orm-npm/dist/index.js';

const require = createRequire(new URL('../../../packages/orm-npm/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const pg = require('pg');

if (process.argv.length !== 4) {
  console.error('usage: node tests/dbspec/introspect/typescript.mjs <mysql|postgres|sqlite> <uri>');
  process.exit(2);
}
const [dialect, uri] = process.argv.slice(2);
const url = new URL(uri);

// connect는 URI를 dialect의 driver connection으로 열고 닫는 함수와 함께 돌려준다.
async function connect() {
  if (dialect === 'mysql' && url.protocol === 'mysql:' && url.search === '') {
    const connection = await mysql.createConnection({
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
      host: url.hostname, port: Number(url.port), database: url.pathname.slice(1),
    });
    return [connection, () => connection.end()];
  }
  if (dialect === 'postgres' && url.protocol === 'postgres:') {
    const client = new pg.Client({ connectionString: uri });
    await client.connect();
    return [client, () => client.end()];
  }
  if (dialect === 'sqlite' && url.protocol === 'sqlite:' && url.search === '') {
    const db = new DatabaseSync(decodeURIComponent(url.pathname));
    return [db, () => db.close()];
  }
  throw new Error(`${dialect}: unsupported URI ${uri}`);
}

const [connection, close] = await connect();
try {
  const start = process.hrtime.bigint();
  const { document, unsupported } = await introspectDbspec(connection, dialect, 'introspected');
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  let out = emitDbspec(document);
  for (const u of unsupported) out += `! ${u.kind}\t${u.table}\t${u.name}\n`;
  process.stdout.write(out);
  console.error(`elapsed ${elapsed.toFixed(1)}`);
} finally {
  await close();
}
