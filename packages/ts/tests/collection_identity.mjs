// The collection key identity of tests/collection/keys.json: every value type has its own key, and a NULL key is CODEC_DECODE.
// Usage: node packages/ts/tests/collection_identity.mjs (after npm run typescript:build)
import { readFile } from 'node:fs/promises';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

const fixture = JSON.parse(await readFile(new URL('../../../tests/collection/keys.json', import.meta.url), 'utf8'));
const orm = await import('../dist/index.js');
const { keyOfValues, rowKey } = await import('../dist/database.js');

/** The TypeScript value of one fixture entry, with the type that the client reads from a column. */
function valueOf(entry, allowNull = false) {
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
      if (allowNull) return null;
      break;
    default:
      break;
  }
  const kind = allowNull ? 'unknown composite type' : 'unknown type';
  throw new Error(`fixture ${entry.name} has ${kind} ${entry.type}`);
}

function compositeValueOf(entry) {
  return valueOf(entry, true);
}

// Requirements: INT-62, PLN-6, INT-81, INT-82, INT-83, INT-84, INT-85.
caseTest('collection-views/preserve-order-and-connect-every-model', COMPUTE, () => {
  const connections = [];
  const makeModel = label => ({
    connect(db) { connections.push([label, db]); return this; },
    toArray() { return { label }; },
  });
  const first = makeModel('first');
  const second = makeModel('second');
  const collection = new orm.Collection();
  collection.put(7, first);
  collection.put('7', second);
  if (collection.length !== 2) throw new Error(`length is ${collection.length}, want 2`);
  if (collection.first() !== first) throw new Error('first did not return the first inserted model');
  if (collection.get(7) !== first || collection.get('7') !== second) throw new Error('lookup did not preserve key type and value');
  if (JSON.stringify(collection.keys()) !== JSON.stringify([7, '7'])) throw new Error('keys lost collection order or key type');
  if (JSON.stringify(collection.values()) !== JSON.stringify([first, second])) throw new Error('values lost collection order');
  if (JSON.stringify(collection.entries()) !== JSON.stringify([[7, first], ['7', second]])) throw new Error('entries lost key/model order');
  if (JSON.stringify(collection.toArray()) !== JSON.stringify([{ label: 'first' }, { label: 'second' }])) throw new Error('toArray lost model order');
  const db = {};
  if (collection.connect(db) !== collection) throw new Error('connect did not return the collection');
  if (JSON.stringify(connections) !== JSON.stringify([['first', db], ['second', db]])) throw new Error('connect did not reach every model in order');
});

// Each case is a node:test test, the form that the parity runner reads (tests/testcase.mts, caseTest).
// Requirements: PRT-35.
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
