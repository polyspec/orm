// Requirements: COD-48.
// A selected AES row without its version cell violates the read plan's invariant.
import { OrmError, hostEncode, AesKeyring } from '../dist/index.js';
import { decodeAssembly } from '../dist/database.js';
import { check } from './codec_case.mjs';

const cipher = hostEncode('value', ['aes', 'hex'], 'old-key');
const assemble = {
  entity: 'Account', alias: 'a', key: [], children: [], aes_version: 1,
  columns: [
    { index: 0, name: 'email', column: 'email', typ: 'string', styles: ['aes', 'hex'] },
    { index: 1, name: 'aes_key_version', column: 'aes_key_version', typ: 'i32', styles: [] },
  ],
};
const db = { aesKeyring: new AesKeyring(new Map([[1, 'old-key']]), 1), aesKey: 'old-key' };

check('aes-read-row-without-version-cell: selected encrypted row without its version cell is INTERNAL', wrong => {
  try {
    decodeAssembly([cipher], assemble, db);
    wrong.push('missing version cell was accepted');
  } catch (error) {
    if (!(error instanceof OrmError) || error.code !== 'INTERNAL')
      wrong.push(`got ${error instanceof OrmError ? error.code : String(error)}, want INTERNAL`);
  }
});
