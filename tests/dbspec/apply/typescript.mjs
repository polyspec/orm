// plans.json(tests/dbspec/plans.json)의 chain(create-from-empty와
// rename-table-and-column)을 TypeScript client로 한 database에 적용한다
// (docs/plans.md "Apply"). action은 apply-first(첫 plan만), apply(chain 전체),
// stop(둘째 plan의 statement 1이 실행된 뒤 멈춤), recover(중단된 MySQL plan을
// 끝냄) 중 하나다. stdout에는 결과 한 줄을 쓴다: "ok", "stopped" 또는
// "error <code>". 그 밖의 error는 stderr에 쓰고 1로 끝난다.
//
// Usage: node tests/dbspec/apply/typescript.mjs <apply-first|apply|stop|recover> <mysql|postgres|sqlite> <uri> <plans.json>
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { DbspecApplyError, applyPlans, parsePlan, recoverPlans } from '../../../clients/typescript/dist/dbspec/index.js';

const require = createRequire(new URL('../../../clients/typescript/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const pg = require('pg');

// 모든 client가 새 connection에서 실행하는 statement다(tests/dialects connectionRules).
const CONNECTION_RULES = {
  mysql: ["SET time_zone = '+00:00'"],
  postgres: ["SET TimeZone = 'UTC'"],
  sqlite: ['PRAGMA foreign_keys = ON'],
};

if (process.argv.length !== 6) {
  console.error('usage: node tests/dbspec/apply/typescript.mjs <apply-first|apply|stop|recover> <mysql|postgres|sqlite> <uri> <plans.json>');
  process.exit(2);
}
const [action, dialect, uri, vectorsPath] = process.argv.slice(2);
const url = new URL(uri);

const plans = JSON.parse(readFileSync(vectorsPath, 'utf8'))
  .cases.filter(c => c.id === 'create-from-empty' || c.id === 'rename-table-and-column')
  .map(c => {
    const parsed = parsePlan(c.plan.join('\n') + '\n');
    if (parsed.plan === null) throw new Error(`${c.id}: ${JSON.stringify(parsed.diagnostics)}`);
    return parsed.plan;
  });
if (plans.length !== 2 || plans[1].from !== plans[0].to) throw new Error('plans.json does not chain create-from-empty and rename-table-and-column');

// connect는 URI를 dialect의 driver connection으로 열고 실행할 문장과 닫는 함수를 돌려준다.
async function connect() {
  if (dialect === 'mysql' && url.protocol === 'mysql:' && url.search === '') {
    const connection = await mysql.createConnection({
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
      host: url.hostname, port: Number(url.port), database: url.pathname.slice(1),
    });
    return [connection, sql => connection.query(sql), () => connection.end()];
  }
  if (dialect === 'postgres' && url.protocol === 'postgres:') {
    const client = new pg.Client({ connectionString: uri });
    await client.connect();
    return [client, sql => client.query(sql), () => client.end()];
  }
  if (dialect === 'sqlite' && url.protocol === 'sqlite:' && url.search === '') {
    const db = new DatabaseSync(decodeURIComponent(url.pathname));
    return [db, async sql => db.exec(sql), async () => db.close()];
  }
  throw new Error(`${dialect}: unsupported URI ${uri}`);
}

const [connection, exec, close] = await connect();
const now = () => new Date(Date.UTC(2026, 9, 1, 0, 0, 0));
const stop = new Error('stop');
let result;
try {
  for (const rule of CONNECTION_RULES[dialect]) await exec(rule);
  switch (action) {
    case 'apply-first':
      await applyPlans(connection, dialect, plans.slice(0, 1), now, null);
      break;
    case 'apply':
      await applyPlans(connection, dialect, plans, now, null);
      break;
    case 'recover':
      await recoverPlans(connection, dialect, plans, now, null);
      break;
    case 'stop':
      await applyPlans(connection, dialect, plans, now, event => {
        if (event.kind === 'applied' && event.plan === plans[1].name && event.step === 1) throw stop;
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
  await close();
}
console.log(result);
