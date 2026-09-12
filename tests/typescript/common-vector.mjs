import { readFile } from 'node:fs/promises';
import { BattleQuery } from '../../clients/typescript/dist/index.js';

const vectors = JSON.parse(await readFile('tests/conformance/vectors.json', 'utf8')).vectors;
const vector = vectors.find(v => v.name === 'interface_attach');
if (!vector) throw new Error('shared vector interface_attach is missing');

const q = new BattleQuery()
  .serviceSeqEq(7)
  .join('user', w => w.seqIn([1, 2]).and(n => n.name('user-1').or().name('user-2')));
const b = new BattleQuery()
  .serviceSeqEq(8)
  .join('user', w => w.seqIn([1, 2]).and(n => n.name('user-1').or().name('user-2')));
const child = new BattleQuery('user')
  .seqIn([1, 2])
  .and(n => n.name('user-1').or().name('user-2'))
  .name('later');
const project = query => ({ entity: query.entity, where: query.where, joins: query.joins });
const shape = q.requestShape();
const bShape = b.requestShape();
const childShape = child.requestShape();
const actual = {
  a: project(shape),
  a_params: q.parameters(),
  b: project(bShape),
  b_params: b.parameters(),
  child: project(childShape),
  child_params: child.parameters(),
};
const expected = vector.expect.result;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) {
  throw new Error(`TypeScript shared vector mismatch:\n${JSON.stringify(actual, null, 2)}\nwant:\n${JSON.stringify(expected, null, 2)}`);
}
console.log('typescript: shared interface_attach vector passed');
