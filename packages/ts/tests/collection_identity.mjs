// The collection key identity of tests/collection/keys.json: every value type has its own key, and a NULL key is CODEC_DECODE.
// Usage: node packages/ts/tests/collection_identity.mjs (after npm run typescript:build)
import { readFile } from 'node:fs/promises';
import * as orm from '../dist/index.js';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

const fixture = JSON.parse(await readFile(new URL('../../../tests/collection/keys.json', import.meta.url), 'utf8'));

/** The TypeScript value of one fixture entry, with the type that the client reads from a column. */
function valueOf(entry) {
  switch (entry.type) {
    case 'text':
    case 'bool':
    case 'int':
      return entry.value;
    case 'bytes':
      return Uint8Array.from(Buffer.from(entry.hex, 'hex'));
    case 'datetime':
      return new Date(entry.value);
    default:
      throw new Error(`fixture ${entry.name} has unknown type ${entry.type}`);
  }
}

// Each case is a node:test test, the form that the parity runner reads (tests/testcase.mts, caseTest).
// Requirements: PRT-35.
caseTest('collection-key/identity-from-fixture', COMPUTE, () => {
  const collection = new orm.Collection();
  const distinct = fixture.keys.filter(entry => entry.same_as === undefined);
  for (const entry of distinct) collection.put(valueOf(entry), { name: entry.name });
  if (collection.length !== distinct.length) {
    throw new Error(`collection keeps ${collection.length} of ${distinct.length} keys: two keys share an identity`);
  }
  for (const entry of fixture.keys) {
    const got = collection.get(valueOf(entry));
    const want = entry.same_as ?? entry.name;
    if (got?.name !== want) throw new Error(`key ${entry.name} reads ${got?.name}, want ${want}`);
  }
});
// Requirements: PRT-35.
caseTest('collection-key/null-is-codec-decode', COMPUTE, () => {
  try {
    new orm.Collection().put(null, {});
  } catch (error) {
    if (error.code !== fixture.null.code || error.message !== `${fixture.null.code}: ${fixture.null.message}`) throw error;
    return;
  }
  throw new Error('a NULL collection key was accepted');
});
