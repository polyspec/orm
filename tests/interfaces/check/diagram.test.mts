// 구성요소 문서와 command line, JSON 형식의 test다.
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { caseTest, COMPUTE } from '../../testcase.mts';
import { diagram } from './diagram.mts';
import { goJson, JsonNumber } from './json.mts';
import { goFlags } from './main.mts';
import { readManifest } from './manifest.mts';

const root = resolve(import.meta.dirname, '../../..');

caseTest('the component diagrams use the requested language', COMPUTE, () => {
  const m = readManifest(join(root, 'contracts/interfaces.json'));
  const en = diagram(m, false), ko = diagram(m, true);
  assert.ok(en.includes('| Component | Behavior and state |') && !en.includes('| 구성요소 |'), 'English diagram contains an invalid table heading');
  assert.ok(ko.includes('| 구성요소 | 동작 및 상태 |') && !ko.includes('| Component |'), 'Korean diagram contains an invalid table heading');
  const count = (text: string, part: string) => text.split(part).length - 1;
  assert.ok(count(en, '    class ') === count(ko, '    class ') && count(en, '\n| ') === count(ko, '\n| '), 'localized diagrams contain different structures');
});

caseTest('JSON is written as Go encoding/json writes it', COMPUTE, () => {
  assert.equal(goJson({ b: 'x<&> ', a: [new JsonNumber('1.0'), null, true] }), '{"a":[1.0,null,true],"b":"x\\u003c\\u0026\\u003e\\u2028"}');
  assert.equal(goJson({ b: '1', a: { c: [] } }, '  '), '{\n  "a": {\n    "c": []\n  },\n  "b": "1"\n}');
  assert.equal(goJson({ 'é': 1, z: 2 }), '{"z":2,"é":1}');
});

caseTest('the options are read as Go flag reads them', COMPUTE, () => {
  assert.deepEqual(goFlags(['-record', '--self-test', '-language', 'php', '-results=a', '--results', 'b', '-generate=false', 'rest', '-root', 'x']),
    ['--record', '--self-test', '--language=php', '--results=a', '--results=b']);
  assert.throws(() => goFlags(['-nope']), /flag provided but not defined: -nope/);
  assert.throws(() => goFlags(['-language']), /flag needs an argument: -language/);
});
