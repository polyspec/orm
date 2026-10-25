// Requirements: COD-44.
// The codes of AES key-version failures: an undeclared key version is CONFIG, a stored version that is not a positive
// i32 is CODEC_DECODE on the read path and on the rotation path, and an AES column the client selected but did not
// get is INTERNAL.
import { AesKeyring, OrmError, hostEncode } from '../dist/index.js';
import { decodeAssembly } from '../dist/database.js';
import { check } from './codec_case.mjs';

const keyring = new AesKeyring(new Map([[1, 'old-key'], [2, 'new-key']]), 2);
// Requirements: INT-74, INT-130.
check('aes keyring: versions are ascending and current version is retained', wrong => {
  const ring = new AesKeyring(new Map([[3, 'third'], [1, 'first'], [2, 'second']]), 2);
  if (JSON.stringify(ring.versions()) !== JSON.stringify([1, 2, 3])) wrong.push(`versions ${JSON.stringify(ring.versions())} are not ascending`);
  if (ring.currentVersion !== 2) wrong.push(`current version ${ring.currentVersion}, want 2`);
});
const db = { aesKeyring: keyring, aesKey: 'new-key' };
const cipher = hostEncode('value', ['aes', 'hex'], 'old-key');
const assemble = {
  entity: 'Account', alias: 'a', key: [], children: [], aes_version: 1,
  columns: [
    { index: 0, name: 'email', column: 'email', typ: 'string', styles: ['aes', 'hex'] },
    { index: 1, name: 'aes_key_version', column: 'aes_key_version', typ: 'i32', styles: [] },
  ],
};
const codeOf = run => {
  try {
    run();
    return '';
  } catch (error) {
    return error instanceof OrmError ? error.code : String(error);
  }
};
const cases = [
  // Requirements: COD-49. Non-integer stored version text fails on the read path.
  ['read: stored version is text that is not an integer', [cipher, 'abc'], 'CODEC_DECODE'],
  // Requirements: COD-50. Zero is not an accepted stored key version.
  ['read: stored version is zero', [cipher, 0], 'CODEC_DECODE'],
  // Requirements: COD-51. Stored versions above positive i32 fail decoding.
  ['read: stored version is above i32', [cipher, 2147483648], 'CODEC_DECODE'],
  // Requirements: COD-52. An undeclared stored version fails with CONFIG.
  ['read: stored version is an undeclared integer', [cipher, 9], 'CONFIG'],
  // Requirements: COD-53. Positive integer text is decoded as that version.
  ['read: stored version written as text decodes', [cipher, '1'], ''],
  ['read: stored version read as a bigint decodes', [cipher, 1n], ''],
  ['read: stored version read as a bigint above i32', [cipher, 2147483648n], 'CODEC_DECODE'],
];
for (const [name, row, want] of cases) {
  check(`aes version codes: ${name}`, wrong => {
    const got = codeOf(() => decodeAssembly([...row], assemble, db));
    if (got !== want) wrong.push(`got ${got || 'no error'}, want ${want || 'no error'}`);
  });
}
// Requirements: COD-56. A read plan cannot infer a missing version column.
check('aes version codes: read: plan has an AES column and no version column', wrong => {
  const noVersion = { ...assemble, aes_version: undefined };
  const got = codeOf(() => decodeAssembly([cipher, 1], noVersion, db));
  if (got !== 'INTERNAL') wrong.push(`got ${got || 'no error'}, want INTERNAL`);
});
// Requirements: COD-57. The stored-version keyring entry is required even when a single key could decrypt the value.
check('aes version codes: read: keyring lacks the stored version is CONFIG, not the single key', wrong => {
  const single = hostEncode('value', ['aes', 'hex'], 'single-key');
  const got = codeOf(() => decodeAssembly([single, 9], assemble, { aesKeyring: keyring, aesKey: 'single-key' }));
  if (got !== 'CONFIG') wrong.push(`got ${got || 'no error'}, want CONFIG`);
});
// Requirements: COD-58. A non-NULL encrypted value cannot use a NULL stored version.
check('aes version codes: read: NULL stored version with an AES value is CODEC_DECODE', wrong => {
  const got = codeOf(() => decodeAssembly([cipher, null], assemble, db));
  if (got !== 'CODEC_DECODE') wrong.push(`got ${got || 'no error'}, want CODEC_DECODE`);
});
// Requirements: COD-59. A NULL encrypted value with a NULL version stays NULL without version lookup.
check('aes version codes: read: NULL AES value with NULL version stays NULL', wrong => {
  const row = [null, null];
  const got = codeOf(() => decodeAssembly(row, assemble, db));
  if (got !== '' || row[0] !== null) wrong.push(`got ${got || 'no error'} and ${row[0]}, want NULL`);
});
// Requirements: COD-54. Rotation rejects the same zero stored version as the read path.
check('aes version codes: rotation: stored version is zero', wrong => {
  const got = codeOf(() => keyring.rotateRow({ aes_key_version: 0, email: cipher }, 'aes_key_version', [{ name: 'email', styles: ['aes', 'hex'] }], 2, undefined));
  if (got !== 'CODEC_DECODE') wrong.push(`got ${got || 'no error'}, want CODEC_DECODE`);
});
// Requirements: COD-60. Rotation leaves NULL encrypted cells unchanged for either stored version.
check('aes version codes: rotation: NULL AES value is left unchanged with a NULL or a valid version', wrong => {
  const columns = [{ name: 'email', styles: ['aes', 'hex'] }];
  for (const row of [{ aes_key_version: null, email: null }, { aes_key_version: 1, email: null }]) {
    const got = codeOf(() => {
      const out = keyring.rotateRow({ ...row }, 'aes_key_version', columns, 2, undefined);
      if (JSON.stringify(out) !== JSON.stringify(row)) wrong.push(`${JSON.stringify(row)} rotated to ${JSON.stringify(out)}`);
    });
    if (got !== '') wrong.push(`${JSON.stringify(row)}: got ${got}, want no error`);
  }
});
// Requirements: COD-55. Rotation rejects a selected AES column missing from its row.
check('aes version codes: rotation: AES column missing from the row', wrong => {
  const got = codeOf(() => keyring.rotateRow({ aes_key_version: 1 }, 'aes_key_version', [{ name: 'email', styles: ['aes', 'hex'] }], 2, undefined));
  if (got !== 'INTERNAL') wrong.push(`got ${got || 'no error'}, want INTERNAL`);
});
