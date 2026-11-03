// The unit tests of the client database lanes: the Rust thread cap of the pooler lane (T343-1), the Go owner of the
// repeated member name case of model_writes and its declaration on every owner (T343-2).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { caseTest, COMPUTE } from '../tests/testcase.mts';
import { dirname, relative, resolve } from 'node:path';
import { GO_LANE_PACKAGES, GO_LANE_SKIP, rustDatabaseCoverageSkipArguments, rustOwnedElsewhereSkipArguments, rustPoolerThreadArguments, rustTargetPoolSize } from './client-db-test.mts';
import { readFeatures, type CoverageOwner, type Language, type NativeCommand } from './features/manifest.mts';

const root = resolve(import.meta.dirname, '..');
const repeatedMemberCase = 'ordered_json_keeps_a_repeated_member_name';

caseTest('the pooler lane caps the Rust test threads at the backend count per pool', COMPUTE, () => {
  assert.deepEqual(rustPoolerThreadArguments(4, 4), ['--test-threads=1']);
  assert.deepEqual(rustPoolerThreadArguments(8, 4), ['--test-threads=2']);
  assert.deepEqual(rustPoolerThreadArguments(2, 4), ['--test-threads=1']);
});

caseTest('the Rust pool size of the integration program is read from its declaration', COMPUTE, () => {
  assert.equal(rustTargetPoolSize(root), 4);
});

caseTest('model_writes declares the repeated member name case on every owner and the Rust skip list (T343-2)', COMPUTE, () => {
  const manifest = readFeatures(root);
  const feature = manifest.features.find(item => item.id === 'model_writes');
  assert.ok(feature, 'model_writes is in contracts/features.json');
  const coverage = feature.coverage;
  assert.ok(coverage, 'model_writes has a coverage part');
  assert.ok(coverage.cases.includes(repeatedMemberCase), 'the case is in the coverage cases of model_writes');
  const recipe: unknown = JSON.parse(readFileSync(resolve(root, 'contracts/fixtures/model_writes_chain/model_writes_chain.json'), 'utf8'));
  assert.ok(JSON.stringify(recipe).includes(`"id":"${repeatedMemberCase}"`), 'the case is a case of the recipe');
  const owners: readonly Language[] = ['go', 'php', 'php-extension', 'python', 'rust', 'typescript'];
  assert.deepEqual(Object.keys(coverage.owners).sort(), owners);
  const skipped = rustDatabaseCoverageSkipArguments(manifest, root);
  for (const language of owners) {
    const part: CoverageOwner | undefined = coverage.owners[language];
    assert.ok(part, `${language} is an owner`);
    for (const database of ['mysql', 'postgres', 'sqlite'] as const) {
      const commands: NativeCommand[] | undefined = part.commands[database];
      assert.equal(commands?.length, 1, `${language} ${database} has one command`);
      const command: NativeCommand | undefined = commands?.[0];
      assert.ok(command, `${language} ${database} command`);
      assert.ok(command.cases.includes(repeatedMemberCase), `${language} ${database} runs the case`);
      if (language === 'rust') {
        const symbol = command.symbols?.[repeatedMemberCase];
        assert.equal(symbol, `model_writes_chain_${database}::${repeatedMemberCase}`, `rust ${database} symbol`);
        assert.ok(skipped.includes(symbol ?? ''), `the generic Rust run skips the case on ${database}`);
      }
    }
  }
});

// A case that needs what another target passes (the database of feature-rust-database, the server of FLOWMARK) stays out of the Rust lane (T334-3-28).
caseTest('the Rust lane skips the cases that parity bindings and markdown-conformance-check own', COMPUTE, () => {
  const skipped = rustOwnedElsewhereSkipArguments(root).filter((_, index) => index % 2 === 1);
  assert.ok(skipped.includes('coverage_transactions::coverage_transaction_deadlock_retry'), 'the parity binding of the deadlock retry');
  assert.ok(skipped.includes('markdown_conformance::insert_one'), 'a markdown conformance case');
});

// The packages of go-test-check, which builds and exports what their cross-runtime tests need (T334-3-27).
const goTestCheckRoots = ['packages/go/cmd', 'packages/go/procevent', 'packages/go/internal'];

caseTest('the Go lane runs every package of packages/go that go-test-check does not run (T334-3-27)', COMPUTE, () => {
  const packages = new Set(readdirSync(resolve(root, 'packages/go'), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.go'))
    .map(entry => relative(root, dirname(resolve(entry.parentPath, entry.name))))
    .filter(path => !path.split('/').includes('testdata')));
  const expected = [...packages].filter(path => !goTestCheckRoots.some(owner => path === owner || path.startsWith(`${owner}/`))).map(path => `./${path}`).sort();
  assert.deepEqual([...GO_LANE_PACKAGES].sort(), expected);
});

caseTest('the Go lane leaves the markdown conformance test to the target that passes its server (T334-3-27)', COMPUTE, () => {
  const makefile = readFileSync(resolve(root, 'Makefile'), 'utf8');
  assert.match(makefile, /^\tFLOWMARK=\$\(FLOWMARK\) \$\(GO_TEST\) \.\/packages\/go\/markdownmodel -run '\^TestMarkdownConformance\$\$' -count=1$/m);
  assert.equal(GO_LANE_SKIP, '^TestMarkdownConformance$');
});
