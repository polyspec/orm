// cases.mjs reads tests/dbspec/cases.json strictly, as the Go reader does (engine/dbspec/vectors_test.go
// decodeCaseVectors): every section and every field of the format must be present with its type, and a section or
// field the format does not name is refused. A refused value is the error "<file>: <location> <problem>".
import { readFileSync } from 'node:fs';

const NAME = 'tests/dbspec/cases.json';

// A field type is a scalar name, [type] for an array of type, or an object schema whose keys are the fields; a key
// ending in "?" is an optional field.
const ERROR = { line: 'integer', column: 'integer', rule: 'string' };
const LINE_ENDS = { 'crlf?': 'boolean', 'mixed?': 'boolean' };
const DOCUMENT = { id: 'string', documents: 'linesMap', main: 'string', ...LINE_ENDS };
const SCHEMA = {
  version: 'integer',
  note: 'string',
  canonical: [DOCUMENT],
  normalize: [{ ...DOCUMENT, canonical: 'lines' }],
  invalid: [{ ...DOCUMENT, errors: [ERROR] }],
  hashes: [{ id: 'string', documents: 'linesMap', manifestText: 'lines', schemaText: 'lines', manifestHash: 'string', schemaHash: 'string' }],
  sets: [{
    id: 'string', documents: ['lines'], parsing: 'linesMap', errors: [ERROR], 'external?': ['lines'],
    'manifest?': { manifestText: 'lines', externalText: 'lines', schemaText: 'lines', created: 'lines', manifestHash: 'string', schemaHash: 'string' },
  }],
  files: [{ id: 'string', path: 'string', errors: [ERROR] }],
  positions: [{ id: 'string', documents: 'linesMap', main: 'string', positions: [{ kind: 'string', path: 'lines', line: 'integer', column: 'integer' }] }],
};

const at = (location, key) => (location === '' ? key : `${location}.${key}`);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function refuse(name, location, problem) {
  throw new Error(`${name}: ${location || '$'} ${problem}`);
}

function check(name, value, type, location) {
  const fail = problem => refuse(name, location, problem);
  if (type === 'string' || type === 'boolean') {
    if (typeof value !== type) fail(`is not a ${type}`);
  } else if (type === 'integer') {
    if (!Number.isInteger(value)) fail('is not an integer');
  } else if (type === 'lines') {
    check(name, value, ['string'], location);
  } else if (type === 'linesMap') {
    if (!isObject(value)) fail('is not an object');
    for (const [key, lines] of Object.entries(value)) check(name, lines, 'lines', at(location, key));
  } else if (Array.isArray(type)) {
    if (!Array.isArray(value)) fail('is not an array');
    value.forEach((item, i) => check(name, item, type[0], `${location}[${i}]`));
  } else {
    if (!isObject(value)) fail('is not an object');
    const fields = new Map(Object.entries(type).map(([key, t]) => [key.replace(/\?$/, ''), [t, key.endsWith('?')]]));
    for (const [key, [, optional]] of fields) {
      if (!optional && !Object.hasOwn(value, key)) refuse(name, at(location, key), 'is missing');
    }
    for (const key of Object.keys(value).sort()) {
      if (!fields.has(key)) refuse(name, at(location, key), 'is not a known field');
    }
    for (const [key, [t]] of fields) if (Object.hasOwn(value, key)) check(name, value[key], t, at(location, key));
    if (fields.has('main') && !Object.hasOwn(value.documents, value.main)) refuse(name, at(at(location, 'documents'), value.main), 'is missing');
  }
}

// checkCases checks the parsed cases.json value and returns it; name names it in the errors.
export function checkCases(value, name = NAME) {
  check(name, value, SCHEMA, '');
  if (value.version !== 1) refuse(name, 'version', 'is not 1');
  for (const [key, type] of Object.entries(SCHEMA)) {
    if (Array.isArray(type) && value[key].length === 0) refuse(name, key, 'is empty');
  }
  return value;
}

// readCases reads tests/dbspec/cases.json of the repository strictly.
export function readCases() {
  return checkCases(JSON.parse(readFileSync(new URL('cases.json', import.meta.url), 'utf8')));
}
