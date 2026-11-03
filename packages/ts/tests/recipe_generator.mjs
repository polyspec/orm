// The generator.generate op of the recipe helper (docs/spec/feature-coverage.md FCV-4): it writes the scanned TypeScript sources of
// a step under a temporary root and calls generateTypeScript with that root as the scan input.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { modelOfDocuments, parseDocumentSet } from '../dist/engine/model.js';
import { readDbspecBytes } from '../dist/dbspec/read_bytes.js';
import { generateTypeScript } from '../dist/generate/typescript.js';

// documentTexts reads the .dbs documents named relative to the recipe directory.
function documentTexts(dir, paths) {
  return paths.map(path => {
    const full = resolve(dir, path);
    const read = readDbspecBytes(full, readFileSync(full));
    assert.deepEqual(read.diagnostics, [], full);
    return read.text;
  });
}

// snake converts a camelCase identifier to snake_case.
const snake = name => name.replace(/[A-Z]/g, (letter, at) => `${at > 0 ? '_' : ''}${letter.toLowerCase()}`);

// methodName is the snake_case identifier of a generated method without its language prefix (get, new, alias).
const methodName = name => snake(/^(?:get|new|alias)(?=[A-Z])/.test(name) ? name.replace(/^(?:get|new|alias)/, '') : name);

// generatedMethods reads the declared members of each model class of models.ts as table.name.
function generatedMethods(output) {
  const text = readFileSync(join(output, 'models.ts'), 'utf8');
  const names = new Set();
  for (const model of text.matchAll(/export class (\w+) extends Model \{\n([\s\S]*?)\n\}\n/g)) {
    names.add(snake(model[1]));
    for (const member of model[2].matchAll(/^ {2}(?:declare |public (?:async )?)(\w+)[:(]/gm)) names.add(`${snake(model[1])}.${methodName(member[1])}`);
  }
  return names;
}

// generate runs the generation of a step in a new root and returns the method names of the generated models.
function generate(step, dir, root) {
  const options = step.options ?? {};
  for (const [path, text] of Object.entries(options.sources?.typescript ?? {})) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const before = options.before;
  if (before !== undefined) {
    const model = modelOfDocuments(parseDocumentSet(documentTexts(dir, [before.schema]), []));
    generateTypeScript(model, join(root, before.output), [join(root, before.scan)]);
  }
  const replace = options.schema_replace;
  const documents = documentTexts(dir, [step.schema]).map(text => (replace === undefined ? text : text.replaceAll(replace.from, replace.to)));
  const model = modelOfDocuments(parseDocumentSet(documents, documentTexts(dir, options.used ?? [])));
  generateTypeScript(model, join(root, 'model'), [root]);
  return generatedMethods(join(root, 'model'));
}

// checkGenerator runs one generator.generate step and checks it against the expect of database.
export function checkGenerator(step, dir, database) {
  const want = step.expect[database];
  assert.notEqual(want, undefined, `generator.generate has no expect for ${database}`);
  const root = mkdtempSync(join(tmpdir(), 'orm-recipe-generator-'));
  try {
    let names;
    try {
      names = generate(step, dir, root);
    } catch (error) {
      if (want.error === undefined) throw error;
      assert.equal(error.code, want.error, error.message);
      if (want.message !== undefined) assert.ok(error.message.includes(want.message), error.message);
      assert.ok(!existsSync(join(root, 'model')), 'a refused generation wrote its output');
      if (want.position !== undefined) assert.match(error.message, new RegExp(`\\.ts:${want.position.line}:`));
      return;
    }
    assert.equal(want.error, undefined, `generation succeeded, want error ${want.error}`);
    for (const name of want.value.includes) assert.ok(names.has(name), `generated code lacks ${name}`);
    for (const name of want.value.excludes) assert.ok(!names.has(name), `generated code declares ${name}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
