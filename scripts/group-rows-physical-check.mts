// Run PHP and TypeScript grouped-result owners twice on each database.
import { packageDirectory } from './features/packages.mts';
import { run, state, step, TIMEOUT_MS } from './physical.mts';
import { errorMessage } from '../tests/errors.mts';

const databases = ['mysql', 'postgres', 'sqlite'];

for (const database of databases) {
  const key = `BENCH_${database.toUpperCase()}_DSN`;
  const dsn = process.env[key];
  if (!dsn) throw new Error(`${key} is required; run the test through its make target, which reads the environment of make test-servers`);
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
        let output: string;
        try { output = await run(program, args, { ...process.env, ORM_GROUP_DATABASE: database, ORM_GROUP_DSN: dsn }); }
        catch (error) { throw new Error(errorMessage(error).replaceAll(dsn, '[redacted]')); }
        // In PHPUnit's TeamCity output, a test ends with no failed or skipped test, and TypeScript tests write a CASE line
        // one.
        const finished = [...output.matchAll(/^##teamcity\[testFinished name='([^']*)'/gm)].map(match => match[1]);
        const passed = language === 'php'
          ? JSON.stringify(finished) === JSON.stringify(['test_group_rows']) && !/^##teamcity\[test(?:Failed|Ignored) /m.test(output)
          : output.trim() === `CASE group_rows_${database} PASS`;
        if (!passed) {
          throw new Error(`${database}/${language}/${attempt}: missing exact pass event`);
        }
        const after = await state(database, dsn);
        if (after !== before) throw new Error(`${database}/${language}/${attempt}: database state changed`);
        progress(`state ${after}`);
      });
    }
  }
}
