// The JSON boundary (scripts/json/schema.mts): a value its schema accepts is returned, invalid JSON and a refused value
// throw with the source and the ajv path, and a schema that strict mode refuses throws.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { JsonError, parseJson, readJsonFile, SchemaError, validator } from './schema.mts';

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

caseTest('a schema file is compiled once, and again when its text changes', COMPUTE, () => {
  withSchema({ type: 'object' }, path => {
    const first = validator(path);
    assert.equal(validator(path), first);
    writeFileSync(path, JSON.stringify({ type: 'array' }));
    assert.notEqual(validator(path), first);
    assert.equal(validator(path)([]), true);
  });
});

// T461: a oneOf names the member that selects its alternative (discriminator), and the report of a refused value holds
// the errors of that alternative, not those of the alternatives that the value does not name.
const SHAPES = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'array', items: { type: 'object', required: ['kind'], properties: { kind: { type: 'string' } }, discriminator: { propertyName: 'kind' }, oneOf: [
  { type: 'object', additionalProperties: false, required: ['kind', 'radius'], properties: { kind: { const: 'circle' }, radius: { type: 'number' } } },
  { type: 'object', additionalProperties: false, required: ['kind', 'side'], properties: { kind: { const: 'square' }, side: { type: 'number' } } },
  { type: 'object', additionalProperties: false, required: ['kind', 'base', 'height'], properties: { kind: { enum: ['triangle', 'wedge'] }, base: { type: 'number' }, height: { type: 'number' } } },
] } };

caseTest('a refused value of a oneOf is reported by the alternative that it names', COMPUTE, () => {
  withSchema(SHAPES, schema => {
    const refused = (text: string): string[] => {
      let lines: string[] | undefined;
      assert.throws(() => parseJson<unknown>(text, schema, 's.json'), (error: unknown) => {
        assert.ok(error instanceof SchemaError);
        assert.equal(error.issues.length, error.lines.length);
        lines = error.lines;
        return true;
      });
      return (lines ?? []).map(line => line.split(' {')[0] ?? '').sort();
    };
    // The square without its side: the error of the square alone.
    assert.deepEqual(refused('[{"kind":"circle","radius":1},{"kind":"square"}]'), ['s.json: /1 must have required property \'side\'']);
    // An enum names its alternative as a const does.
    assert.deepEqual(refused('[{"kind":"wedge","base":"wide","height":2}]'), ['s.json: /0/base must be number']);
    // A value that names no alternative: one line of the member that selects, with no error of an alternative.
    assert.deepEqual(refused('[{"kind":"star"}]'), ['s.json: /0 value of tag "kind" must be in oneOf']);
  });
});

// T461: the report of one refused step of a recipe names the step and is short. The step form of the recipe schema is a
// oneOf of 147 ops, and the report held 1085 lines for this step.
caseTest('one refused step of a recipe is reported in a few lines', COMPUTE, () => {
  const root = join(import.meta.dirname, '../..');
  const schema = join(root, 'scripts/features/schema/recipe.schema.json');
  const recipe = { $schema: 'recipe.schema.json', requirements: ['FCV-2'], cases: [{ id: 'one', requirements: ['FCV-2'], steps: [{ op: 'dsn.connect', dsn: 'case', expect: { error: 'Not A Code' } }] }] };
  assert.throws(() => parseJson<unknown>(JSON.stringify(recipe), schema, 'r.json'), (error: unknown) => {
    assert.ok(error instanceof SchemaError);
    assert.ok(error.lines.length > 0 && error.lines.length < 40, `${error.lines.length} lines`);
    // The lines name the step, or the root, whose condition for a recipe of this kind the refused step fails.
    assert.ok(error.lines.every(line => line.startsWith('r.json: /cases/0/steps/0') || line.startsWith('r.json: / ')), error.lines.join('\n'));
    assert.ok(error.lines.some(line => line.includes('/cases/0/steps/0/expect')), error.lines.join('\n'));
    return true;
  });
});
