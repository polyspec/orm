// statement_events coverage: feature-check가 고른 database(ORM_FEATURE_DATABASE)에서
// tests/events/vectors.json의 모든 case를 새 case database(case-database.mjs)로 실행하고 기대
// event와 비교한다. bench database는 읽거나 쓰지 않는다. 출력은 통과한 case의 줄뿐이다.
// case ID 없이(parity check의 node --test) 실행하면 vectors.json의 case마다 그 ID의 test가
// MySQL, PostgreSQL, SQLite에서 각각 새 case database로 그 case를 실행한다.
import { DATABASE } from '../../../tests/testcase.mts';
import { withCaseDatabase } from './case-database.mjs';
import { featureDatabase, runCases } from './coverage_case.mjs';
import { runEventCase, vectors } from './statement-events-run.mjs';

/** Runs case c on a new case database of each dialect and fails with every check that failed. */
async function runOn(c, dialects) {
  const failures = [];
  for (const driver of dialects) {
    const check = (cond, message) => { if (!cond) failures.push(`${c.id}/${driver}: ${message}`); };
    await withCaseDatabase(driver, () => {}, database => runEventCase(c, driver, database.dsn, check));
  }
  if (failures.length > 0) throw new Error(failures.join('\n'));
}

await runCases('coverage_statement_events.mjs', {
  async statement_events() {
    const { driver } = featureDatabase();
    const failures = [];
    for (const c of vectors.cases) {
      try { await runOn(c, [driver]); } catch (error) { failures.push(error.message); }
    }
    if (failures.length > 0) throw new Error(failures.join('\n'));
  },
}, DATABASE, Object.fromEntries(vectors.cases.map(c => [c.id, () => runOn(c, ['mysql', 'postgres', 'sqlite'])])));
