// Run PHP and TypeScript grouped-result owners twice on each database.
import { packageDirectory } from './features/packages.mts';
import { run, state, step, TIMEOUT_MS } from './physical.mts';
import { reportUnchangedState, runPhysicalCommandCase } from './physical-command-case.mts';

const databases = ['mysql', 'postgres', 'sqlite'];

for (const database of databases) {
  const key = `BENCH_${database.toUpperCase()}_DSN`;
  const dsn = process.env[key];
  if (!dsn) throw new Error(`${key} is required; run the test through its make target, which reads the environment of make orm-test-servers`);
  let before: string|undefined;
  await step(`group-rows/${database}/state`, TIMEOUT_MS, async ({ step: progress }) => {
    before = await state(database, dsn);
    progress(`state ${before}`);
  });
  for (const language of ['php', 'typescript'] as const) {
    const program = language === 'php' ? 'php' : 'node';
    const args = language === 'php'
      ? ['vendor-php/bin/phpunit', '--configuration', 'packages/php/phpunit.xml.dist', '--teamcity', 'packages/php/tests/GroupRowsDbTest.php']
      : [`${packageDirectory[language]}/tests/group_rows_db.mjs`];
    for (let attempt = 1; attempt <= 2; attempt++) {
      await step(`group-rows/${database}/${language}/${attempt}`, 2 * TIMEOUT_MS, async ({ step: progress }) => {
        const env = { ...process.env, ORM_GROUP_DATABASE: database, ORM_GROUP_DSN: dsn };
        const expected = language === 'php'
          ? { kind: 'teamcity' as const, testName: 'testGroupRows' }
          : { kind: 'predicate' as const, accepts: (output: string) =>
            /^✔ group_rows_database \([^\n]+\)$/m.test(output)
              && /^ℹ fail 0$/m.test(output)
              && !/^✖ /m.test(output) };
        await runPhysicalCommandCase(run, program, args, env, dsn, expected, `${database}/${language}/${attempt}: missing exact pass event`);
        await reportUnchangedState(() => state(database, dsn), before, `${database}/${language}/${attempt}: database state changed`, progress);
      });
    }
  }
}
