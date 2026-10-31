// codec_case.mjs holds the helpers of the AES binding files: check, which runs one case as a top-level test and fails it
// with every problem its body finds, and the AES read fixtures.
import { hostEncode } from '../dist/index.js';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

// check runs the checks of one case, which push each problem they find to the list it is given, and fails the case with
// every problem.
export const check = (name, body) => caseTest(name, COMPUTE, async () => {
  const wrong = [];
  await body(wrong);
  if (wrong.length > 0) throw new Error(`${name}:\n${wrong.join('\n')}`);
});

// The AES read cases share one encrypted email cell under the old key and the assemble of an Account that selects it with
// its key version column.
export const aesOldKeyCipher = () => hostEncode('value', ['aes', 'hex'], 'old-key');
export const aesAccountAssemble = () => ({
  entity: 'Account', alias: 'a', key: [], children: [], aes_version: 1,
  columns: [
    { index: 0, name: 'email', column: 'email', typ: 'string', styles: ['aes', 'hex'] },
    { index: 1, name: 'aes_key_version', column: 'aes_key_version', typ: 'i32', styles: [] },
  ],
});
