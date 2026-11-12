// Requirements: COD-48, COD-55, COD-56 (native, FCV-2): a selected row without its version cell, a rotation row without
// its AES column, and a read plan without its version column are INTERNAL. The other AES version codes are recipe cases.
import { AesKeyring, OrmError } from '../dist/index.js';
import { decodeAssembly } from '../dist/database.js';
import { aesAccountAssemble, aesOldKeyCipher, check } from './codec_case.mjs';

const keyring = new AesKeyring(new Map([[1, 'old-key'], [2, 'new-key']]), 2);
const db = { aesKeyring: keyring, aesKey: 'new-key' };
const cipher = aesOldKeyCipher();
const assemble = aesAccountAssemble();
const codeOf = run => {
  try {
    run();
    return '';
  } catch (error) {
    return error instanceof OrmError ? error.code : String(error);
  }
};
// Requirements: COD-56. A read plan cannot infer a missing version column.
check('aes version codes: read: plan has an AES column and no version column', wrong => {
  const noVersion = { ...assemble, aes_version: undefined };
  const got = codeOf(() => decodeAssembly([cipher, 1], noVersion, db));
  if (got !== 'INTERNAL') wrong.push(`got ${got || 'no error'}, want INTERNAL`);
});
// Requirements: COD-55. Rotation rejects a selected AES column or version column missing from its row.
check('aes version codes: rotation: AES column missing from the row', wrong => {
  const columns = [{ name: 'email', styles: ['aes', 'hex'] }];
  for (const row of [{ aes_key_version: 1 }, { email: cipher }]) {
    const got = codeOf(() => keyring.rotateRow({ ...row }, 'aes_key_version', columns, 2, undefined));
    if (got !== 'INTERNAL') wrong.push(`${JSON.stringify(row)}: got ${got || 'no error'}, want INTERNAL`);
  }
});
