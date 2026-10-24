// Verify selected and unselected PHP generated fields twice on every database.
import { run, state, step, TIMEOUT_MS } from './physical.mts';
import { reportUnchangedState, runPhysicalCommandCase } from './physical-command-case.mts';

for (const database of ['mysql', 'postgres', 'sqlite']) {
  const key = `BENCH_${database.toUpperCase()}_DSN`;
  const dsn = process.env[key];
  if (!dsn) throw new Error(`${key} is required; run the test through its make target, which reads the environment of make orm-test-servers`);
  let before: string|undefined;
  await step(`unselected-column/${database}/state`, TIMEOUT_MS, async ({ step: progress }) => {
    before = await state(database, dsn);
    progress(`state ${before}`);
  });
  for (let attempt = 1; attempt <= 2; attempt++) {
    await step(`unselected-column/${database}/php/${attempt}`, 2 * TIMEOUT_MS, async ({ step: progress }) => {
      await runPhysicalCommandCase(run, 'php', ['vendor-php/bin/phpunit', '--configuration', 'packages/php/phpunit.xml.dist', '--teamcity', 'packages/php/tests/UnselectedColumnDbTest.php'], {
        ...process.env, ORM_UNSELECTED_DATABASE: database, ORM_UNSELECTED_DSN: dsn,
      }, dsn, { kind: 'teamcity', testName: 'test_unselected_column' }, `${database}/${attempt}: missing exact pass event`);
      await reportUnchangedState(() => state(database, dsn), before, `${database}/${attempt}: database state changed`, progress);
    });
  }
}
