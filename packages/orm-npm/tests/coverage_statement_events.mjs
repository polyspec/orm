// statement_events coverage: feature-check가 고른 database(ORM_FEATURE_DATABASE)에서
// tests/events/vectors.json의 모든 case를 새 case database(case-database.mjs)로 실행하고 기대
// event와 비교한다. bench database는 읽거나 쓰지 않는다. 출력은 통과한 case의 줄뿐이다.
import { DATABASE } from '../../../tests/testcase.mjs';
import { withCaseDatabase } from './case-database.mjs';
import { featureDatabase, runCases } from './coverage_case.mjs';
import { runEventCase, vectors } from './statement-events-run.mjs';

await runCases('coverage_statement_events.mjs', {
  async statement_events() {
    const { driver } = featureDatabase();
    const failures = [];
    for (const c of vectors.cases) {
      const check = (cond, message) => { if (!cond) failures.push(`${c.id}: ${message}`); };
      await withCaseDatabase(driver, () => {}, database => runEventCase(c, driver, database.dsn, check));
    }
    if (failures.length > 0) throw new Error(failures.join('\n'));
  },
}, DATABASE);
