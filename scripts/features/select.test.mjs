import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../tests/testcase.mjs';
import { parseSelection, selectChecks, selectionErrors, USAGE } from './select.mjs';

// manifest는 기능 둘과 helper 셋의 최소 형태다. 각 case는 인자 하나의 고른 결과를 `<feature>/<command>`로 본다(G5.111).
const manifest = {
  features: [
    { id: 'alpha', verification: [{ id: 'a1', command: 'make a1', shard: 'rust' }, { id: 'a2', command: 'make a2', shard: 'other' }] },
    { id: 'beta', verification: [{ id: 'b1', command: 'make b1', shard: 'rust' }] },
  ],
  helpers: [{ id: 'small', command: 'make small' }, { id: 'stress', command: 'make stress' }, { id: 'apply-stress', command: 'make apply-stress' }],
};
const names = argv => selectChecks(manifest, parseSelection(argv)).map(({ feature, check }) => `${feature.id}/${check.id}`);

caseTest('no selection runs every feature command and every helper check', COMPUTE, () => {
  assert.deepEqual(names(['--run']), ['alpha/a1', 'alpha/a2', 'beta/b1', 'helpers/small', 'helpers/stress', 'helpers/apply-stress']);
});

caseTest('--features runs every feature command and no helper check', COMPUTE, () => {
  assert.deepEqual(names(['--run', '--features']), ['alpha/a1', 'alpha/a2', 'beta/b1']);
});

// shard case(G5.122)는 --shard가 --features의 명령 가운데 선언한 shard가 그것인 명령만 고르는지 본다.
caseTest('--features --shard runs the feature commands of that shard only', COMPUTE, () => {
  assert.deepEqual(names(['--run', '--features', '--shard', 'rust']), ['alpha/a1', 'beta/b1']);
  assert.deepEqual(names(['--run', '--features', '--shard', 'other']), ['alpha/a2']);
  assert.deepEqual(selectionErrors(manifest, parseSelection(['--features', '--shard', 'go'])), ['unknown shard go; give one of rust, other']);
  assert.deepEqual(selectionErrors(manifest, parseSelection(['--features', '--shard', 'rust'])), []);
});

caseTest('--helpers runs every helper check but the ones of --without-helper and no feature command', COMPUTE, () => {
  assert.deepEqual(names(['--run', '--helpers']), ['helpers/small', 'helpers/stress', 'helpers/apply-stress']);
  assert.deepEqual(names(['--run', '--helpers', '--without-helper', 'stress', '--without-helper', 'apply-stress']), ['helpers/small']);
});

caseTest('--feature, --command and --helper select only what they name', COMPUTE, () => {
  assert.deepEqual(names(['--run', '--feature', 'alpha', '--command', 'a2']), ['alpha/a2']);
  assert.deepEqual(names(['--run', '--helper', 'stress', '--helper', 'apply-stress']), ['helpers/stress', 'helpers/apply-stress']);
});

caseTest('a selection that mixes the parts or names nothing is refused with the usage', COMPUTE, () => {
  for (const argv of [['--features', '--helpers'], ['--features', '--feature', 'alpha'], ['--helpers', '--helper', 'small'], ['--without-helper', 'small'],
    ['--command', 'a1'], ['--feature'], ['--helpers', '--without-helper', '--run'], ['--feature', 'alpha', '--feature', 'beta'],
    ['--shard', 'rust'], ['--helpers', '--shard', 'rust'], ['--features', '--shard'], ['--features', '--shard', 'rust', '--shard', 'other']])
    assert.throws(() => parseSelection(argv), { message: USAGE }, argv.join(' '));
});

caseTest('a selection that names a feature, command or helper absent from the manifest is an error', COMPUTE, () => {
  assert.deepEqual(selectionErrors(manifest, parseSelection(['--feature', 'gamma'])), ['unknown feature gamma']);
  assert.deepEqual(selectionErrors(manifest, parseSelection(['--feature', 'alpha', '--command', 'a9'])), ['unknown verification command alpha/a9']);
  assert.deepEqual(selectionErrors(manifest, parseSelection(['--helpers', '--without-helper', 'missing'])), ['unknown helper missing']);
  assert.deepEqual(selectionErrors(manifest, parseSelection(['--helpers', '--without-helper', 'stress'])), []);
});
