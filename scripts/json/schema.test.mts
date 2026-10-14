// The JSON boundary (scripts/json/schema.mts): a value its schema accepts is returned, invalid JSON and a refused value
// throw with the source and the ajv path, and a schema that strict mode refuses throws.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { JsonError, parseJson, readJsonFile, SchemaError } from './schema.mts';

type Pair = { name: string; size: number };

function withSchema(schema: object, body: (path: string, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'orm-json-schema-'));
  try {
    const path = join(dir, 'pair.schema.json');
    writeFileSync(path, JSON.stringify(schema));
    body(path, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PAIR = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false, required: ['name', 'size'],
  properties: { name: { type: 'string' }, size: { type: 'integer' } } };

caseTest('a value its schema accepts is returned typed', COMPUTE, () => {
  withSchema(PAIR, (schema, dir) => {
    const pair = parseJson<Pair>('{"name":"a","size":2}', schema, 'inline');
    assert.deepEqual([pair.name, pair.size], ['a', 2]);
    writeFileSync(join(dir, 'pair.json'), '{"name":"b","size":3}');
    assert.equal(readJsonFile<Pair>(join(dir, 'pair.json'), schema).size, 3);
  });
});

caseTest('a value its schema refuses throws every error with the source and the path', COMPUTE, () => {
  withSchema(PAIR, schema => {
    assert.throws(() => parseJson<Pair>('{"name":1,"extra":true}', schema, 'v.json'), (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.deepEqual(error.lines.map(line => line.split(' ').slice(0, 2).join(' ')).sort(), ['v.json: /', 'v.json: /', 'v.json: /name']);
      return true;
    });
  });
});

caseTest('invalid JSON throws a JsonError naming the source', COMPUTE, () => {
  withSchema(PAIR, schema => {
    assert.throws(() => parseJson<Pair>('{', schema, 'broken.json'), (error: unknown) => error instanceof JsonError && error.message.startsWith('broken.json: '));
  });
});

caseTest('a schema that strict mode refuses throws', COMPUTE, () => {
  withSchema({ type: 'object', unknownKeyword: true }, schema => {
    assert.throws(() => parseJson<Pair>('{}', schema, 'x.json'), /unknown keyword/);
  });
});
