// The collection key identity of tests/collection/keys.json: every value type has its own key, and a NULL key is CODEC_DECODE.
// Usage: node packages/ts/tests/collection_identity.mjs (after npm run typescript:build)
import { readFile } from 'node:fs/promises';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

const fixture = JSON.parse(await readFile(new URL('../../../tests/collection/keys.json', import.meta.url), 'utf8'));
const orm = await import('../dist/index.js');
const { keyOfValues, rowKey } = await import('../dist/database.js');

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

function compositeValueOf(entry) {
  switch (entry.type) {
    case 'text':
    case 'bool':
    case 'int':
      return entry.value;
    case 'bytes':
      return Uint8Array.from(Buffer.from(entry.hex, 'hex'));
    case 'datetime':
      return new Date(entry.value);
    case 'null':
      return null;
    default:
      throw new Error(`fixture ${entry.name} has unknown composite type ${entry.type}`);
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

caseTest('collection-key/composite-typed-components', COMPUTE, () => {
  const seen = new Map();
  for (const entry of fixture.composites) {
    const values = entry.values.map(compositeValueOf);
    const before = values.map(value => value instanceof Date ? value.getTime() : undefined);
    const key = keyOfValues(values);
    if (key !== entry.encoded) throw new Error(`${entry.name}: got ${JSON.stringify(key)}, want ${JSON.stringify(entry.encoded)}`);
    if (keyOfValues(values) !== key) throw new Error(`${entry.name}: repeated key creation changed identity`);
    for (let index = 0; index < values.length; index++) {
      if (before[index] !== undefined && values[index].getTime() !== before[index]) throw new Error(`${entry.name}: datetime input was changed`);
    }
    if (entry.same_as !== undefined) {
      if (key !== seen.get(entry.same_as)) throw new Error(`${entry.name}: does not equal ${entry.same_as}`);
      continue;
    }
    for (const [other, otherKey] of seen) if (otherKey === key) throw new Error(`${entry.name}: collides with ${other}`);
    seen.set(entry.name, key);
  }
});

caseTest('collection-key/nullable-composite-row-has-no-key', COMPUTE, () => {
  const row = fixture.nullable_composite.map(compositeValueOf);
  if (rowKey(row, [{ index: 0 }, { index: 1 }]) !== undefined) throw new Error('a nullable composite row acquired a key');
});
