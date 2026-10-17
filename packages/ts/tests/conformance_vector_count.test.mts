// The TypeScript conformance suites run every vector they declare: the vector names of tests/conformance/vectors.json
// (the one place a vector is declared; vectors.<dialect>.json must name the same vectors) must equal the vectors the
// TypeScript runner runs (each run('<name>', ...) of runner_typescript.mts). Reads files only; runs no database.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

const vectorNames = (file: string) => JSON.parse(readFileSync(new URL(`../../../tests/conformance/${file}`, import.meta.url), 'utf8')).vectors.map((vector: { name: string }) => vector.name);
const runnerSource = readFileSync(new URL('../testing/conformance/runner_typescript.mts', import.meta.url), 'utf8');
const runVectors = [...new Set([...runnerSource.matchAll(/\brun\('([a-z0-9_]+)'/g)].map(match => match[1]))].sort();
const declared = [...new Set(vectorNames('vectors.json'))].sort();

for (const dialect of ['mysql', 'postgres', 'sqlite']) {
  caseTest(`the ${dialect} conformance suite runs every declared vector`, COMPUTE, () => {
    const file = dialect === 'mysql' ? 'vectors.json' : `vectors.${dialect}.json`;
    assert.deepEqual([...new Set(vectorNames(file))].sort(), declared, `${file} names the vectors of vectors.json`);
    assert.deepEqual(runVectors, declared, `the runner runs ${runVectors.length} vectors, ${dialect} declares ${declared.length}`);
  });
}
