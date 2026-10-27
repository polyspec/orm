import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isolatedEnvironment } from '../environment.mts';
import { PROCESS, caseTest, withTemporaryDirectory } from '../testcase.mts';

const root = resolve(import.meta.dirname, '../..');
const buildScript = join(root, 'packages/php-ext/scripts/build.sh');

function installFakeKit(checkout: string, source: string): string {
  const kitRoot = join(checkout, 'node_modules/@polyspec/kit');
  mkdirSync(join(kitRoot, 'scripts'), { recursive: true });
  writeFileSync(join(kitRoot, 'package.json'), JSON.stringify({
    name: '@polyspec/kit',
    type: 'module',
    exports: { './php-extension': './scripts/php-extension.mjs' },
  }));
  const script = join(kitRoot, 'scripts/php-extension.mjs');
  writeFileSync(script, source);
  return script;
}

function initCheckout(checkout: string): string {
  const packageRoot = join(checkout, 'packages/php-ext');
  mkdirSync(join(packageRoot, 'scripts'), { recursive: true });
  writeFileSync(join(packageRoot, 'scripts/build.sh'), readFileSync(buildScript));
  const git = spawnSync('git', ['init', '--quiet', checkout], { encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  return packageRoot;
}

caseTest('the PHP extension wrapper resolves the installed public Kit CLI and preserves build arguments', PROCESS, async ({ signal }) => {
  await withTemporaryDirectory('orm-php-extension-installed-kit-', temporary => {
    const checkout = join(temporary, 'checkout');
    const packageRoot = initCheckout(checkout);
    const kitScript = installFakeKit(checkout, `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.KIT_CLI_PROOF, JSON.stringify({ file: import.meta.filename, args: process.argv.slice(2) }));
`);
    const env = isolatedEnvironment({
      PATH: process.env.PATH ?? '',
      TMPDIR: temporary,
      KIT_CLI_PROOF: join(temporary, 'cli-proof.json'),
    });
    const proofPath = join(temporary, 'cli-proof.json');
    const output = 'extension/polyspec_orm.so';
    const expectedOutput = join(realpathSync(temporary), output);
    for (const mode of ['release', 'native-test'] as const) {
      const args = mode === 'release' ? [join(packageRoot, 'scripts/build.sh'), output] : [join(packageRoot, 'scripts/build.sh'), output, mode];
      const result = spawnSync('sh', args, { cwd: temporary, env, encoding: 'utf8', signal });
      assert.equal(result.error, undefined, `build script could not start: ${result.error?.message ?? ''}`);
      assert.equal(result.status, 0, result.stderr);
      const proof = JSON.parse(readFileSync(proofPath, 'utf8')) as { file: string; args: string[] };
      assert.equal(proof.file, realpathSync(kitScript));
      assert.deepEqual(proof.args.slice(0, 3), ['build', '--output', expectedOutput]);
      assert.equal(proof.args[3], '--configure-arg');
      if (mode === 'release') {
        assert.deepEqual(proof.args.slice(4), ['--disable-polyspec-orm-native-test']);
      } else {
        assert.deepEqual(proof.args.slice(4), [
          '--enable-polyspec-orm-native-test',
          '--source-copy',
          'packages/php-ext/testing/native/module.c',
          'src/native_test.c',
        ]);
      }
    }
  });
});

caseTest('the PHP extension build failure keeps warnings and the make cause without publishing', PROCESS, async ({ signal }) => {
  await withTemporaryDirectory('orm-php-extension-build-logs-', temporary => {
    const checkout = join(temporary, 'checkout');
    const packageRoot = initCheckout(checkout);
    const proofPath = join(temporary, 'cli-proof.json');
    const kitScript = installFakeKit(checkout, `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.KIT_CLI_PROOF, JSON.stringify({ file: import.meta.filename, args: process.argv.slice(2) }));
console.error('fixture.c:12:3: warning: retained warning');
console.error("make: *** No rule to make target 'missing-target'. Stop.");
process.exit(1);
`);
    const output = join(temporary, 'polyspec_orm.so');
    const previousArtifact = 'previous extension artifact';
    writeFileSync(output, previousArtifact);
    const env = isolatedEnvironment({
      PATH: process.env.PATH ?? '',
      TMPDIR: temporary,
      KIT_CLI_PROOF: proofPath,
    });
    const result = spawnSync('sh', [join(packageRoot, 'scripts/build.sh'), output], { cwd: checkout, env, encoding: 'utf8', signal });
    assert.equal(result.error, undefined, `build script could not start: ${result.error?.message ?? ''}`);

    const failures: string[] = [];
    if (result.status !== 1) failures.push(`build script exit = ${result.status}, want 1`);
    if (!result.stderr.includes('fixture.c:12:3: warning: retained warning')) failures.push(`warning is missing from stderr: ${result.stderr}`);
    if (!result.stderr.includes("No rule to make target 'missing-target'")) failures.push(`make cause is missing from stderr: ${result.stderr}`);
    const proof = JSON.parse(readFileSync(proofPath, 'utf8')) as { file: string; args: string[] };
    if (proof.file !== realpathSync(kitScript)) failures.push(`resolved Kit CLI = ${proof.file}, want installed package file ${realpathSync(kitScript)}`);
    if (!proof.args.includes('--disable-polyspec-orm-native-test')) failures.push(`release build option was not passed to Kit: ${proof.args.join(' ')}`);
    if (readFileSync(output, 'utf8') !== previousArtifact) failures.push('the previous published artifact changed');
    if (readdirSync(temporary).some(name => name.startsWith('polyspec_orm.so.build.'))) failures.push('the failed build directory remains');
    if (readdirSync(temporary).some(name => name.startsWith('polyspec_orm.so.tmp.'))) failures.push('the publish temporary file remains');
    assert.deepEqual(failures, []);
  });
});
