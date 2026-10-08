// models script 검사: scan 대상이 model을 호출하는 source와 정확히 같고,
// commit된 src/models/models.ts가 그 scan의 generator 출력과 같은지 확인한다.
// Usage: node --test packages/orm-npm/tests/models-scan.mjs (after tsc -p packages/orm-npm/tsconfig.build.json)
import { caseTest } from '../../../tests/testcase.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const client = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(client, '../..');
// model을 호출하는 source를 찾는 디렉터리: scan이 읽을 수 있는 source 전체
const scannedDirs = [join(client, 'tests'), join(root, 'tests/conformance')];
const extensions = new Set(['.ts', '.mts', '.js', '.mjs']);
const modelModules = new Set([join(client, 'dist/models/models.js'), join(client, 'src/models/models.js')]);
const indexModules = new Set([join(client, 'dist/index.js'), join(client, 'src/index.js')]);
const modelClasses = new Set([...readFileSync(join(client, 'src/models/models.ts'), 'utf8').matchAll(/^export class (\w+)/gm)].map(m => m[1]));

/** models script의 인자를 package.json에서 읽는다. */
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

/** source가 generated model module이나 model class를 import하면 true다. */
function callsModels(path) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, false);
  return source.statements.some(statement => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return false;
    const target = resolve(dirname(path), statement.moduleSpecifier.text);
    if (modelModules.has(target)) return true;
    const bindings = statement.importClause?.namedBindings;
    return indexModules.has(target) && bindings !== undefined && ts.isNamedImports(bindings)
      && bindings.elements.some(element => modelClasses.has((element.propertyName ?? element.name).text));
  });
}

// 기한 10 s: test source를 TypeScript parser로 읽기만 한다.
caseTest('the models script scans exactly the sources that call models', 10000, () => {
  assert(modelClasses.size > 0, 'src/models/models.ts declares model classes');
  const args = modelsArgs();
  const scanned = args.flatMap((word, i) => (args[i - 1] === '--scan' ? files(resolve(client, word)) : []));
  const calling = scannedDirs.flatMap(files).filter(callsModels);
  const names = list => [...new Set(list.map(path => relative(root, path)))].sort();
  assert.deepEqual(names(scanned), names(calling));
});

// 기한 30 s: orm-gen process 하나가 models를 만들어 비교한다.
caseTest('the committed models equal the generator output', 30000, () => {
  const result = spawnSync(process.execPath, ['dist/bin/orm-gen.js', ...modelsArgs(), '--check'], { cwd: client, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.deepEqual({ status: result.status, stdout: result.stdout, stderr: result.stderr }, { status: 0, stdout: '', stderr: '' });
});
