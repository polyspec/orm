// A stand-in process observes the fixture that coverage hands to its selected native case.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedEnvironment } from '../../tests/environment.mts';
import { caseTest, PROCESS } from '../../tests/testcase.mts';
import { prepared, run } from './coverage.mts';

caseTest('Rust coverage passes its declared environment and owning package to the selected native binary', PROCESS, async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orm-coverage-environment-')));
  try {
    const cwd = join(base, 'packages/rust/tests');
    mkdirSync(cwd, { recursive: true });
    const testPath = join(cwd, 'tests/case.rs');
    const binary = join(base, 'native-case.mjs');
    const program = join(base, 'fixture-program');
    writeFileSync(binary, 'console.log(JSON.stringify({zone:process.env.TZ,manifest:process.env.CARGO_MANIFEST_DIR,cwd:process.cwd(),program:process.env.ORM_PROGRAM_FIXTURE,args:process.argv.slice(2)}));\n');
    const [command] = prepared({ format: 'cargo', cwd, testPath, database: 'none', cases: ['selected'] }, {
      go: new Map(), cargoReady: Promise.resolve(),
      cargo: new Map([[cwd, { files: new Map([[testPath, [binary]]]), programs: { ORM_PROGRAM_FIXTURE: program } }]]),
    }, base, { implementations: [{ name: 'rust', runner: 'cargo', roots: ['packages/rust'], env: [{ name: 'TZ', value: 'America/New_York' }] }], units: [] });
    assert.ok(command);
    const result = await run(process.execPath, [command.program, ...command.args], command.cwd, PROCESS, isolatedEnvironment({ TZ: 'UTC', ...command.env }));
    assert.equal(result.error ?? null, null, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), { zone: 'America/New_York', manifest: cwd, cwd, program, args: ['--test-threads=1'] });
  } finally { rmSync(base, { recursive: true, force: true }); }
});
