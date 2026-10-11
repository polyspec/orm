// request_hook coverage: feature-check 가 고른 database(ORM_FEATURE_DATABASE)에서 request_hook_run.mjs 의 각 case 를
// 새 case database(case-database.mjs)로 실행한다. ORM_FEATURE_DSN 의 database 는 읽거나 쓰지 않는다. 출력은 통과한
// case 의 줄뿐이다.
import { DATABASE } from '../../../tests/testcase.mjs';
import { withCaseDatabase } from './case-database.mjs';
import { featureDatabase, runCases } from './coverage_case.mjs';
import { cases, runOn } from './request_hook_run.mjs';

const coverage = {};
for (const [name, run] of Object.entries(cases)) {
  coverage[name] = async () => {
    const { driver } = featureDatabase();
    await withCaseDatabase(driver, () => {}, database => runOn(database.dsn, () => {}, run));
  };
}
await runCases('coverage_request_hook.mjs', coverage, DATABASE);
