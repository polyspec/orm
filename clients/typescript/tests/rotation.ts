import { AesKeyring, BattleQuery, encodeCodec, type AesRowCodec, type UploadFileValue } from '../src/index.js';

const upload: UploadFileValue = { $type: 'upload_file', path: '/tmp/report.txt', mime: 'text/plain', name: 'report.txt' };
encodeCodec(['curlfile', 'serialize'], upload);

const codec: AesRowCodec = {
  decode(value, _styles, key) { return `${String(value)}:${key}`; },
  encode(value, _styles, key) { return `${String(value)}:${key}`; },
};
const keyring = new AesKeyring(new Map([[1, 'old'], [2, 'new']]), 2);
const result = keyring.rotateRow(
  { seq: 7, aes_key_version: 1, aes_hex_email: 'email:old', aes_hex_phone: 'phone:old' },
  'aes_key_version',
  [{ name: 'aes_hex_email', styles: ['aes', 'hex'] }, { name: 'aes_hex_phone', styles: ['aes', 'hex'] }],
  2,
  codec,
);
if (result.aes_key_version !== 2 || result.aes_hex_email !== 'email:old:old:new' || result.aes_hex_phone !== 'phone:old:old:new') {
  throw new Error('AES row rotation did not update every column');
}

const scoped = new BattleQuery().scope(7).requestShape();
if (scoped.scope_p !== 0) throw new Error('scope() did not set the tenant parameter');
