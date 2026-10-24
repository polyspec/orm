import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { isolatedEnvironment } from '../environment.mts';
import { PROCESS, caseTest, withTemporaryDirectory } from '../testcase.mts';

const root = resolve(import.meta.dirname, '../..');
const buildScript = join(root, 'packages/php-ext/scripts/build.sh');

caseTest('the PHP extension build failure keeps warnings and the make cause without publishing', PROCESS, async ({ signal }) => {
  await withTemporaryDirectory('orm-php-extension-build-logs-', temporary => {
    const bin = join(temporary, 'bin');
    mkdirSync(bin);
    const phpize = join(bin, 'phpize');
    const phpConfig = join(bin, 'php-config');
    const make = join(bin, 'make');
    writeFileSync(phpize, `#!/bin/sh
cat > configure <<'CONFIGURE'
#!/bin/sh
exit 0
CONFIGURE
chmod +x configure
`);
    writeFileSync(phpConfig, '#!/bin/sh\nprintf "%s\\n" "8.4.27"\n');
    writeFileSync(make, `#!/bin/sh
printf '%s\\n' 'fixture.c:12:3: warning: retained warning' "make: *** No rule to make target 'missing-target'. Stop."
exit 2
`);
    for (const executable of [phpize, phpConfig, make]) chmodSync(executable, 0o755);

    const output = join(temporary, 'polyspec_orm.so');
    const previousArtifact = 'previous extension artifact';
    writeFileSync(output, previousArtifact);
    const env = isolatedEnvironment({
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      TMPDIR: temporary,
    });
    const result = spawnSync('sh', [buildScript, output], { cwd: root, env, encoding: 'utf8', signal });
    assert.equal(result.error, undefined, `build script could not start: ${result.error?.message ?? ''}`);

    const failures: string[] = [];
    if (result.status !== 1) failures.push(`build script exit = ${result.status}, want 1`);
    if (!result.stderr.includes('fixture.c:12:3: warning: retained warning')) failures.push(`warning is missing from stderr: ${result.stderr}`);
    if (!result.stderr.includes("No rule to make target 'missing-target'")) failures.push(`make cause is missing from stderr: ${result.stderr}`);
    if (readFileSync(output, 'utf8') !== previousArtifact) failures.push('the previous published artifact changed');
    if (readdirSync(temporary).some(name => name.startsWith('polyspec_orm.so.build.'))) failures.push('the failed build directory remains');
    if (readdirSync(temporary).some(name => name.startsWith('polyspec_orm.so.tmp.'))) failures.push('the publish temporary file remains');
    assert.deepEqual(failures, []);
  });
});
