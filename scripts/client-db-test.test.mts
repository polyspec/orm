// The unit tests of the client database lanes: the Rust thread cap of the pooler lane (T343-1), the Go owner of the
// repeated member name case of model_writes (T343-2-1) and its declaration on every owner (T343-2).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { rustDatabaseCoverageSkipArguments, rustPoolerThreadArguments, rustTargetPoolSize } from './client-db-test.mts';
import { readFeatures, type CoverageOwner, type Language, type NativeCommand } from './features/manifest.mts';

const root = resolve(import.meta.dirname, '..');
const repeatedMemberCase = 'ordered_json_repeated_member_name';

test('the pooler lane caps the Rust test threads at the backend count per pool', () => {
  assert.deepEqual(rustPoolerThreadArguments(4, 4), ['--test-threads=1']);
  assert.deepEqual(rustPoolerThreadArguments(8, 4), ['--test-threads=2']);
  assert.deepEqual(rustPoolerThreadArguments(2, 4), ['--test-threads=1']);
});

test('the Rust pool size of the integration program is read from its declaration', () => {
  assert.equal(rustTargetPoolSize(root), 4);
});

test('model_writes Go owner has a Go test function for the repeated member name case (T343-2-1)', () => {
  const source = readFileSync(resolve(root, 'packages/go/model/coverage_model_writes_test.go'), 'utf8');
  assert.match(source, /^func TestCoverageModelOrderedJsonRepeatedMemberName\(t \*testing\.T\) \{$/m);
});

test('model_writes Go owner declares the repeated member name case on the three databases (T343-2-1)', () => {
  const feature = readFeatures(root).features.find(item => item.id === 'model_writes');
  const coverage = feature?.coverage;
  assert.ok(coverage, 'model_writes has a coverage part');
  assert.ok(coverage.cases.includes(repeatedMemberCase), 'the case is in the coverage cases of model_writes');
  const part = coverage.owners.go;
  assert.ok(part, 'the Go owner is declared');
  for (const database of ['mysql', 'postgres', 'sqlite'] as const) {
    const commands: NativeCommand[] | undefined = part.commands[database];
    assert.equal(commands?.length, 1, `go ${database} has one command`);
    const command: NativeCommand | undefined = commands?.[0];
    assert.ok(command, `go ${database} command`);
    assert.ok(command.cases.includes(repeatedMemberCase), `go ${database} runs the case`);
    assert.equal(command.symbols?.[repeatedMemberCase], 'TestCoverageModelOrderedJsonRepeatedMemberName', `go ${database} symbol`);
  }
});

test('model_writes declares the repeated member name case on every owner and the Rust skip list (T343-2)', () => {
  const manifest = readFeatures(root);
  const feature = manifest.features.find(item => item.id === 'model_writes');
  assert.ok(feature, 'model_writes is in contracts/features.json');
  const coverage = feature.coverage;
  assert.ok(coverage, 'model_writes has a coverage part');
  assert.ok(coverage.cases.includes(repeatedMemberCase), 'the case is in the coverage cases of model_writes');
  const symbols: Partial<Record<Language, string>> = {
    go: 'TestCoverageModelOrderedJsonRepeatedMemberName',
    php: 'testOrderedJsonRepeatedMemberName',
    'php-extension': 'testOrderedJsonRepeatedMemberName',
    rust: 'coverage_model_writes::coverage_ordered_json_repeated_member_name',
  };
  const owners: readonly Language[] = ['go', 'php', 'php-extension', 'python', 'rust', 'typescript'];
  assert.deepEqual(Object.keys(coverage.owners).sort(), owners);
  for (const language of owners) {
    const part: CoverageOwner | undefined = coverage.owners[language];
    assert.ok(part, `${language} is an owner`);
    for (const database of ['mysql', 'postgres', 'sqlite'] as const) {
      const commands: NativeCommand[] | undefined = part.commands[database];
      assert.equal(commands?.length, 1, `${language} ${database} has one command`);
      const command: NativeCommand | undefined = commands?.[0];
      assert.ok(command, `${language} ${database} command`);
      assert.ok(command.cases.includes(repeatedMemberCase), `${language} ${database} runs the case`);
      const symbol = symbols[language];
      if (symbol === undefined) assert.equal(command.symbols, undefined, `${language} ${database} declares no symbols`);
      else assert.equal(command.symbols?.[repeatedMemberCase], symbol, `${language} ${database} symbol`);
    }
  }
  assert.ok(rustDatabaseCoverageSkipArguments(manifest, root).includes(symbols.rust ?? ''), 'the generic Rust run skips the case');
});
