// Verify selected and unselected PHP generated fields twice on every database.
import { run, state, step, TIMEOUT_MS } from './physical.mts';
import { errorMessage } from '../tests/errors.mts';

for (const database of ['mysql', 'postgres', 'sqlite']) {
  const key = `BENCH_${database.toUpperCase()}_DSN`;
  const dsn = process.env[key];
  if (!dsn) throw new Error(`${key} is required; run the test through its make target, which reads the environment of make test-servers`);
  let before: string|undefined;
  await step(`unselected-column/${database}/state`, TIMEOUT_MS, async ({ step: progress }) => {
    before = await state(database, dsn);
    progress(`state ${before}`);
  });
  for (let attempt = 1; attempt <= 2; attempt++) {
    await step(`unselected-column/${database}/php/${attempt}`, 2 * TIMEOUT_MS, async ({ step: progress }) => {
      let output: string;
      try {
        output = await run('php', ['vendor-php/bin/phpunit', '--configuration', 'packages/php/phpunit.xml.dist', '--teamcity', 'packages/php/tests/UnselectedColumnDbTest.php'], {
          ...process.env, ORM_UNSELECTED_DATABASE: database, ORM_UNSELECTED_DSN: dsn,
        });
      } catch (error) { throw new Error(errorMessage(error).replaceAll(dsn, '[redacted]')); }
      // PHPUnit의 TeamCity 출력에서 test 하나가 끝나고 실패하거나 건너뛴 test가 없어야 한다.
      const finished = [...output.matchAll(/^##teamcity\[testFinished name='([^']*)'/gm)].map(match => match[1]);
      if (JSON.stringify(finished) !== JSON.stringify(['test_unselected_column']) || /^##teamcity\[test(?:Failed|Ignored) /m.test(output)) {
        throw new Error(`${database}/${attempt}: missing exact pass event`);
      }
      const after = await state(database, dsn);
      if (after !== before) throw new Error(`${database}/${attempt}: database state changed`);
      progress(`state ${after}`);
    });
  }
}
