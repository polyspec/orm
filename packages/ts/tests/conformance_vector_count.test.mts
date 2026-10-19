// The TypeScript conformance suites run every vector they declare: the vector names of tests/conformance/vectors.json
// (the one place a vector is declared; vectors.<dialect>.json must name the same vectors) must equal the vectors the
// TypeScript runner runs (each run('<name>', ...) of runner_typescript.mts). Reads files only; runs no database.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

// vectorNames reads the names of the vectors of a file of tests/conformance; a vector without a name is refused.
const vectorNames = (file: string): string[] => {
  const value: unknown = JSON.parse(readFileSync(new URL(`../../../tests/conformance/${file}`, import.meta.url), 'utf8'));
  if (typeof value !== 'object' || value === null || !('vectors' in value) || !Array.isArray(value.vectors)) throw new Error(`tests/conformance/${file} holds no vectors list`);
  return value.vectors.map((vector: unknown) => {
    if (typeof vector !== 'object' || vector === null || !('name' in vector) || typeof vector.name !== 'string') throw new Error(`a vector of tests/conformance/${file} has no name`);
    return vector.name;
  });
};
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const runnerSource = readFileSync(new URL('../testing/conformance/runner_typescript.mts', import.meta.url), 'utf8');
const runVectors = [...new Set([...runnerSource.matchAll(/\brun\('([a-z0-9_]+)'/g)].map(match => match[1]))].sort(byName);
const declared = [...new Set(vectorNames('vectors.json'))].sort(byName);

for (const dialect of ['mysql', 'postgres', 'sqlite']) {
  caseTest(`the ${dialect} conformance suite runs every declared vector`, COMPUTE, () => {
    const file = dialect === 'mysql' ? 'vectors.json' : `vectors.${dialect}.json`;
    assert.deepEqual([...new Set(vectorNames(file))].sort(byName), declared, `${file} names the vectors of vectors.json`);
    assert.deepEqual(runVectors, declared, `the runner runs ${runVectors.length} vectors, ${dialect} declares ${declared.length}`);
  });
}
