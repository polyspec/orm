// The collection key identity of tests/collection/keys.json: every value type has its own key, and a NULL key is CODEC_DECODE.
// Usage: node packages/ts/tests/collection_identity.mjs (after npm run typescript:build)
import { readFile } from 'node:fs/promises';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

const fixture = JSON.parse(await readFile(new URL('../../../tests/collection/keys.json', import.meta.url), 'utf8'));
const orm = await import('../dist/index.js');
const databaseModule = await import('../dist/database.js');
const { keyOfValues, rowKey } = databaseModule;

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

// A Date stops at the millisecond, so the key of a datetime column holds the whole instant in toJSON (INT-11): only TypeScript
// has this form.
caseTest('collection-key/datetime-key-holds-its-microseconds', COMPUTE, () => {
  const { DatetimeKey, keyText } = databaseModule;
  const first = new DatetimeKey('2026-10-18 09:30:00.000010');
  const second = new DatetimeKey('2026-10-18 09:30:00.000011');
  if (!(first instanceof Date)) throw new Error('a datetime key is not a Date');
  if (first.toJSON() !== '2026-10-18T09:30:00.00001Z') throw new Error(`toJSON gave ${first.toJSON()}`);
  if (first.getTime() !== Date.UTC(2026, 9, 18, 9, 30, 0, 0)) throw new Error('the Date value is not the instant cut to the millisecond');
  if (keyText(first) === keyText(second)) throw new Error('two microseconds of one millisecond have one key');
  if (keyText(new DatetimeKey('2026-10-18 09:30:00.120')) !== keyText(new Date('2026-10-18T09:30:00.120Z'))) throw new Error('a whole millisecond differs from its Date');
  if (keyText(first) === keyText(new Date('2026-10-18T09:30:00.000Z'))) throw new Error('a Date is the key of a finer instant');
});

caseTest('collection-key/nullable-composite-row-has-no-key', COMPUTE, () => {
  const row = fixture.nullable_composite.map(compositeValueOf);
  if (rowKey(row, [{ index: 0 }, { index: 1 }]) !== undefined) throw new Error('a nullable composite row acquired a key');
});
