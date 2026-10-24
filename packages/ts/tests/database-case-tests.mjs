import { caseTest } from '../../../tests/testcase.mts';

/** Registers selected database cases for each dialect and accounts for assertion failures per case. */
export function registerDatabaseCases({ feature, cases, args = process.argv.slice(2), environment = process.env, deadline, withDatabase, getFailures, setCurrent, runCase, register = caseTest }) {
  const selected = args.length > 0 ? args : Object.keys(cases);
  for (const env of ['ORM_TEST_MYSQL_DSN', 'ORM_TEST_POSTGRES_DSN']) {
    if (!environment[env]) throw new Error(`${env} is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers`);
  }
  for (const name of selected) {
    const run = cases[name];
    if (run === undefined) throw new Error(`unknown case ${name}`);
    for (const driver of ['sqlite', 'mysql', 'postgres']) {
      register(`${feature}/${name}/${driver}`, deadline, async ({ step }) => {
        const before = getFailures();
        setCurrent(`${name}/${driver}`);
        await withDatabase(driver, step, database => runCase(run, name, driver, database));
        if (getFailures() > before) throw new Error(`${getFailures() - before} check(s) failed; each FAIL line above names one`);
      });
    }
  }
}
