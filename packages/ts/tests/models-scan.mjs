// models script check: the scan targets are exactly the sources that call a model,
// and the committed src/models/models.ts equals the generator output of that scan.
// Requirements: SCH-1.
// Usage: node --test packages/ts/tests/models-scan.mjs (after tsc -p packages/ts/tsconfig.build.json)
import { caseTest } from '../../../tests/testcase.mts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';

const client = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(client, '../..');
// Directories in which to find sources that call a model: all sources that the scan can read
const scannedDirs = [join(client, 'tests'), join(client, 'testing'), join(root, 'tests/conformance'), join(root, 'examples/thin-slice/ts')];
const extensions = new Set(['.ts', '.mts', '.js', '.mjs']);
const modelModules = new Set([join(client, 'dist/models/models.js'), join(client, 'src/models/models.js')]);
const indexModules = new Set([join(client, 'dist/index.js'), join(client, 'src/index.js')]);
const modelClasses = new Set([...readFileSync(join(client, 'src/models/models.ts'), 'utf8').matchAll(/^export class (\w+)/gm)].map(m => m[1]));

/** Reads the arguments of the models script from package.json. */
function modelsArgs() {
  const script = JSON.parse(readFileSync(join(client, 'package.json'), 'utf8')).scripts.models;
  const words = script.split(' ');
  assert.deepEqual(words.slice(0, 3), ['node', 'dist/bin/orm-gen.js', 'gen'], `models script runs orm-gen gen: ${script}`);
  return words.slice(2);
}

function files(path) {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'dist' ? [] : files(child);
    return entry.isFile() && extensions.has(extname(entry.name)) ? [child] : [];
  });
}

/** True if the source imports a generated model module or a model class. */
function callsModels(path) {
  const parsed = parseSync(path, readFileSync(path, 'utf8'));
  assert.deepEqual(parsed.errors.map(error => error.message), [], `${relative(root, path)} parses`);
  return parsed.program.body.some(statement => {
    if (statement.type !== 'ImportDeclaration') return false;
    const target = resolve(dirname(path), statement.source.value);
    if (modelModules.has(target)) return true;
    return indexModules.has(target) && statement.specifiers.some(specifier => specifier.type === 'ImportSpecifier'
      && modelClasses.has(specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value));
  });
}

// Deadline 10 s: only reads the test source with oxc-parser.
caseTest('the models script scans exactly the sources that call models', 10000, () => {
  assert(modelClasses.size > 0, 'src/models/models.ts declares model classes');
  const args = modelsArgs();
  const scanned = args.flatMap((word, i) => (args[i - 1] === '--scan' ? files(resolve(client, word)) : []));
  const calling = scannedDirs.flatMap(files).filter(callsModels);
  const names = list => [...new Set(list.map(path => relative(root, path)))].sort();
  assert.deepEqual(names(scanned), names(calling));
});

// Deadline 30 s: one orm-gen process creates the models and compares them.
caseTest('the committed models equal the generator output', 30000, () => {
  const result = spawnSync(process.execPath, ['dist/bin/orm-gen.js', ...modelsArgs(), '--check'], { cwd: client, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.deepEqual({ status: result.status, stdout: result.stdout, stderr: result.stderr }, { status: 0, stdout: '', stderr: '' });
});

// Collects the identifier names an AST node refers to, outside its import declarations.
function referencedNames(node, names = new Set()) {
  if (Array.isArray(node)) {
    for (const child of node) referencedNames(child, names);
  } else if (node && typeof node === 'object') {
    if (node.type === 'ImportDeclaration') return names;
    if (typeof node.name === 'string' && /Identifier|TSTypeReference/.test(node.type)) names.add(node.name);
    for (const value of Object.values(node)) if (value && typeof value === 'object') referencedNames(value, names);
  }
  return names;
}

// Deadline 10 s: only reads the committed generated file with oxc-parser.
caseTest('a generated model file imports only what it uses and declares each type once', 10000, () => {
  for (const file of ['src/models/models.ts', 'src/models/decimal_fixture/models.ts', 'src/models/markdown_fixture/models.ts']) {
    const { program, errors } = parseSync(file, readFileSync(join(client, file), 'utf8'));
    assert.deepEqual(errors.map(error => error.message), [], `${file} parses`);
    const used = referencedNames(program.body);
    const imported = program.body.filter(s => s.type === 'ImportDeclaration').flatMap(s => s.specifiers.map(specifier => specifier.local.name));
    assert.deepEqual(imported.filter(name => !used.has(name)), [], `${file} imports names it does not use`);
    const declared = node => node.declaration ?? node;
    const classes = new Set(program.body.map(declared).filter(d => d.type === 'ClassDeclaration').map(d => d.id.name));
    const merged = program.body.map(declared).filter(d => d.type === 'TSInterfaceDeclaration' && classes.has(d.id.name)).map(d => d.id.name);
    assert.deepEqual(merged, [], `${file} merges an interface into a class`);
  }
});
