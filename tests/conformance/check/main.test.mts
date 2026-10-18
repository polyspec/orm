// The unit cases of the conformance checker (main.mts): recording, comparing and loading the vectors, the evidence of the
// languages, exact JSON, the output directory, the runner deadline, the command log and the difference report.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { COMPUTE, PROCESS, caseTest, withTemporaryDirectory } from '../../testcase.mts';
import { canon, decodeExact, encode, equalJSON } from './json.mts';
import {
  compare, compareRepeatedEvidence, describeDifference, displayCommand, load, newOutputDirectory, recordVerified, requiredLanguages,
  runCommand, runLanguages, validateOutputFiles,
} from './main.mts';

const repository = resolve(import.meta.dirname, '../../..');

// conformanceRoot makes the tests/conformance directory of a repository root in a temporary directory.
function conformanceRoot(root: string): { root: string; directory: string } {
  const directory = join(root, 'tests', 'conformance');
  mkdirSync(directory, { recursive: true });
  return { root, directory };
}

// writeOutputs writes the same output for every required language and returns the files.
function writeOutputs(root: string, text: string): string[] {
  return requiredLanguages.map(language => {
    const output = join(root, `${language}.json`);
    writeFileSync(output, text);
    return output;
  });
}

// quietly runs work with console.log and console.error silenced; compare and record print their lines.
function quietly<T>(work: () => T): T {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return work();
  } finally {
    console.log = log;
    console.error = error;
  }
}

const assertFileEquals = (path: string, want: string): void => {
  assert.equal(readFileSync(path, 'utf8'), want, 'record changed expectations after rejecting evidence');
};

caseTest('TestRecordRequiresFourEqualOutputs', COMPUTE, () => withTemporaryDirectory('orm-conformance-check-test-', temp => {
  const { root, directory } = conformanceRoot(temp);
  const vectors = join(directory, 'vectors.json');
  const before = '{"vectors":[{"name":"one","chain":"one","expect":{"result":0}}]}';
  writeFileSync(vectors, before);
  const outputs = writeOutputs(root, '{"one":{"result":1}}');
  for (const incomplete of [outputs.slice(0, 3), outputs.slice(1)]) {
    assert.throws(() => quietly(() => recordVerified(root, incomplete, 'mysql')), 'record accepted incomplete client evidence');
    assertFileEquals(vectors, before);
  }
  writeFileSync(outputs[1] ?? '', '{"one":{"result":2}}');
  assert.throws(() => quietly(() => recordVerified(root, outputs, 'mysql')), /vector one differs between go and php outputs:\nresult: expected 1, got 2/, 'record accepted conflicting client results, or did not name the difference');
  assertFileEquals(vectors, before);
  for (const invalid of ['{}', '{"one":{"result":1},"extra":{"result":1}}']) {
    writeFileSync(outputs[1] ?? '', invalid);
    assert.throws(() => quietly(() => recordVerified(root, outputs, 'mysql')), `record accepted an incomplete or undeclared vector: ${invalid}`);
    assertFileEquals(vectors, before);
  }
  writeFileSync(outputs[1] ?? '', '{"one":{"result":1}}');
  quietly(() => recordVerified(root, outputs, 'mysql'));
  assert.match(readFileSync(vectors, 'utf8'), /"result": 1/, 'record did not save the agreed result');
}));

caseTest('TestCompareRejectsUndeclaredDialectExpectation', COMPUTE, () => withTemporaryDirectory('orm-conformance-check-test-', temp => {
  const { root, directory } = conformanceRoot(temp);
  writeFileSync(join(directory, 'vectors.json'), '{"vectors":[{"name":"one","chain":"one","expect":{"result":1}}]}');
  const outputs = writeOutputs(root, '{"one":{"result":1}}');
  for (const database of ['postgres', 'sqlite']) {
    const dialect = '{"vectors":[{"name":"one","expect":{"result":1}},{"name":"extra","expect":{"result":2}}]}';
    const path = join(directory, `vectors.${database}.json`);
    writeFileSync(path, dialect);
    assert.notEqual(quietly(() => compare(root, outputs, database)), 0, `${database} comparison accepted an undeclared expectation`);
    assert.throws(() => quietly(() => recordVerified(root, outputs, database)), `${database} recording accepted an undeclared expectation`);
    assertFileEquals(path, dialect);
  }
}));

caseTest('TestLoadRejectsIncompleteOrDuplicateVectorSets', COMPUTE, () => withTemporaryDirectory('orm-conformance-check-test-', temp => {
  const { root, directory } = conformanceRoot(temp);
  const base = '{"vectors":[{"name":"one","chain":"one","expect":{"result":1}}]}';
  const dialect = '{"vectors":[{"name":"one","expect":{"result":1}}]}';
  for (const test of [
    { name: 'empty base', database: 'mysql', base: '{"vectors":[]}', dialect },
    { name: 'duplicate base', database: 'mysql', base: '{"vectors":[{"name":"one"},{"name":"one"}]}', dialect },
    { name: 'missing dialect', database: 'postgres', base, dialect: '{"vectors":[]}' },
    { name: 'duplicate dialect', database: 'postgres', base, dialect: '{"vectors":[{"name":"one"},{"name":"one"}]}' },
  ]) {
    writeFileSync(join(directory, 'vectors.json'), test.base);
    writeFileSync(join(directory, 'vectors.postgres.json'), test.dialect);
    assert.throws(() => load(root, test.database), `${test.name}: comparison accepted an incomplete or duplicate vector set`);
  }
}));

caseTest('TestCompleteLanguageEvidence', COMPUTE, () => withTemporaryDirectory('orm-conformance-check-test-', temp => {
  const dir = temp;
  const all = requiredLanguages.map(name => join(dir, `${name}.json`));
  validateOutputFiles(all);
  for (const test of [
    { name: 'missing client', files: all.slice(0, -1) },
    { name: 'duplicate client', files: [...all, all[0] ?? ''] },
    { name: 'unknown client', files: [...all.slice(0, -1), join(dir, 'other.json')] },
  ]) {
    assert.throws(() => validateOutputFiles(test.files), `${test.name}: incomplete language evidence accepted`);
  }
}));

caseTest('TestRepeatedEvidenceRejectsChangedOutput', COMPUTE, () => withTemporaryDirectory('orm-conformance-check-test-', temp => {
  const dir = temp;
  const first = join(dir, 'first.json');
  const second = join(dir, 'second.json');
  writeFileSync(first, '{"one":{"result":1}}');
  writeFileSync(second, '{"one":{"result":2}}');
  assert.throws(() => compareRepeatedEvidence(first, second), 'changed result accepted as repeatable');
  writeFileSync(second, '{"one":{"result":1}}');
  compareRepeatedEvidence(first, second);
  writeFileSync(first, '{"one":{"result":9007199254740992}}');
  writeFileSync(second, '{"one":{"result":9007199254740993}}');
  assert.throws(() => compareRepeatedEvidence(first, second), 'distinct large integers accepted as repeatable');
}));

caseTest('TestExactNumericConformance', COMPUTE, () => {
  for (const test of [
    { left: '{"value":9007199254740992}', right: '{"value":9007199254740993}', equal: false },
    { left: '{"value":48000}', right: '{"value":48000.0}', equal: true },
    { left: '{"value":9.007199254740993e15}', right: '{"value":9007199254740993}', equal: true },
  ]) {
    assert.equal(equalJSON(test.left, test.right), test.equal, `compare ${test.left} and ${test.right}`);
  }
  assert.equal(canon('{"value":9007199254740993}'), '{\n  "value": 9007199254740993\n}', 'recording rounded a large integer');
});

caseTest('TestDuplicateJSONKeysFail', COMPUTE, () => {
  for (const raw of ['{"vector":{"result":1},"vector":{"result":2}}', '{"vector":{"result":{"field":1,"field":2}}}']) {
    assert.throws(() => decodeExact(raw), `duplicate JSON key was silently discarded: ${raw}`);
  }
});

caseTest('TestRunWritesIntoANewDirectory', COMPUTE, () => withTemporaryDirectory('orm-conformance-check-test-', temp => {
  const dir = join(temp, 'out');
  newOutputDirectory(dir);
  writeFileSync(join(dir, 'go.json'), '{}');
  assert.throws(() => newOutputDirectory(dir), {
    message: `output directory ${dir} already exists; run writes into a new directory of its own so that no earlier output is read as this run's`,
  });
}));

caseTest('TestRunnerDeadlineFails', PROCESS, ({ step, signal }) => withTemporaryDirectory('orm-conformance-check-test-', async temp => {
  await assert.rejects(runCommand({ step, signal }, temp, '', 20, '/bin/sleep', ['1']), 'timed-out runner reported success');
}));

caseTest('TestCommandLogDoesNotExposeDSN', COMPUTE, () => {
  for (const flag of ['--dsn', '-dsn']) {
    assert.equal(displayCommand(['runner', flag, 'mysql://user:secret@db/test', 'bench.dbs']), `runner ${flag} <redacted> bench.dbs`,
      'DSN was exposed or command arguments changed');
  }
});

// The difference case checks that when output differs from the vector's expected value, it records the two values of the other result and the added or missing statement with its position, kind,
// SQL and binds.
caseTest('TestDifferenceNamesStatementsAndResult', COMPUTE, () => {
  const want = decodeExact('{"result":1,"statements":[{"binds":[1],"error":null,"kind":"insert","sql":"INSERT a"}]}');
  const got = decodeExact('{"result":2,"statements":[{"binds":[],"error":null,"kind":"begin","sql":"START TRANSACTION"},{"binds":[2],"error":null,"kind":"insert","sql":"INSERT a"}]}');
  assert.deepEqual(describeDifference(want, got), [
    'result: expected 1, got 2',
    'statements: +1 model, +1 transaction-control, -1 model',
    '  + #1 begin START TRANSACTION binds []',
    '  + #2 insert INSERT a binds [2]',
    '  - #1 insert INSERT a binds [1]',
  ]);
});

// TestDifferenceNamesTheTablesAndTransaction checks that two statements with the same SQL and binds that differ in their
// tables or transaction are reported with those fields, so the difference is visible.
caseTest('TestDifferenceNamesTheTablesAndTransaction', COMPUTE, () => {
  const want = decodeExact('{"statements":[{"binds":[1],"error":null,"kind":"insert","sql":"INSERT a","tables":["a"],"transaction":1}]}');
  const got = decodeExact('{"statements":[{"binds":[1],"error":null,"kind":"insert","sql":"INSERT a","tables":["a"],"transaction":null}]}');
  assert.deepEqual(describeDifference(want, got), [
    'statements: +1 model, -1 model',
    '  + #1 insert INSERT a binds [1] tables ["a"] transaction null',
    '  - #1 insert INSERT a binds [1] tables ["a"] transaction 1',
  ]);
});

// TestRunLanguagesRunsEveryLanguageAfterAFailure checks that a failed language does not stop the other languages of the
// database: every language runs, and the error names each language that failed.
caseTest('TestRunLanguagesRunsEveryLanguageAfterAFailure', COMPUTE, async () => {
  const ran: string[] = [];
  const error = await runLanguages(['go', 'php', 'rust', 'typescript', 'python'], async language => {
    ran.push(language);
    if (language === 'php' || language === 'python') throw new Error('runner failed');
  });
  assert.deepEqual(ran, ['go', 'php', 'rust', 'typescript', 'python'], 'not every language ran');
  assert.ok(error, 'runLanguages returned null, want an error naming php and python');
  for (const name of ['php', 'python']) assert.ok(error.message.includes(`${name}: runner failed`), `error ${error.message} does not name the failed language ${name}`);
  for (const name of ['go:', 'rust:', 'typescript:']) assert.ok(!error.message.includes(name), `error ${error.message} names a language that passed`);
});

// TestRecordKeepsTheRecordedFiles records, for each database, the expectations of the repository's vector files as the
// agreed output of every language: the file it writes is the file as it is, byte for byte, so the records keep the form
// that the Go checker wrote (sorted keys, HTML escapes, number text).
caseTest('TestRecordKeepsTheRecordedFiles', COMPUTE, async () => {
  for (const database of ['mysql', 'postgres', 'sqlite']) await withTemporaryDirectory('orm-conformance-check-test-', temp => {
    const { root, directory } = conformanceRoot(temp);
    for (const file of ['vectors.json', 'vectors.postgres.json', 'vectors.sqlite.json']) copyFileSync(join(repository, 'tests/conformance', file), join(directory, file));
    const path = join(directory, database === 'mysql' ? 'vectors.json' : `vectors.${database}.json`);
    const original = readFileSync(path, 'utf8');
    const agreed = new Map(load(root, database).map(vector => [vector.name, vector.expect ?? null]));
    writeOutputs(root, encode(agreed, { sorted: false }));
    quietly(() => recordVerified(root, requiredLanguages.map(language => join(root, `${language}.json`)), database));
    assert.equal(readFileSync(path, 'utf8'), original, `${database}: the record changed the recorded file`);
  });
});
