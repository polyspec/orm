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

// Requirements: PLN-6, INT-81, INT-82, INT-83, INT-84, INT-85.
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
  if (JSON.stringify(collection.keys()) !== JSON.stringify([7, '7'])) throw new Error('keys lost collection order or key type');
  if (JSON.stringify(collection.values()) !== JSON.stringify([first, second])) throw new Error('values lost collection order');
  if (JSON.stringify(collection.entries()) !== JSON.stringify([[7, first], ['7', second]])) throw new Error('entries lost key/model order');
  if (JSON.stringify(collection.toArray()) !== JSON.stringify([{ label: 'first' }, { label: 'second' }])) throw new Error('toArray lost model order');
  const db = {};
  if (collection.connect(db) !== collection) throw new Error('connect did not return the collection');
  if (JSON.stringify(connections) !== JSON.stringify([['first', db], ['second', db]])) throw new Error('connect did not reach every model in order');
});

// Requirements: INT-80, INT-86.
caseTest('collection/get-fetched-value-use-typed-key', COMPUTE, () => {
  const collection = new orm.Collection();
  const integer = { label: 'integer' };
  const text = { label: 'text' };
  collection.put(7, integer, 'integer');
  collection.put('7', text, 'text');
  if (collection.get(7) !== integer || collection.get('7') !== text || collection.get(8) !== undefined) {
    throw new Error('get did not preserve the key type or missing-key result');
  }
  if (collection.fetched(7) !== 'integer' || collection.fetched('7') !== 'text' || collection.fetched(8) !== undefined) {
    throw new Error('fetched value did not preserve the key type or missing-key result');
  }
});

// Requirements: INT-88, INT-89.
caseTest('model-terminal/returns-first-builder-error', COMPUTE, async () => {
  const model = new orm.Author();
  model.limit(-1, 1).limit(0, 0);
  try {
    await model.getCount();
  } catch (error) {
    if (error instanceof orm.OrmError && error.code === 'CONFIG' && error.message === 'CONFIG: limit requires a non-negative offset and a positive count') return;
    throw error;
  }
  throw new Error('the terminal returned without the recorded builder error');
});

// Each case is a node:test test, the form that the parity runner reads (tests/testcase.mts, caseTest).
// Requirements: INT-11, PRT-35.
caseTest('collection-key/identity-from-fixture', COMPUTE, () => {
  const collection = new orm.Collection();
  const distinct = fixture.keys.filter(entry => entry.same_as === undefined);
  const expectedKeys = distinct.map(valueOf);
  for (let index = 0; index < distinct.length; index++) {
    const entry = distinct[index];
    collection.put(expectedKeys[index], { name: entry.name });
  }
  if (collection.length !== distinct.length) {
    throw new Error(`collection keeps ${collection.length} of ${distinct.length} keys: two keys share an identity`);
  }
  for (const entry of fixture.keys) {
    const got = collection.get(valueOf(entry));
    const want = entry.same_as ?? entry.name;
    if (got?.name !== want) throw new Error(`key ${entry.name} reads ${got?.name}, want ${want}`);
  }
  const actualKeys = collection.keys();
  if (actualKeys.length !== expectedKeys.length) throw new Error('collection keys lost a fixture key');
  for (let index = 0; index < expectedKeys.length; index++) {
    const got = actualKeys[index];
    const want = expectedKeys[index];
    const equal = want instanceof Date
      ? got instanceof Date && got.getTime() === want.getTime()
      : want instanceof Uint8Array
        ? got instanceof Uint8Array && Buffer.from(got).equals(Buffer.from(want))
        : typeof got === typeof want && Object.is(got, want);
    if (!equal) throw new Error(`collection key ${index} changed native type or value`);
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
