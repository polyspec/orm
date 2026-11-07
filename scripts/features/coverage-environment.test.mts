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

caseTest('Rust recipe coverage selects the declared entry without deriving a symbol from its file name', PROCESS, async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orm-coverage-selector-')));
  try {
    const cwd = join(base, 'packages/rust/tests');
    mkdirSync(cwd, { recursive: true });
    const testPath = join(cwd, 'tests/shared.rs');
    const binary = join(base, 'native-case.mjs');
    writeFileSync(binary, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    const [command] = prepared({ format: 'cargo', cwd, testPath, recipe: 'tests/recipes/data.json', database: 'none', cases: ['selected'] }, {
      go: new Map(), cargoReady: Promise.resolve(),
      cargo: new Map([[cwd, { files: new Map([[testPath, [binary]]]), programs: {} }]]),
    }, base, { implementations: [{ name: 'rust', runner: 'cargo', roots: ['packages/rust'] }], units: [
      { id: 'logical-unit', kind: 'suite', file: 'tests/recipes/data.json', bindings: [
        { implementation: 'rust', test: 'packages/rust/tests/tests/shared.rs', symbol: 'explicit_entry' },
      ] },
      { id: 'different-test', kind: 'suite', file: 'tests/recipes/data.json', bindings: [
        { implementation: 'rust', test: 'packages/rust/tests/tests/other.rs', symbol: 'unrelated_explicit_entry' },
      ] },
      { id: 'different-runtime', kind: 'suite', file: 'tests/recipes/data.json', bindings: [
        { implementation: 'go', test: 'packages/rust/tests/tests/shared.rs', symbol: 'unrelated_explicit_entry' },
      ] },
      { id: 'other-unit', kind: 'suite', file: 'tests/recipes/other.json', bindings: [
        { implementation: 'rust', test: 'packages/rust/tests/tests/shared.rs', symbol: 'other_entry' },
      ] },
    ] });
    assert.ok(command);
    const result = await run(process.execPath, [command.program, ...command.args], command.cwd, PROCESS, isolatedEnvironment(command.env));
    assert.equal(result.error ?? null, null, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), ['--test-threads=1', 'explicit_entry::']);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

caseTest('Rust recipe coverage rejects absent, ambiguous and overlapping entry bindings before execution', PROCESS, () => {
  const root = '/declared-checkout';
  const cwd = join(root, 'packages/rust/tests');
  const testPath = join(cwd, 'tests/shared.rs');
  const recipe = 'tests/recipes/data.json';
  const spec = { format: 'cargo' as const, cwd, testPath, recipe, database: 'none', cases: ['selected'] };
  const builds = { go: new Map(), cargoReady: Promise.resolve(), cargo: new Map([[cwd, {
    files: new Map([[testPath, ['/native-binary']]]), programs: {},
  }]]) };
  const implementations = [{ name: 'rust', runner: 'cargo', roots: ['packages/rust'] }];
  const binding = { implementation: 'rust', test: 'packages/rust/tests/tests/shared.rs', symbol: 'invalid_none' };
  const unit = { id: 'selected', kind: 'suite', file: recipe, bindings: [binding] };
  assert.throws(() => prepared(spec, builds, root, { implementations, units: [] }), /Rust recipe.*no unique.*binding/);
  assert.throws(() => prepared(spec, builds, root, { implementations, units: [unit, { ...unit, id: 'duplicate' }] }), /Rust recipe.*no unique.*binding/);
  assert.throws(() => prepared(spec, builds, root, { implementations, units: [{ ...unit, bindings: [{ ...binding, symbol: '' }] }] }), /Rust recipe.*no unique.*binding/);
  assert.throws(() => prepared(spec, builds, root, { implementations, units: [unit, {
    id: 'other', kind: 'suite', file: 'tests/recipes/other.json', bindings: [{ ...binding, symbol: 'dbspec_plan_invalid_none' }],
  }] }), /Rust recipe.*selector.*also selects.*other/);
});
