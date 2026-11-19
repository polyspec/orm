import assert from 'node:assert/strict';
import { checkContract, type Contract } from '@polyspec/binding';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseTest } from '../../tests/testcase.mts';
import { isolatedEnvironment } from '../../tests/environment.mts';
import { errorCode } from '../../tests/errors.mts';
import { main as startServers, paths as serverPaths, SERVER_VARIABLES, TestServerError } from '../test-servers.mts';
import { changedFiles, diffOf, judge, LIMIT } from './diff-size.mts';
import { repositoryOf, runErrors } from './release-run.mts';
import { documentPathErrors, DOCUMENT_PATHS, workflowStarts, CI_PASSED_STEPS, ciPassedErrors, ciRecipeErrors, ciGroups, jobOverlapErrors, jobTargets, lockedCacheErrors, chainedCommandErrors, concurrencyErrors, ownWorkflows, workflowTriggerErrors, WORKFLOW_TRIGGERS, checkTargets, ciSetupErrors, independentTestErrors, fullSuiteRuleErrors, ciCheckTargetErrors, ciDuplicateCommandErrors, ciLeaseErrors, ciRerunErrors, ciReportPathErrors, ciServerErrors, expand, helperEnvironmentErrors, helperRunErrors, featureCommands, kitGates, makeVariables, runnerErrors, runnerIdentity, stepTimeoutErrors, shimToolErrors, jobToolErrors, goModuleErrors, crateFetchErrors, unselectedPhpunitErrors, busyLoopErrors } from './ci.mts';
import { nodeVersionErrors, npmGitSourceErrors } from './node.mts';
import { fixlessMessageErrors } from './messages.mts';
import { binExeErrors, manifestDirErrors, runFile, targetPathErrors } from './target.mts';
import { connectProbeErrors } from './probes.mts';
import { nativeLines, nativeTestErrors } from './native-tests.mts';
import { composerBranchErrors, composerVersionErrors, BUILD_EXTENSION, EXTENSION_JOB, extensionMinorErrors, goModulePathErrors, goVersionErrors, phpVersionErrors, rustToolchainErrors } from './toolchains.mts';
import { execFileSync } from 'node:child_process';
import { expandNeeds, GROUP_OUTPUTS, groupOutputs, groupSetupErrors } from '../check/ci-setup.mts';
import { declaredNeeds, readCheckInputs } from '../check/inputs.mts';
import { readFeatures } from '../features/manifest.mts';
import { readComposer, readPackage } from '../json/formats.mts';
import { type Json, parseJsonValue } from '../json/schema.mts';
import { kitCopies, kitOwnedPaths } from './kit-copies.mts';
import { andLists, segments, shellSegments } from './shell.mts';
import { readWorkflow } from './workflow.mts';
import { imageToolErrors, recipeLines as jobRecipeLines } from './recipes.mts';
import { parse as parseYaml, stringify } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import { scriptPathErrors, toolingLanguageErrors } from './scripts.mts';
import { detachedGroupErrors, timeFailureErrors } from './sources.mts';
import { callerEnvironmentErrors, generateRuns, scriptCommands, goRunErrors, longDeadlineErrors, makeRecipes, fixedPortErrors, runtimePathErrors, sharedTargetErrors, unpublishedOutputErrors, generatedCodesErrors, phpExtensionBuildErrors, typescriptHolderErrors, typescriptReaderErrors, typescriptExclusiveReaderErrors, phpunitModelErrors, unleasedCargoErrors, unlinkedCargoErrors, unlinkedCargoSourceErrors, nodeTestErrors, rawGoTestErrors, reachedScripts, repeatedGenerateErrors, reportingScriptErrors, movedPathErrors, recipeLines, makeTargets, rustTestCaseErrors, testEntries, unbuiltCargoTestErrors, unwrappedToolErrors, tools } from './testcases.mts';

// yamlSteps writes steps (the values of a workflow's steps) as the list under a job's steps:, six spaces deep.
const yamlSteps = (steps: unknown[]) => stringify(steps).split('\n').map(line => line ? `      ${line}` : line).join('\n');

// The files that orm keeps in the form of kit (scripts/repo/kit-copies.mts) follow kit's form, so the rules of this
// repository do not read them.
const copies = kitCopies();
const kitOwned = kitOwnedPaths();
const notVendored = (path: string) => !Object.hasOwn(copies, path);
const tracked = ['scripts/docs/rules.mts', 'legacy/packages/ts/package.json', 'scripts/typescript/sqlite-test.mts'];
const repository = new URL('../../', import.meta.url);
const text = (path: string) => readFileSync(new URL(path, repository), 'utf8');
// The contract of the core, read against the schema that binding publishes for it.
// The schema file of binding is not read: ajv in strict mode refuses it (a required property under not), so the guard checks
// the members that these tests read, and checkContract checks the rest.
const isContract = (value: Json): value is Contract & Json => value !== null && typeof value === 'object' && !Array.isArray(value)
  && value['schema'] === 'polyspec/interface@1' && Array.isArray(value['units']) && Array.isArray(value['cases']);
const interfaceContract = (): Contract => {
  const value = parseJsonValue(text('packages/rust/interface.json'), 'packages/rust/interface.json');
  assert.ok(isContract(value), 'packages/rust/interface.json is a polyspec/interface@1 contract with units and cases');
  return value;
};
type CaseRow = { id: string; raises?: { kind: string; category: string; message: string } };
const isRecord = (item: unknown): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item);
// The members of a case file: the text of its comment, and its groups, each a list of cases.
function caseFileGroups(value: unknown, source: string): [string, unknown[]][] {
  assert.ok(isRecord(value), `${source} is an object of groups`);
  return Object.entries(value).flatMap(([group, cases]): [string, unknown[]][] => {
    if (group === 'comment') {
      assert.equal(typeof cases, 'string', `${source}: comment is a text`);
      return [];
    }
    assert.ok(Array.isArray(cases), `${source}: ${group} is a list of cases`);
    return [[group, cases]];
  });
}
// The groups of a case file that a test reads by member: each group is a list of cases, and a case may name the kind, the
// category and the message of the error that it raises.
function caseGroups(value: unknown, source: string): Record<string, CaseRow[]> {
  return Object.fromEntries(caseFileGroups(value, source).map(([group, cases]) => {
    return [group, cases.map((kase: unknown): CaseRow => {
      assert.ok(isRecord(kase) && typeof kase['id'] === 'string', `${source}: a case of ${group} has an id`);
      const raises = kase['raises'];
      // The text "callback" names the error that a callback of the case raises, which has no kind of the contract.
      if (raises === undefined || raises === 'callback') return { id: kase['id'] };
      assert.ok(isRecord(raises) && typeof raises['kind'] === 'string' && typeof raises['category'] === 'string' && typeof raises['message'] === 'string', `${source}: ${kase['id']} raises a kind, a category and a message`);
      return { id: kase['id'], raises: { kind: raises['kind'], category: raises['category'], message: raises['message'] } };
    })];
  }));
}
// The case files that the contract names, as binding check reads them.
const contractCaseFiles = (contract: Contract): Map<string, unknown> => new Map([...new Set(contract.cases.map(row => row.file))].map(file => [file, JSON.parse(text(file)) as unknown]));
// casesWithout returns the case files without the cases that raise one of kinds in a group of a member other than keep. A
// kind that a member declares is shown by a case of any member of the same library and form of call (binding CK-22,
// B2.376), so only the files without the cases of the other members show which kinds the cases of keep raise themselves.
function casesWithout(contract: Contract, caseFiles: ReadonlyMap<string, unknown>, kinds: string[], keep?: string): Map<string, unknown> {
  const kept = new Set(contract.cases.filter(row => row.member !== undefined && row.member === keep).map(row => `${row.file}\0${row.group}`));
  return new Map([...caseFiles].map(([file, document]) => [file, Object.fromEntries(caseFileGroups(document, file).map(([group, cases]) => {
    if (kept.has(`${file}\0${group}`)) return [group, cases];
    return [group, cases.filter(kase => {
      const raises = isRecord(kase) ? kase['raises'] : undefined;
      const kind = isRecord(raises) ? raises['kind'] : undefined;
      return typeof kind !== 'string' || !kinds.includes(kind);
    })];
  }))]));
}
// The CK-22 messages of binding's check at the member of path, on the given case files.
const raiseFindings = (contract: Contract, caseFiles: ReadonlyMap<string, unknown>, path: string): string[] => checkContract(contract, { caseFiles })
  .filter(finding => finding.check === 'CK-22' && (finding.path === path || finding.path.startsWith(`${path}/`))).map(finding => `${finding.path}: ${finding.message}`);
const trackedFiles = (pattern: string) => execFileSync('git', ['ls-files', '-z', pattern], { cwd: repository }).toString().split('\0').filter(Boolean).filter(notVendored);
const scriptTexts = await scriptCommands(repository.pathname, trackedFiles('*'));
const trackedAll = new Set(trackedFiles('*'));

caseTest('T493-1: the interface declares every binding error category (CORE-6)', () => {
  const contract = interfaceContract();
  const findings = checkContract(contract).filter(finding => finding.check === 'CK-10');
  assert.deepEqual(findings, [], findings.map(finding => `${finding.path}: ${finding.message}`).join('\n'));
  const withoutIo = structuredClone(contract);
  delete withoutIo.errors.classes.io;
  const missing = checkContract(withoutIo).filter(finding => finding.check === 'CK-10');
  assert.deepEqual(missing.map(finding => finding.message), ['php', 'python', 'node', 'wasm'].map(language => `the category io has no ${language} class (E-2)`));
});

caseTest('T493-2: the value alias preserves each kind across its native representations (CORE-124)', () => {
  const contract = interfaceContract();
  const findings = checkContract(contract).filter(finding => ['CK-8', 'CK-78'].includes(finding.check));
  assert.deepEqual(findings, [], findings.map(finding => `${finding.path}: ${finding.message}`).join('\n'));
  const native = structuredClone(contract);
  const alias = native.units.find(unit => unit.id === 'orm_value');
  assert.ok(alias?.out, 'the value alias declares its outgoing kinds');
  const integer = alias.out.find(row => row.kind === 'int');
  assert.ok(integer, 'the alias keeps the int kind distinct from int64');
  integer.make.php = 'int';
  const missing = checkContract(native).filter(finding => finding.check === 'CK-8');
  assert.equal(missing.length, 1, JSON.stringify(missing));
  assert.ok(missing[0]?.path.endsWith('/make/php'), JSON.stringify(missing));
});
caseTest('T493-3: query.new receives only validated immutable binding schemas (CORE-125)', () => {
  const contract = interfaceContract();
  const schema = contract.units.find(unit => unit.id === 'schema');
  const queryIndex = contract.units.findIndex(unit => unit.id === 'query');
  const query = contract.units[queryIndex];
  const newIndex = query?.members?.findIndex(member => member.id === 'query.new');
  const queryNew = newIndex === undefined ? undefined : query?.members?.[newIndex];
  assert.ok(schema && queryNew && newIndex !== undefined, 'the contract declares Schema and Query.new');
  const path = `/units/${queryIndex}/members/${newIndex}`;
  const caseFiles = contractCaseFiles(contract);
  assert.deepEqual(raiseFindings(contract, caseFiles, path), [], 'every kind that query.new declares has a case');
  assert.deepEqual(queryNew.raises, ['polyspec_orm::Kind::EntityUnknown']);
  assert.equal(schema.constructible, false);
  assert.equal(schema.final, true);
  assert.deepEqual(schema.members?.map(member => member.id), ['schema.load', 'schema.hash'], 'Schema has no writable property or mutation method');
  const namesSchema = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(namesSchema);
    if (typeof value !== 'object' || value === null) return false;
    return ('unit' in value && value.unit === 'schema') || Object.values(value).some(namesSchema);
  };
  const factories = contract.units.flatMap(unit => (unit.members ?? []).filter(member => namesSchema(member.returns)).map(member => member.id));
  assert.deepEqual(factories, ['schema.load'], 'only the validating factory returns an admitted Schema');
  const load = schema.members?.find(member => member.id === 'schema.load');
  assert.deepEqual(load?.raises, ['polyspec_orm::Kind::SchemaInvalid', 'polyspec_orm::Kind::SchemaHashMismatch']);
  const groups = caseGroups(caseFiles.get('contracts/interface/core.json'), 'contracts/interface/core.json');
  const validationKinds = [...new Set(groups['schema.load']?.map(kase => kase.raises?.kind).filter(kind => kind !== undefined))].sort();
  assert.deepEqual(validationKinds, ['schema_hash_mismatch', 'schema_invalid'], 'validation failures keep their Schema.load cases');
  const change = contract.changes.find(row => row.id === 'query_new_validated_schema_errors');
  assert.ok(change, 'the contract records the binding error inventory correction');
  assert.equal(change.rule, 'CORE-125');
  assert.equal(change.to, 'query.new');
  assert.deepEqual(Object.keys(change.from).sort(), [...contract.targets].sort(), 'the correction names every binding language');
  // Query.new declares entity_unknown, and CK-22 holds it to a case: without the cases that raise it, the declaration is a
  // finding.
  const missing = (kind: string, at: number) => `${path}/raises/${at}: no case of query.new raises the kind ${kind} (K-1, B-4)`;
  assert.deepEqual(groups['query.new']?.map(kase => ({ id: kase.id, kind: kase.raises?.kind })), [
    { id: 'entity_of_the_schema', kind: undefined }, { id: 'entity_unknown', kind: 'entity_unknown' },
  ], 'no case of Query.new has a schema validation failure as its outcome');
  assert.deepEqual(raiseFindings(contract, casesWithout(contract, caseFiles, ['entity_unknown']), path), [missing('entity_unknown', 0)]);
  // The declarations that CORE-125 removed name kinds that only cases of other members raise. A case of any member of the
  // same library and form of call shows a kind (binding CK-22, B2.376), so on the case files as they are the cases of
  // Schema.load cover the restored declarations; on the case files that keep those kinds only in the cases of Query.new,
  // the declared inventory has every case and each restored declaration is a finding.
  const validation = ['schema_invalid', 'schema_hash_mismatch'];
  const ownCases = casesWithout(contract, caseFiles, validation, 'query.new');
  assert.deepEqual(raiseFindings(contract, ownCases, path), [], 'the inventory of Query.new needs no case of a schema validation failure');
  const obsolete = structuredClone(contract);
  const oldNew = obsolete.units[queryIndex]?.members?.[newIndex];
  assert.ok(oldNew, 'the mutation finds Query.new');
  oldNew.raises = ['polyspec_orm::Kind::EntityUnknown', 'polyspec_orm::Kind::SchemaInvalid', 'polyspec_orm::Kind::SchemaHashMismatch'];
  assert.deepEqual(raiseFindings(obsolete, caseFiles, path), [], 'the cases of Schema.load show the kinds for every member of the library that declares them');
  assert.deepEqual(raiseFindings(obsolete, ownCases, path), [missing('schema_invalid', 1), missing('schema_hash_mismatch', 2)],
    'no case of Query.new raises a restored kind, so each restored declaration is a finding once no other member shows it');
});

caseTest('T493-4: query.value preserves the admitted descriptor error inventory (CORE-126)', () => {
  const contract = interfaceContract();
  const queryIndex = contract.units.findIndex(unit => unit.id === 'query');
  const query = contract.units[queryIndex];
  const valueIndex = query?.members?.findIndex(member => member.id === 'query.value');
  const value = valueIndex === undefined ? undefined : query?.members?.[valueIndex];
  assert.ok(query && value && valueIndex !== undefined, 'the contract declares Query.value');
  const path = `/units/${queryIndex}/members/${valueIndex}`;
  const caseFiles = contractCaseFiles(contract);
  const groups = caseGroups(caseFiles.get('contracts/interface/core.json'), 'contracts/interface/core.json');
  const missing = (kind: string, at: number) => `${path}/raises/${at}: no case of query.value raises the kind ${kind} (K-1, B-4)`;
  assert.deepEqual(raiseFindings(contract, caseFiles, path), [], 'every kind that query.value declares has a case');
  assert.deepEqual(value.raises, ['polyspec_orm::Kind::ColumnUnknown', 'polyspec_orm::Kind::ColumnUnselected', 'polyspec_orm::Kind::CodecDecode', 'polyspec_orm::Kind::Internal']);
  assert.equal(query.constructible, false);
  assert.equal(query.final, true);
  const returnedUnits = (type: unknown): string[] => typeof type === 'object' && type !== null
    ? Object.entries(type).flatMap(([key, item]) => key === 'unit' && typeof item === 'string' ? [item] : returnedUnits(item)) : [];
  const routes = contract.units.flatMap(unit => (unit.members ?? []).filter(member => returnedUnits(member.returns).includes('query')).map(member => member.id)).sort();
  assert.deepEqual(routes, [
    'query.create', 'query.get', 'query.get_by', 'query.new', 'query.related', 'query.related_rows', 'query.restore', 'query.restore_or_create',
    'query.save', 'rows.first', 'rows.get', 'rows.values',
  ], 'the admitted Query-returning routes preserve the descriptor');
  assert.deepEqual(groups['query.value']?.map(kase => ({ id: kase.id, raises: kase.raises })), [
    { id: 'a_query_that_read_no_row', raises: { kind: 'column_unselected', category: 'value', message: 'column_unselected: clock_event.label was not loaded or assigned' } },
    { id: 'no_column_of_the_entity', raises: { kind: 'column_unknown', category: 'value', message: 'column_unknown: clock_event.missing' } },
  ], 'both existing direct column-error cases remain');
  const change = contract.changes.find(row => row.id === 'query_value_validated_descriptor_errors');
  assert.ok(change, 'the contract records the error inventory correction');
  assert.equal(change.rule, 'CORE-126');
  assert.equal(change.to, 'query.value');
  assert.deepEqual(Object.keys(change.from).sort(), [...contract.targets].sort());
  assert.deepEqual(groups['query.value.sqlite']?.map(kase => ({ id: kase.id, kind: kase.raises?.kind })), [{ id: 'a_json_cell_with_a_lone_surrogate', kind: 'codec_decode' }],
    'query.value.sqlite holds the stored-row codec case');
  // The cases of Query.value alone show each kind that it declares outside the category internal: the case files that keep
  // those kinds only in the cases of Query.value give no finding, and without the one case of column_unselected, which no
  // other member raises, its declaration is a finding.
  const declared = ['column_unknown', 'column_unselected', 'codec_decode'];
  assert.deepEqual(raiseFindings(contract, casesWithout(contract, caseFiles, declared, 'query.value'), path), [], 'the cases of Query.value raise each kind of its inventory');
  assert.deepEqual(raiseFindings(contract, casesWithout(contract, caseFiles, ['column_unselected']), path), [missing('column_unselected', 1)]);
  // The declarations that CORE-126 removed name kinds that only cases of other members raise: Schema.load and Query.new
  // show them for every member of the same library and form of call (binding CK-22, B2.376), so the restored declarations
  // are findings exactly where the case files keep those kinds only in the cases of Query.value.
  const removed = ['schema_invalid', 'schema_hash_mismatch', 'entity_unknown'];
  const ownCases = casesWithout(contract, caseFiles, removed, 'query.value');
  assert.deepEqual(raiseFindings(contract, ownCases, path), [], 'the inventory of Query.value needs no case of a schema or entity failure');
  const obsolete = structuredClone(contract);
  const oldValue = obsolete.units[queryIndex]?.members?.[valueIndex];
  assert.ok(oldValue?.raises, 'the mutation finds Query.value errors');
  oldValue.raises.push('polyspec_orm::Kind::SchemaInvalid', 'polyspec_orm::Kind::SchemaHashMismatch', 'polyspec_orm::Kind::EntityUnknown');
  assert.deepEqual(raiseFindings(obsolete, caseFiles, path), [], 'the cases of Schema.load and Query.new show the kinds for every member of the library that declares them');
  assert.deepEqual(raiseFindings(obsolete, ownCases, path), removed.map((kind, at) => missing(kind, 4 + at)),
    'no case of Query.value raises a restored kind, so each restored declaration is a finding once no other member shows it');
});

// No clock ends a test case in any runtime (T473, T474): a machine under load runs the same work more slowly, and the result of
// a case must not change with that load. No harness keeps a case class, a step budget or a step guard.
caseTest('no test harness holds a deadline, a step budget or a step guard', () => {
  const harnesses = ['tests/testcase.mts', 'legacy/packages/go/testcase/testcase.go', 'legacy/packages/python/tests/testcase.py', 'packages/rust/testcase/src/lib.rs'];
  for (const path of harnesses) assert.doesNotMatch(text(path), /StepGuard|stepGuard|step_budget|stepBudget|STEP_BUDGET|watchdog|\bGRACE\b|\bGrace\b/, path);
  assert.equal(trackedAll.has('legacy/packages/go/testcase/stall.go'), false, 'the Go step guard is removed');
});

// A test that checks a lock wait or aborts a waiting statement on PostgreSQL or SQLite orders its steps by an event of the
// database (T475): the LOG message "still waiting for" that a PostgreSQL session receives while its statement waits, the
// statement trigger that cancels a waiting session of the test when a client statement starts, and the busy handler in which
// a SQLite statement sleeps. Polling and timers make the result depend on the load of the machine.
caseTest('the PostgreSQL and SQLite lock-wait and abort tests wait for an event, not for a poll or a timer', () => {
  const polled = /setTimeout|usleep|time\.sleep|time\.Sleep|tokio::time::sleep|microtime|monotonic|Instant::now|WithTimeout/;
  const waiters = ['legacy/packages/ts/tests/was-inserted.mjs', 'legacy/packages/python/tests/test_was_inserted.py', 'legacy/packages/php/tests/WasInsertedTest.php', 'legacy/packages/php-ext/tests/UtilsNativeTest.php', 'packages/rust/tests/cases/was_inserted.rs', 'legacy/packages/go/orm/write_set_test.go'];
  for (const path of waiters) assert.doesNotMatch(text(path), polled, path);
  const reporters = ['legacy/packages/ts/tests/lock-wait.mjs', 'legacy/packages/python/tests/was_inserted_child.py', 'legacy/packages/php/tests/was_inserted_child.php', 'packages/rust/tests/cases/common/lock_wait.rs', 'legacy/packages/go/orm/lock_wait_test.go'];
  for (const path of reporters) assert.ok(trackedAll.has(path) && /still waiting for/.test(text(path)), `${path} waits for the LOG message of the waiting session`);
  for (const path of ['legacy/packages/ts/tests/model.mjs', 'legacy/packages/ts/tests/coverage_transactions.mjs']) assert.match(text(path), /statementStarts/, `${path} aborts a PostgreSQL statement after the event of its start`);
  const cancel = text('legacy/packages/go/orm/cancel_test.go');
  assert.doesNotMatch(cancel, /sqliteCancelAfter|time\.AfterFunc/, 'the SQLite case of cancel_test.go cancels on no timer');
  assert.match(cancel, /synctest\.Wait/, 'the SQLite case of cancel_test.go cancels when the statement sleeps in the busy handler');
  assert.match(cancel, /statementStarts/, 'the PostgreSQL cases of cancel_test.go cancel after the event of the statement start');
  // On MySQL and MariaDB, and for a PostgreSQL SELECT ... FOR UPDATE, the abort follows the lock wait timeout that the server
  // returns to a probe session by its own setting, not a timer and not a read of the lock tables.
  assert.doesNotMatch(cancel, /awaitLockWait|metadata_locks|pg_stat_activity/, 'cancel_test.go reads no lock table');
  assert.match(cancel, /openLockProbe/, 'cancel_test.go cancels after the lock wait timeout of a probe');
  for (const path of ['legacy/packages/ts/tests/model.mjs', 'legacy/packages/ts/tests/coverage_transactions.mjs']) {
    assert.match(text(path), /lockWaitEnds/, `${path} aborts a MySQL statement after the lock wait timeout of a probe`);
    assert.doesNotMatch(text(path), /setTimeout\(\(\) => \w+\.abort\(\)/, `${path} aborts on no timer`);
  }
  // The Rust cases that drop a waiting statement or transaction drop it after the LOG message of the PostgreSQL wait or the
  // answer of a probe, not after a timer.
  const zone = text('packages/rust/tests/cases/zone.rs');
  const dropping = zone.slice(zone.indexOf('async fn dropping_a_query_cancels_it_servers()'), zone.indexOf('pub fn trials()'));
  assert.doesNotMatch(dropping, polled, 'the dropping cases of zone.rs wait on no timer');
  assert.doesNotMatch(dropping, /tokio::time::timeout/, 'the dropping cases of zone.rs drop on no timer');
  assert.match(dropping, /statement_waits/, 'the dropping cases of zone.rs drop after the wait of the statement');
  // A step that ends a session whose next statement reads the error of that end does not wait for the end with a bound.
  for (const path of ['legacy/packages/ts/tests/recipe.mjs', 'legacy/packages/go/internal/recipe/database.go', 'legacy/packages/python/tests/recipe.py', 'legacy/packages/php/tests/Recipe.php', 'legacy/packages/php/tests/RollbackTest.php', 'packages/rust/programs/src/recipe.rs']) {
    assert.doesNotMatch(text(path), /pg_terminate_backend\([^)]*,/, `${path} ends a session without a bound on its end`);
  }
  // An idle pool connection of INT-195 holds a named lock on MySQL and MariaDB, and GET_LOCK of that lock answers when the killed
  // thread has ended, so no case reads PROCESSLIST until the session is gone.
  for (const path of ['legacy/packages/ts/tests/idle-connection-end.mjs', 'legacy/packages/go/orm/timezone_test.go', 'legacy/packages/python/tests/connection_pool.py', 'packages/rust/tests/cases/zone.rs']) {
    // zone.rs holds other cases; the INT-195 case and its release helper end before the next case.
    const whole = text(path);
    const source = path.endsWith('zone.rs') ? whole.slice(whole.indexOf('async fn pool_discards_ended_idle_connection_servers'), whole.indexOf('fn statement_timeout_negative_is_unrepresentable')) : whole;
    assert.match(source, /IS_USED_LOCK/, `${path} reads once that the idle connection holds the named lock`);
    assert.match(source, /GET_LOCK\(\?, 30\)|GET_LOCK\(%s, 30\)/, `${path} waits for the end of the killed thread with GET_LOCK`);
    assert.doesNotMatch(source, /setTimeout|time\.sleep|time\.Sleep|tokio::time::sleep|Instant::now|monotonic|time\.Now\(\)\.Add|deadline/, `${path} waits on no timer`);
  }
});

caseTest('the Go PostgreSQL pool checks a reused connection with a Sync and no query', () => {
  // The pool checks before each reuse that the server still holds the connection, at any idle time (INT-195, T476). The
  // check is a protocol Sync read to its ReadyForQuery in OptionResetSession, and the "-- ping" query of pgx is off: the
  // server runs that query as a transaction of its own, which counts against the transactions of a statement (INT-149, T642).
  const source = text('legacy/packages/go/orm/pg/pg.go');
  assert.match(source, /stdlib\.OptionResetSession\(/, 'the connector of orm/pg checks a reused connection in OptionResetSession');
  assert.match(source, /StartPipeline\(ctx\)[\s\S]*\.Sync\(\)[\s\S]*\.Close\(\)/, 'the check sends a Sync through a pipeline and reads to its ReadyForQuery');
  assert.match(source, /stdlib\.OptionShouldPing\(func\(context\.Context, stdlib\.ShouldPingParams\) bool \{ return false \}\)/, 'the ping of the driver is off');
});

caseTest('every PHPUnit test class declares its size', () => {
  // The size states the kind of a case: #[Small] computes in memory, #[Medium] runs statements on a database, #[Large] runs a
  // child process (phpunit.xml.dist); no size sets a time limit.
  const unsized = [...trackedAll].filter(path => /^legacy\/packages\/php(?:-ext)?\/tests\/.*Test\.php$/.test(path)).filter(path => {
    const source = text(path);
    return /^(?:final )?class \w+Test\b/m.test(source) && !/^#\[(?:\\PHPUnit\\Framework\\Attributes\\)?(?:Small|Medium|Large)\]\s*\n(?:#\[.*\]\s*\n|\/\/.*\n)*(?:final )?class /m.test(source);
  });
  assert.deepEqual(unsized, []);
});

const readScript = (path: string) => scriptTexts.get(path) ?? (trackedAll.has(path) && !path.endsWith('.mts') ? text(path) : undefined);
const trackedTexts = (paths: string[]) => Object.fromEntries(paths.map((path: string) => [path, text(path)]));

caseTest('dbspec-apply-stress-bench runs the stress case on the databases it names', () => {
  const dryRun = (...variables: string[]) => spawnSync('make', ['-n', ...variables, 'dbspec-apply-stress-bench'], { cwd: repository.pathname, encoding: 'utf8', env: isolatedEnvironment() });
  const tests = text('legacy/packages/go/orm/recipe_dbspec_apply_test.go');
  for (const [dialects, names] of [['mysql', 'Mysql'], ['postgres|sqlite', 'Postgres|Sqlite'], ['mysql|postgres|sqlite', 'Mysql|Postgres|Sqlite']] as const) {
    const result = dryRun(`APPLY_STRESS_DIALECTS=${dialects}`);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`./legacy/packages/go/orm -run '^TestRecipeDbspecApply(${names})$/^stress_plan_commits_each_step$' -count=1`), result.stdout);
    for (const name of names.split('|')) assert.ok(tests.includes(`func TestRecipeDbspecApply${name}(`), name);
  }
  for (const dialects of ['', 'oracle']) {
    assert.notEqual(dryRun(`APPLY_STRESS_DIALECTS=${dialects}`).status, 0, dialects);
  }
});
caseTest('the Go model build regenerates models', () => {
  const root = new URL('../..', import.meta.url).pathname;
  const result = spawnSync('make', ['-n', 'build-go'], { cwd: root, encoding: 'utf8', env: isolatedEnvironment() });
  assert.equal(result.status, 0, result.stderr);
  const generation = result.stdout.indexOf('go run ./cmd/orm-gen sets');
  assert.ok(generation >= 0, 'build-go does not run the Go model generator');
  assert.match(result.stdout, /go run \.\/cmd\/orm-gen sets/);
});

// A model generator's key covers the directory of the document set of each of its entries, which holds the set and its documents, so a
// fixture change regenerates the models that it is read into: the Go and PHP keys once named only their own package.
caseTest('the key of a model generator covers the document set of each of its entries', () => {
  const root = new URL('../..', import.meta.url).pathname;
  const sets = (file: string, base: string) => [...text(file).matchAll(/^--set (\S+)/gm)].map(match => posix.dirname(posix.normalize(posix.join(base, match[1] ?? ''))));
  const expected: [string, string[]][] = [
    ['go-models', sets('legacy/packages/go/models.txt', 'legacy/packages/go')],
    ['php-models', sets('legacy/packages/php/models.txt', '.')],
    ['python-models', [posix.dirname(/^PYTHON_MODELS_SET = (\S+)$/m.exec(text('Makefile'))?.[1] ?? '')]],
  ];
  for (const [target, dirs] of expected) {
    const result = spawnSync('make', ['-n', '--no-print-directory', target], { cwd: root, encoding: 'utf8', env: isolatedEnvironment() });
    assert.equal(result.status, 0, result.stderr);
    const line = result.stdout.split('\n').find(entry => entry.includes('once.mts') && entry.includes(`/${target}.key `));
    assert.ok(line !== undefined, `${target} runs no keyed generator: ${result.stdout}`);
    const inputs = (line.split(' -- ')[0] ?? '').split(/\s+/).map(path => path.replace(/\/$/, ''));
    for (const dir of dirs) assert.ok(inputs.includes(dir), `${target} does not key on ${dir}: ${line.split(' -- ')[0]}`);
  }
});

caseTest('the TypeScript runtime build generates models before compiling their consumers', () => {
  const root = new URL('../..', import.meta.url).pathname;
  const result = spawnSync('make', ['-n', 'build-ts'], { cwd: root, encoding: 'utf8', env: isolatedEnvironment() });
  assert.equal(result.status, 0, result.stderr);
  const generation = result.stdout.indexOf('npm run typescript:build');
  const build = /runtime-targets\.(?:mjs|mts) build --roots legacy\/packages\/ts /.exec(result.stdout)?.index ?? -1;
  assert.ok(generation >= 0, 'build-ts does not run the TypeScript model generator');
  assert.ok(build >= 0, 'build-ts does not invoke the TypeScript runtime build');
  assert.ok(generation < build, 'build-ts compiles consumers before refreshing generated models');
});

// The Rust recipe public_interface runs tests/interfaces/check/main.mts through packages/rust/programs/src/recipe.rs, and that
// check reads the entity order from legacy/packages/ts/dist; typescriptReaderErrors sees only the node runs of a recipe, so this
// test states the prerequisite of test-rust (T339-5-1).
caseTest('the Rust unit tests build and hold the TypeScript client that the interface check reads (T339-5-1)', () => {
  const root = new URL('../..', import.meta.url).pathname;
  const result = spawnSync('make', ['-n', '--no-print-directory', 'test-rust'], { cwd: root, encoding: 'utf8', env: isolatedEnvironment() });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split('\n');
  const build = lines.findIndex(line => line.includes('scripts/typescript/build.mts --current'));
  const hold = lines.findIndex(line => / hold \S+ shared --wait --pid /.test(line));
  const tests = lines.findIndex(line => /tests\/cargo-test\.mts test-rust -- cargo test /.test(line));
  assert.ok(tests >= 0, `test-rust runs no cargo tests through tests/cargo-test.mts: ${result.stdout}`);
  assert.ok(build >= 0 && build < tests, `test-rust runs the cargo tests without building the TypeScript client first (typescript-current): ${result.stdout}`);
  assert.ok(hold > build && hold < tests, `test-rust does not hold the TypeScript client while its tests read it ($(READ_TYPESCRIPT)): ${result.stdout}`);
});

// The Go tests of the repository build with GO_TEST_TAGS of tests/go-test.mts: without ormtest the recipe steps fault.next_rollback,
// fault.next_statement and db.last_affected fail on SQLite. The interface_symbols case of the Go recipe runs
// interfaces/error-catalogs, which reads the generated error file of every implementation (orm-codes) (T449).
caseTest('the Go unit tests take the build tags of the Go runner and the generated error files (T449)', () => {
  const root = new URL('../..', import.meta.url).pathname;
  const result = spawnSync('make', ['-n', '--no-print-directory', 'test-go'], { cwd: root, encoding: 'utf8', env: isolatedEnvironment() });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split('\n');
  const tests = lines.findIndex(line => /runtime-targets\.(?:mjs|mts) test --runner go /.test(line));
  assert.ok(tests >= 0, `test-go runs no go tests: ${result.stdout}`);
  const tags = /export const GO_TEST_TAGS = \[([^\]]*)\]/.exec(readFileSync(join(root, 'tests/go-test.mts'), 'utf8'))?.[1]?.replaceAll(/['\s]/g, '');
  assert.ok(tags, 'tests/go-test.mts declares no GO_TEST_TAGS');
  assert.ok(lines[tests]?.split(' ').includes(`-tags=${tags}`), `test-go runs the go tests without -tags=${tags}, the tags of GO_TEST_TAGS: ${lines[tests]}`);
  for (const file of ['legacy/packages/ts/src/orm-codes.key', 'legacy/packages/php/src/orm-codes.key', 'legacy/packages/python/src/polyspec/orm/orm-codes.key']) {
    const codes = lines.findIndex(line => line.includes('scripts/generate/once.mts') && line.includes(file));
    assert.ok(codes >= 0 && codes < tests, `test-go runs the go tests without writing the error file of ${file} first (orm-codes): ${result.stdout}`);
  }
});

// The bind recipes of the Python tests (tests/bind/messages.json and its variants, the markdown.send and markdown.builder
// steps) import the slot models that ORM_PYTHON_BIND_MODELS names, which bind-python-models writes, as python-unit-check
// gives them; without them every such case fails with `ORM_PYTHON_BIND_MODELS names no model directory` (T451).
caseTest('the Python unit tests take the slot models of the bind recipes (T451)', () => {
  const root = new URL('../..', import.meta.url).pathname;
  const result = spawnSync('make', ['-n', '--no-print-directory', 'test-python'], { cwd: root, encoding: 'utf8', env: isolatedEnvironment() });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split('\n');
  // The tests run through the case harness of the package, which gives testcase.step its case (T452).
  // The tests are the offline selection of scripts/repo/offline-tests.mts, which the line before wrote (T580).
  const tests = lines.findIndex(line => /run-tests\.(?:mjs|mts) python .*--module legacy\.packages\.python\.tests\.testcase -- \$\(cat \S+\/offline-tests\)/.test(line));
  assert.ok(tests >= 0, `test-python runs no python tests through the case harness: ${result.stdout}`);
  const models = join(root, '.runtime/run/bind-python-models');
  const written = lines.findIndex(line => line.includes('orm-gen gen --set legacy/tests/bind/dbspec-set.json') && line.includes(`${models}.tmp`));
  assert.ok(written >= 0 && written < tests, `test-python runs the python tests without writing the slot models first (bind-python-models): ${result.stdout}`);
  const selected = spawnSync('make', ['-n', '--no-print-directory', 'test-python', 'CASES=test_split_plan'], { cwd: root, encoding: 'utf8', env: isolatedEnvironment() });
  assert.equal(selected.status, 0, selected.stderr);
  assert.match(selected.stdout, /-- \$\(cat \S+\/offline-tests\) -k '?test_split_plan'?;/, `test-python does not give CASES to the run as -k: ${selected.stdout}`);
  const variable = /^test-python: export ORM_PYTHON_BIND_MODELS = \$\(BIND_PY_MODELS\)$/m;
  assert.match(text('Makefile'), variable, 'test-python does not export ORM_PYTHON_BIND_MODELS = $(BIND_PY_MODELS)');
});

// run-tests counts the Python tests through the result class that it gives unittest.TextTestRunner, and the case harness of
// the package runs every test; a harness that replaces that class leaves every run at `0 passed, 0 failed, no test ran`,
// whatever unittest ran (T569). The case runs the command of the recipe of test-python on a tree of its own, with the
// interpreter of the venv that the recipe names, which make orm-install-python writes.
caseTest('run-tests counts the Python tests that the case harness runs (T569)', () => {
  const root = new URL('../..', import.meta.url).pathname;
  const dry = spawnSync('make', ['-n', '--no-print-directory', 'test-python'], { cwd: root, encoding: 'utf8', env: isolatedEnvironment() });
  assert.equal(dry.status, 0, dry.stderr);
  const recipe = dry.stdout.split('\n').find(line => /run-tests\.(?:mjs|mts) python .*--module legacy\.packages\.python\.tests\.testcase -- \$\(cat \S+\/offline-tests\)/.test(line));
  assert.ok(recipe !== undefined, `test-python runs no python tests through the case harness: ${dry.stdout}`);
  const runner = recipe.slice(0, recipe.indexOf(' -- $(cat ')).trim();
  const venv = / --venv (\S+)/.exec(runner)?.[1];
  assert.ok(venv !== undefined, `the recipe of test-python names no venv: ${recipe}`);
  assert.ok(existsSync(join(venv, 'bin/python')), `${join(venv, 'bin/python')} is missing; run make orm-install-python, which writes it`);
  const directory = mkdtempSync(join(tmpdir(), 'orm-python-count-'));
  try {
    writeFileSync(join(directory, 'sample.py'), [
      'import unittest',
      'from legacy.packages.python.tests import testcase',
      '',
      '',
      'class Sample(unittest.TestCase):',
      '    def test_pass(self):',
      "        testcase.step('one step')",
      '',
      '    def test_fail(self):',
      '        self.assertEqual(1, 2)',
      '',
    ].join('\n'));
    const run = (pattern: string) => {
      const result = spawnSync('sh', ['-c', `${runner} -- discover -s "$1" -t "$1" -p sample.py -k "$2"`, 'sh', directory, pattern], { cwd: root, encoding: 'utf8', env: isolatedEnvironment() });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    };
    const passed = run('test_pass');
    assert.match(passed.output, /: 1 passed, 0 failed, 0 skipped/, passed.output);
    assert.equal(passed.status, 0, passed.output);
    const failed = run('test_fail');
    assert.match(failed.output, /: 0 passed, 1 failed, 0 skipped/, failed.output);
    assert.notEqual(failed.status, 0, failed.output);
    const none = run('no_such_case');
    assert.match(none.output, /no test ran/, none.output);
    assert.notEqual(none.status, 0, none.output);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// QueryCancellationTest loads the SQLite cancellation helper that php-cancel-helper-build writes, and the tests read the
// models of php-models; without them a run of make test-php in a fresh checkout fails with
// `SQLite cancellation helper for <platform> is not installed in the polyspec/orm package` (T453).
caseTest('the PHP unit tests take the generated models and the SQLite cancellation helper (T453)', () => {
  const root = new URL('../..', import.meta.url).pathname;
  const result = spawnSync('make', ['-n', '--no-print-directory', 'test-php'], { cwd: root, encoding: 'utf8', env: isolatedEnvironment() });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split('\n');
  const tests = lines.findIndex(line => /runtime-targets\.(?:mjs|mts) test --runner php /.test(line));
  assert.ok(tests >= 0, `test-php runs no php tests: ${result.stdout}`);
  const helper = lines.findIndex(line => line.includes('legacy/packages/php/bin/orm-sqlite-cancel-build.php'));
  assert.ok(helper >= 0 && helper < tests, `test-php runs the php tests without building the SQLite cancellation helper first (php-cancel-helper-build): ${result.stdout}`);
  const models = lines.findIndex(line => line.includes('scripts/generate/once.mts') && line.includes('legacy/packages/php/gen/php-models.key'));
  assert.ok(models >= 0 && models < tests, `test-php runs the php tests without writing the PHP models first (php-models): ${result.stdout}`);
});

caseTest('the Makefile includes no recipe file of @polyspec/kit', () => {
  // kit 0.0.98 ships no recipes (kit docs/spec/utilities-and-recipes.md): the Makefile states its own targets, which run the
  // utilities of the installed package, and exports its own CARGO_TARGET_DIR, which no include unexports.
  const makefile = text('Makefile');
  assert.deepEqual(makefile.split('\n').filter(line => /^\s*-?include\b.*@polyspec\/kit/.test(line)), []);
  assert.match(makefile, /^export CARGO_TARGET_DIR := \$\(abspath packages\/rust\/target\)$/m);
});

// T629, T630: a recipe finds each tool where the job's own install put it, never through the PATH of the runner image: no recipe
// calls brew, and cargo is on the PATH that the Makefile exports, from the folder where the rustup of the job installs it.
caseTest('a recipe finds each tool where the job installed it, not through the runner image', () => {
  assert.deepEqual(imageToolErrors(text('Makefile')), []);
  const head = 'export PATH := $(HOME)/.cargo/bin:$(KIT_TOOLS)/bin:$(PATH)\n';
  assert.deepEqual(imageToolErrors(`${head}a:\n\tprefix="$$(brew --prefix php@8.4)"\nb:\n\tPATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_LINK) fetch\nc:\n\t$(CARGO_LINK) build\n`), [
    'a calls brew, a tool of the runner image that no job installs; read the tool where the job\'s install put it: prefix="$$(brew --prefix php@8.4)"',
    'b puts ~/.cargo/bin on PATH itself; the PATH that the Makefile exports holds it: PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_LINK) fetch',
  ]);
  assert.deepEqual(imageToolErrors('export PATH := $(KIT_TOOLS)/bin:$(PATH)\nc:\n\t$(CARGO_LINK) build\n'), [
    'the Makefile does not export a PATH that starts with $(HOME)/.cargo/bin; a recipe then finds rustup and cargo through the PATH of the runner image',
  ]);
});

caseTest('the root holds the lint configurations that the lint tools read', () => {
  // The lint utilities of kit 0.0.98 run each tool with the configuration of the repository (kit K1050).
  for (const file of ['ruff.toml', 'phpcs.xml.dist', 'phpstan.dist.neon', '.golangci.yml', 'clippy.toml', '.oxlintrc.json', 'knip.json']) {
    assert.ok(trackedAll.has(file), `${file} is tracked`);
  }
  assert.ok(!trackedAll.has('config/knip-entries.json'), 'the entries of knip live in knip.json');
});

caseTest('a script path must be a tracked file or directory', () => {
  assert.deepEqual(scriptPathErrors({ 'schema:check': 'node scripts/schema/check.mts' }, tracked), [
    'package.json script schema:check names scripts/schema/check.mts, which is not a tracked file or directory',
  ]);
  assert.deepEqual(
    scriptPathErrors(
      {
        'docs:rules-check': 'node scripts/docs/rules.mts',
        'typescript:build': 'npm --prefix legacy/packages/ts run build',
        'typescript:test': 'npm run typescript:build && node scripts/typescript/sqlite-test.mts',
        'docs:dev': 'vitepress dev docs',
      },
      tracked,
    ),
    [],
  );
});

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');

caseTest('each CI run rehearses the upload of the release after the assets, and ci-passed needs it (T628)', () => {
  const job = (name: string) => {
    const start = workflow.indexOf(`\n  ${name}:\n`);
    assert.notEqual(start, -1, `ci.yml has no job ${name}`);
    const rest = workflow.slice(start + 1);
    const end = rest.slice(1).search(/\n  [a-z][a-z-]*:\n/);
    return end === -1 ? rest : rest.slice(0, end + 1);
  };
  const rehearsal = job('release-rehearsal');
  assert.match(rehearsal, /\n    needs: \[[^\]]*\bassets\b[^\]]*\]/, 'job release-rehearsal runs after the job assets');
  assert.match(rehearsal, /pattern: assets-\*/, 'job release-rehearsal downloads the artifacts assets-*');
  assert.match(rehearsal, /path: var\/release\/platform/, 'job release-rehearsal downloads them into var/release/platform');
  assert.match(rehearsal, /run: make ci-release-rehearsal\n/, 'job release-rehearsal runs make ci-release-rehearsal');
  assert.match(rehearsal, /\n    permissions:\n      contents: read\n/, 'job release-rehearsal reads the repository only, so it can upload nothing');
  // rehearse-go-module ends with git prune, which walks HEAD to its parent, so the checkout carries the history.
  assert.match(rehearsal, /- uses: actions\/checkout@v\d+\n        with:\n          fetch-depth: 0\n/,
    'job release-rehearsal checks out the whole history, which rehearse-go-module prunes');
  assert.match(job('ci-passed'), /\n    needs: \[[^\]]*\brelease-rehearsal\b[^\]]*\]/, 'ci-passed needs release-rehearsal');
  const recipe = text('Makefile').match(/^ci-release-rehearsal:\n((?:\t.*\n)+)/m)?.[1] ?? '';
  assert.notEqual(recipe, '', 'the Makefile has a recipe ci-release-rehearsal');
  for (const target of ['release-candidate-assets', 'ci-release-platform-assets'])
    assert.match(recipe, new RegExp(`-- ${target}( (?:TAG|VERSION)=\\S+)?\\n`), `ci-release-rehearsal gathers var/release/assets with ${target}`);
  assert.match(recipe, /-- release-platform-assets TAG=v\$\(RELEASE_REHEARSAL_VERSION\) REHEARSAL=1 WORK=var\/release\/rehearsal\n/,
    'ci-release-rehearsal runs release-platform-assets with REHEARSAL=1 and WORK');
  // The Go module of the tag is rehearsed as ci-release rehearses it, after the same setup in the same order (T633).
  const steps = [...recipe.matchAll(/ -- (\S+)/g)].map(match => match[1]);
  const order = ['ci-release-platform-assets', 'orm-install-rust', 'install-tools', 'release-recipes', 'rehearse-go-module'];
  assert.deepEqual(steps.filter(step => order.includes(step ?? '')), order, `ci-release-rehearsal runs ${order.join(', ')} in this order, as ci-release does`);
  assert.match(recipe, /-- install-tools TOOLS=go\n/, 'ci-release-rehearsal installs the go of mise.toml');
  // ci-release gives its TAG to every step from its command line; the rehearsal has none, so each release step names the tag of
  // VERSION: run 44236602323 failed with `release-assets: TAG is required; run make release-assets TAG=v<version>` (T628).
  // release-candidate-assets takes VERSION, not a tag (kit K1286).
  for (const line of recipe.split('\n').filter(line => / -- (release|rehearse)-/.test(line) && !/ -- release-candidate-assets /.test(line)))
    assert.match(line, / TAG=v\$\(RELEASE_REHEARSAL_VERSION\)(\s|$)/, `the step of ci-release-rehearsal ${line.trim()} passes TAG=v$(RELEASE_REHEARSAL_VERSION)`);
  assert.match(recipe, /-- rehearse-go-module TAG=v\$\(RELEASE_REHEARSAL_VERSION\)\n/, 'ci-release-rehearsal rehearses the Go module of the tag of VERSION');
  for (const forbidden of ['release-tag', 'release-publish', 'release-undraft', 'release-go-module', 'release-go-module-push'])
    assert.doesNotMatch(recipe, new RegExp(`-- ${forbidden}\\b`), `ci-release-rehearsal runs no ${forbidden}`);
  assert.doesNotMatch(text('.github/workflows/release.yml'), /REHEARSAL/, 'release.yml gains no run without a tag (K911)');
});

caseTest('the release rehearsal builds the assets of HEAD for VERSION and reads no tag (T628)', () => {
  // Run 44293991279 failed with `[release] assets v0.0.34 failed: git rev-parse --verify refs/tags/v0.0.34^{commit} exited
  // with 128`: kit's release assets reads the tag ref, which no CI event holds. kit's candidate-assets packs the committed
  // HEAD for VERSION with no tag (K1286); release-prepare and release-tools read no tag, so they take no case.
  const result = spawnSync('make', ['-n', '--no-print-directory', 'ci-release-rehearsal'], { cwd: repository.pathname, encoding: 'utf8', env: isolatedEnvironment() });
  assert.equal(result.status, 0, result.stderr);
  const steps = result.stdout.split('\n').filter(line => / setup \S+ \S+ -- /.test(line)).map(line => line.split(' -- ')[1] ?? '');
  assert.ok(!steps.some(step => /^release-assets\b/.test(step)), `ci-release-rehearsal runs no release-assets, which reads refs/tags/<TAG>: ${steps.join('; ')}`);
  const assets = steps.find(step => /^release-candidate-assets\b/.test(step));
  assert.ok(assets !== undefined, `ci-release-rehearsal runs release-candidate-assets: ${steps.join('; ')}`);
  const version = /^release-candidate-assets VERSION=(\S*)$/.exec(assets)?.[1];
  assert.ok(version !== undefined, `release-candidate-assets names VERSION: ${assets}`);
  assert.ok(steps.includes(`rehearse-go-module TAG=v${version}`), `the Go module is rehearsed for the version of the assets, v${version}: ${steps.join('; ')}`);
});

caseTest('the CI workflow provides every variable of make orm-test-servers', () => {
  const variables = SERVER_VARIABLES;
  for (const variable of ['ORM_TEST_MYSQL_REPLICA_DSN', 'ORM_TEST_POSTGRES_REPLICA_DSN', 'ORM_TEST_PROXYSQL_DSN',
    'ORM_TEST_PGBOUNCER_DSN', 'ORM_TEST_MYSQL_TLS_DSN', 'ORM_RUN_MYSQL_DSN', 'ORM_RUN_POSTGRES_DSN',
    'ORM_RUN_SQLITE_QUERY', 'ORM_TEST_SERVERS_LEASES'])
    assert.ok(variables.includes(variable), `${variable} is not written by scripts/test-servers.mts`);
  assert.deepEqual(ciServerErrors(workflow, SERVER_VARIABLES, text('Makefile')), []);
});

// steps, serverRecipe and script are the minimal form of a group job, the recipe of its run step and the variables that
// test-servers.mts writes. Each case changes one of them.
const steps = [
  'jobs:',
  '  test:',
  '    steps:',
  '      - uses: actions/checkout@v5',
  '      - run: make ci-test GROUP=${{ matrix.group }}',
  '',
].join('\n');
const serverRecipe = [
  'ci-test: CI_NAME = $(CI_RUN)-$(GROUP)',
  'ci-test:',
  '\t@$(CI_JOB) begin $(CI_NAME) --group $(GROUP) $(CI_TARGETS_$(GROUP))',
  '\t@$(CI_JOB) setup $(CI_NAME) servers --when databases -- orm-test-servers',
  '\t@$(CI_JOB) check $(CI_NAME) -- check-run GROUP=$(GROUP)',
  '\t@$(CI_JOB) end $(CI_NAME)',
  'orm-test-servers:',
  '\tnode scripts/test-servers.mts',
  '',
].join('\n');
const script = ['ORM_TEST_MYSQL_DSN', 'ORM_TEST_PGBOUNCER_DSN'];

caseTest('a group job whose recipe starts the servers with make orm-test-servers passes', () => {
  assert.deepEqual(ciServerErrors(steps, script, serverRecipe), []);
});

caseTest('T497: a group job whose recipe starts no servers, or checks before them, fails', () => {
  const none = serverRecipe.replace('\t@$(CI_JOB) setup $(CI_NAME) servers --when databases -- orm-test-servers\n', '');
  assert.deepEqual(ciServerErrors(steps, script, none), ['the recipe ci-test of the CI group jobs does not start the database servers with a setup step servers -- orm-test-servers']);
  const late = serverRecipe.replace('\t@$(CI_JOB) setup $(CI_NAME) servers --when databases -- orm-test-servers\n', '').replace('\t@$(CI_JOB) end', '\t@$(CI_JOB) setup $(CI_NAME) servers --when databases -- orm-test-servers\n\t@$(CI_JOB) end');
  assert.deepEqual(ciServerErrors(steps, script, late), ['the recipe ci-test runs its check before the setup step servers starts the database servers']);
});

caseTest('a workflow that defines a server variable itself fails', () => {
  const defined = steps.replace('    steps:', '    env:\n      ORM_TEST_MYSQL_DSN: "mysql://root@127.0.0.1:3306/orm_test"\n    steps:');
  assert.deepEqual(ciServerErrors(defined, script, serverRecipe), ['ci.yml defines ORM_TEST_MYSQL_DSN; make orm-test-servers defines it']);
});

caseTest('a group job whose recipe creates a symbolic link fails', () => {
  for (const command of ['ln -s a b', 'sudo ln -sf /usr/lib/a.so.1t64 /usr/lib/a.so.1', 'ln --symbolic a b', `node -e "fs.symlinkSync('a', 'b')"`]) {
    const linked = serverRecipe.replace('\tnode scripts/test-servers.mts', `\t${command}`);
    assert.deepEqual(ciServerErrors(steps, script, linked), ['ci.yml job test creates a symbolic link through make ci-test'], command);
  }
});

// recipeJob is a workflow of one job with the steps given, and recipeTargets a Makefile that declares the ci- targets.
const recipeJob = (id: string, ...lines: string[]) => ['jobs:', `  ${id}:`, '    runs-on: ubuntu-26.04-arm', '    steps:', ...lines, ''].join('\n');
const recipeTargets = 'ci-test:\n\t@:\nci-passed:\n\t@:\nci-site:\n\t@:\n';

caseTest('T497: every job of the workflows runs one step, make ci-<job>, and its other steps provision or carry a result', () => {
  assert.deepEqual(ciRecipeErrors(workflows, text('Makefile')), []);
  const ok = recipeJob('test', '      - uses: actions/checkout@v5', '      - uses: shivammathur/setup-php@v2', '        if: ${{ matrix.php }}',
    '      - run: make ci-test GROUP=${{ matrix.group }}', '      - uses: actions/upload-artifact@v4', '        if: ${{ !cancelled() }}');
  assert.deepEqual(ciRecipeErrors({ 'ci.yml': ok }, recipeTargets), []);
  assert.deepEqual(ciRecipeErrors({ 'ci.yml': recipeJob('ci-passed', '      - uses: actions/checkout@v5', '      - env:', '          RESULTS: ${{ toJSON(needs) }}', '        run: make ci-passed FAIL_SKIPPED=1') }, recipeTargets), []);
  // A job that only carries a result runs no recipe.
  assert.deepEqual(ciRecipeErrors({ 'ci.yml': recipeJob('deploy', '      - uses: actions/deploy-pages@v4') }, recipeTargets), []);
});

caseTest('T497: a job with the content of its recipe in YAML fails', () => {
  const two = recipeJob('test', '      - run: make orm-install-go', '      - run: make ci-test GROUP=static');
  assert.deepEqual(ciRecipeErrors({ 'ci.yml': two }, recipeTargets), [
    'ci.yml job test has 2 run steps; a job runs one step, make ci-<job>, whose recipe holds the order and the conditions of the job',
    'ci.yml job test runs "make orm-install-go"; its run step is make ci-<job> with make-variable arguments only',
    'ci.yml job test step "run: make ci-test GROUP=static" is no uses: step; every step but the run step provisions the runner or carries a result',
  ]);
  const steps = recipeJob('test', '      - id: check', '        if: ${{ !cancelled() }}', '        env:', '          ORM_CI_SETUP: ${{ toJSON(steps) }}', '        run: make check-run GROUP=${{ matrix.group }}');
  assert.deepEqual(ciRecipeErrors({ 'ci.yml': steps }, recipeTargets), [
    'ci.yml job test runs "make check-run GROUP=${{ matrix.group }}"; its run step is make ci-<job> with make-variable arguments only',
    'ci.yml job test gives its run step if:; the recipe holds the conditions of the job',
    'ci.yml job test gives its run step env:; only a judgement job passes RESULTS: ${{ toJSON(needs) }}',
  ]);
  const output = recipeJob('test', '      - run: make ci-test GROUP=${{ steps.plan.outputs.group }} X=$(date)');
  assert.deepEqual(ciRecipeErrors({ 'ci.yml': output }, recipeTargets), [
    'ci.yml job test runs "make ci-test GROUP=${{ steps.plan.outputs.group }} X=$(date)"; its run step is make ci-<job> with make-variable arguments only',
  ]);
  assert.deepEqual(ciRecipeErrors({ 'ci.yml': recipeJob('test', '      - run: make ci-test GROUP=${{ steps.plan.outputs.group }}') }, recipeTargets), [
    'ci.yml job test passes GROUP=${{ steps.plan.outputs.group }}; an argument holds a literal, a matrix value or an input of a called workflow',
  ]);
  assert.deepEqual(ciRecipeErrors({ 'ci.yml': recipeJob('test', '      - run: make ci-other') }, recipeTargets), ['ci.yml job test runs make ci-other, which the Makefile does not declare']);
  assert.deepEqual(ciRecipeErrors({ 'ci.yml': recipeJob('test', '      - run: make ci-test', '      - uses: actions/cache@v4') }, recipeTargets), [
    'ci.yml job test step "uses: actions/cache@v4" follows the run step; only a step that carries a result (actions/upload-artifact, actions/upload-pages-artifact, actions/deploy-pages) follows it',
  ]);
  assert.deepEqual(ciRecipeErrors({ 'ci.yml': recipeJob('docs', '      - uses: actions/checkout@v5') }, recipeTargets), ['ci.yml job docs runs no make ci-docs step; give it one run step make ci-docs whose recipe runs the job']);
  const env = recipeJob('release', '      - run: make ci-site').replace('    steps:', '    env:\n      RUN: ${{ inputs.run || github.event.workflow_run.id }}\n      TAG: ${{ needs.tag.outputs.tag }}\n    steps:');
  assert.deepEqual(ciRecipeErrors({ 'release.yml': env }, recipeTargets), [
    'release.yml job release sets RUN to ${{ inputs.run || github.event.workflow_run.id }}; the recipe computes it, and a job passes only the token of the run and the outputs of the jobs it needs',
  ]);
});

// The node case checks the repository's mise.toml, package.json, workflow and the running Node, and the minimal
// workflow, changing one at a time.
const declared = readFileSync(new URL('mise.toml', repository), 'utf8');
const minimum = readPackage(join(repository.pathname, 'package.json')).engines?.['node'];
// The workflows of orm, every one of them a workflow that the rules of orm read (T497).
const workflows = ownWorkflows(Object.fromEntries(readdirSync(new URL('.github/workflows/', repository)).sort()
  .map(name => [`.github/workflows/${name}`, readFileSync(new URL(`.github/workflows/${name}`, repository), 'utf8')])), kitOwned);

// mise writes the tool node of mise.toml from a version, or none for an empty one.
const mise = (version: string) => version ? `[tools]\nnode = "${version}"\n` : '[tools]\n';

caseTest('the checks and every workflow run the Node of mise.toml', () => {
  assert.deepEqual(Object.keys(workflows), ['.github/workflows/assets.yml', '.github/workflows/ci-pipeline.yml', '.github/workflows/ci.yml', '.github/workflows/docs-pages.yml', '.github/workflows/documents.yml', '.github/workflows/release.yml']);
  assert.deepEqual(nodeVersionErrors(declared, minimum, workflows, process.versions.node), []);
});

const archive = 'https://github.com/polyspec/ordered-json/releases/download/v0.0.2/polyspec-ordered-json-0.0.2.tgz';
const lockOf = (resolved: string) => JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'a' }, 'node_modules/@polyspec/ordered-json': { version: '0.0.2', resolved } } });

caseTest('npm dependencies from a release archive and the registry pass', () => {
  assert.deepEqual(npmGitSourceErrors({
    'legacy/packages/ts/package.json': JSON.stringify({ dependencies: { '@polyspec/ordered-json': archive, pg: '^8.23.0' }, devDependencies: { '@types/node': '22.20.2' } }),
    'legacy/packages/ts/package-lock.json': lockOf(archive),
  }), []);
});

caseTest('a package.json dependency from git fails', () => {
  for (const spec of ['github:polyspec/ordered-json#v0.0.1', 'git+https://github.com/polyspec/ordered-json.git#v0.0.1', 'git+ssh://git@github.com/polyspec/ordered-json.git', 'polyspec/ordered-json#v0.0.1'])
    assert.deepEqual(npmGitSourceErrors({ 'package.json': JSON.stringify({ devDependencies: { '@polyspec/ordered-json': spec } }) }), [
      `package.json devDependencies @polyspec/ordered-json is ${spec}, a git source; use the release archive URL of the GitHub tag`,
    ]);
});

caseTest('a package-lock.json entry resolved from git fails', () => {
  for (const resolved of ['git+ssh://git@github.com/polyspec/ordered-json.git#f491200d3179c36afe29255b0f3ee964f6e83570', 'git://github.com/polyspec/ordered-json.git', 'ssh://git@github.com/polyspec/ordered-json.git', 'github:polyspec/ordered-json'])
    assert.deepEqual(npmGitSourceErrors({ 'legacy/packages/ts/package-lock.json': lockOf(resolved) }), [
      `legacy/packages/ts/package-lock.json resolves node_modules/@polyspec/ordered-json from ${resolved}, a git source; use the release archive URL of the GitHub tag`,
    ]);
});

const composerLockOf = (version: string) => JSON.stringify({ packages: [{ name: 'polyspec/ordered-json', version: '0.0.2' }], 'packages-dev': [{ name: 'min-0-max/json-schema', version }] });

caseTest('Composer dependencies by a release pass', () => {
  assert.deepEqual(composerBranchErrors({
    'composer.json': JSON.stringify({ require: { php: '>=8.4', 'polyspec/orm': '0.0.22' }, 'require-dev': { 'min-0-max/json-schema': '2.6.0-p2', 'phpunit/phpunit': '^13.4' } }),
    'composer.lock': composerLockOf('v2.6.0-p2'),
  }), []);
});

caseTest('a composer.json requirement of a branch fails', () => {
  for (const spec of ['dev-polyspec-origin-2.6.0', '2.6.x-dev', 'dev-main#5978fa780990500c5d85e08464b7d7a7391f93d0', '2.6.0#5978fa7'])
    assert.deepEqual(composerBranchErrors({ 'composer.json': JSON.stringify({ 'require-dev': { 'min-0-max/json-schema': spec } }) }), [
      `composer.json require-dev min-0-max/json-schema is ${spec}, a branch; require a release, which the fork names in its FORK.md`,
    ]);
});

caseTest('a composer.lock package at a branch fails', () => {
  for (const version of ['dev-polyspec-origin-2.6.0', '2.6.x-dev'])
    assert.deepEqual(composerBranchErrors({ 'legacy/packages/php-ext/composer.lock': composerLockOf(version) }), [
      `legacy/packages/php-ext/composer.lock locks min-0-max/json-schema at ${version}, a branch; require a release, which the fork names in its FORK.md`,
    ]);
});

const node = [
  'jobs:',
  '  test:',
  '    steps:',
  '      - uses: actions/setup-node@v7',
  '        with:',
  '          node-version-file: mise.toml',
  '          package-manager-cache: false',
  '      - run: npm ci',
  '',
].join('\n');

caseTest('a workflow that reads mise.toml on the declared Node passes', () => {
  assert.deepEqual(nodeVersionErrors(mise('26.8.1'), '>=22.16.0', { 'ci.yml': node }, '26.8.1'), []);
});

caseTest('a workflow that declares node-version itself fails', () => {
  const literal = node.replace('node-version-file: mise.toml', 'node-version: "22.16.0"');
  assert.deepEqual(nodeVersionErrors(mise('26.8.1'), '>=22.16.0', { 'ci.yml': literal }, '26.8.1'), [
    'ci.yml declares node-version itself; mise.toml declares it',
    'ci.yml does not read node-version-file mise.toml in actions/setup-node',
  ]);
  const unset = node.replace('actions/setup-node@v7', 'actions/checkout@v5');
  assert.deepEqual(nodeVersionErrors(mise('26.8.1'), '>=22.16.0', { 'ci.yml': unset }, '26.8.1'), [
    'ci.yml runs Node without actions/setup-node',
  ]);
});

caseTest('a setup-node step that caches npm fails', () => {
  // The cache of setup-node runs the npm of the runner in the checkout, which devEngines refuses (EBADDEVENGINES).
  for (const cache of ['cache: npm', 'package-manager-cache: true']) {
    const cached = node.replace('package-manager-cache: false', cache);
    assert.deepEqual(nodeVersionErrors(mise('26.8.1'), '>=22.16.0', { 'ci.yml': cached }, '26.8.1'), [
      'ci.yml does not set package-manager-cache: false without cache in actions/setup-node; its npm cache runs the npm of the runner, which devEngines refuses',
    ]);
  }
});

caseTest('a Node other than that of mise.toml fails', () => {
  assert.deepEqual(nodeVersionErrors(mise('26.8.1'), '>=22.16.0', { 'ci.yml': node }, '22.16.0'), [
    'Node 22.16.0 runs the checks; mise.toml declares 26.8.1; run make install-tools TOOLS=npm, which installs it into var/tools',
  ]);
});

caseTest('a mise.toml node that is not one exact version fails', () => {
  assert.deepEqual(nodeVersionErrors(mise(''), '>=22.16.0', {}, '26.8.1'), [
    'mise.toml must declare the tool node with one exact version x.y.z, found ""',
  ]);
  assert.deepEqual(nodeVersionErrors(mise('26'), '>=22.16.0', {}, '26.8.1'), [
    'mise.toml must declare the tool node with one exact version x.y.z, found "26"',
  ]);
  assert.deepEqual(nodeVersionErrors(mise('22.12.0'), '>=22.16.0', {}, '22.12.0'), [
    'mise.toml node 22.12.0 is below package.json engines.node >=22.16.0',
  ]);
  assert.deepEqual(nodeVersionErrors(mise('26.8.1'), '22.16', {}, '26.8.1'), [
    'package.json engines.node must be ">=x.y.z", found "22.16"',
  ]);
});

// The PHP and Rust cases check the repository's declarations and the running rustc, and change the minimal workflow one at a time.
const runningRustc = /^rustc (\S+)/.exec(execFileSync('rustc', ['--version'], { cwd: repository }).toString())?.[1] ?? '';

caseTest('the checks and every workflow run the PHP of .php-version and the Rust of rust-toolchain.toml', () => {
  const composer = readComposer(join(repository.pathname, 'legacy/packages/php/composer.json'));
  assert.deepEqual(phpVersionErrors(text('.php-version'), composer.require?.php, workflows, text('Makefile')), []);
  assert.deepEqual(extensionMinorErrors(text('config/toolchain.json'), workflows, text('Makefile')), []);
  assert.deepEqual(rustToolchainErrors(text('rust-toolchain.toml'), text('Makefile'), workflows, runningRustc), []);
});

const php = [
  'jobs:',
  '  test:',
  '    steps:',
  '      - uses: shivammathur/setup-php@v2',
  '        with:',
  '          php-version-file: .php-version',
  '          extensions: pdo_sqlite',
  '          coverage: none',
  '      - run: composer install --working-dir=legacy/packages/php',
  '',
].join('\n');

caseTest('a workflow that declares php-version itself fails', () => {
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': php }, ''), []);
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': php.replace('php-version-file: .php-version', 'php-version: "8.4"') }, ''), [
    'ci.yml declares php-version itself; .php-version declares it',
    'ci.yml does not read php-version-file .php-version in shivammathur/setup-php',
    'ci.yml must set up the PHP of .php-version last, so that it is php on PATH',
  ]);
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': php.replace('shivammathur/setup-php@v2', 'actions/checkout@v5') }, ''), [
    'ci.yml runs PHP without shivammathur/setup-php',
  ]);
});

caseTest('the job platform of assets.yml builds the PHP extension for each minor of config/toolchain.json and for no other', () => {
  const toolchain = (minors: string[]) => JSON.stringify({ phpExtension: { minors } });
  const setup = (minor: string) => `      - uses: shivammathur/setup-php@v2\n        with:\n          php-version: '${minor}'\n          coverage: none\n`;
  const assets = `jobs:\n  platform:\n    steps:\n${setup('8.4')}${setup('8.5')}      - run: make ci-assets-platform\n`;
  // The recipe of the run step builds the extension for each minor with the job runner (T497).
  const recipe = (...minors: string[]) => `ci-assets-platform:\n${minors.map(minor => `\t@$(CI_JOB) check $(CI_NAME) -- ${BUILD_EXTENSION} MINOR=${minor}\n`).join('')}`;
  const path = EXTENSION_JOB.path;
  assert.deepEqual(extensionMinorErrors(toolchain(['8.4', '8.5']), { [path]: assets }, recipe('8.4', '8.5')), []);
  assert.deepEqual(extensionMinorErrors(toolchain(['8.4', '8.5', '8.6']), { [path]: assets }, recipe('8.4', '8.5')), [
    `${path} job platform sets up PHP 8.4, 8.5, not the minors 8.4, 8.5, 8.6 of config/toolchain.json phpExtension.minors`,
    `${path} job platform builds the PHP extension for PHP 8.4, 8.5, not for the minors 8.4, 8.5, 8.6 of config/toolchain.json phpExtension.minors`,
  ]);
  assert.deepEqual(extensionMinorErrors(toolchain(['8.4', '8.5']), { [path]: assets }, recipe('8.4')), [
    `${path} job platform builds the PHP extension for PHP 8.4, not for the minors 8.4, 8.5 of config/toolchain.json phpExtension.minors`,
  ]);
  assert.deepEqual(extensionMinorErrors(toolchain(['8.4', '8.5']), { [path]: assets.replace('make ci-assets-platform', 'make ci-assets') }, recipe('8.4', '8.5')), [
    `${path} job platform does not run make ci-assets-platform`,
  ]);
  assert.deepEqual(extensionMinorErrors(toolchain(['8.4', '8.5']), { [path]: assets.replace('          coverage: none\n', '') }, recipe('8.4', '8.5')), [
    `${path} sets up PHP 8.4 without coverage: none, so Xdebug or pcov can load`,
  ]);
  assert.deepEqual(extensionMinorErrors('{}', { [path]: assets }, ''), ['config/toolchain.json phpExtension.minors must list the PHP minors x.y of the extension, found undefined']);
  assert.deepEqual(extensionMinorErrors(toolchain(['8.4']), {}, ''), [`${path} has no job platform, which builds the PHP extension`]);
  // The job is checked by extensionMinorErrors alone, so its php-version is no finding of phpVersionErrors.
  assert.deepEqual(phpVersionErrors('8.4\n', '>=8.4', { [path]: assets }, ''), []);
});

caseTest('a workflow that sets up PHP with a coverage driver fails', () => {
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': php.replace('          coverage: none\n', '') }, ''), [
    'ci.yml sets up PHP without coverage: none, so Xdebug or pcov can load',
  ]);
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': php.replace('coverage: none', 'coverage: xdebug') }, ''), [
    'ci.yml sets up PHP without coverage: none, so Xdebug or pcov can load',
  ]);
});

caseTest('a .php-version below composer.json or not one release fails', () => {
  assert.deepEqual(phpVersionErrors('8.3\n', '>=8.4', {}, ''), ['.php-version 8.3 is below legacy/packages/php/composer.json require.php >=8.4']);
  assert.deepEqual(phpVersionErrors('8.5.10\n', '>=8.4', {}, ''), ['.php-version must hold one release x.y and a newline, found "8.5.10\\n"']);
  assert.deepEqual(phpVersionErrors('8.5\n', '^8.4', {}, ''), ['legacy/packages/php/composer.json require.php must be ">=x.y", found "^8.4"']);
});

const toolchain = '[toolchain]\nchannel = "1.98.1"\ncomponents = ["clippy", "rustfmt"]\nprofile = "minimal"\n';
const makefile = `PHYSICAL_RUST_TOOLCHAIN := $(shell sed -n 's/^channel = "\\(.*\\)"$$/\\1/p' rust-toolchain.toml)\nexport RUSTUP_TOOLCHAIN := $(PHYSICAL_RUST_TOOLCHAIN)\n`;
const rust = [
  'jobs:',
  '  test:',
  '    steps:',
  '      - name: Rust toolchain',
  '        run: make install-tools TOOLS=rust',
  '      - uses: Swatinem/rust-cache@v2',
  '      - run: (cd packages/rust && cargo test --locked)',
  '',
].join('\n');

caseTest('a workflow or Makefile that chooses a Rust toolchain itself fails', () => {
  assert.deepEqual(rustToolchainErrors(toolchain, makefile, { 'ci.yml': rust }, '1.98.1'), []);
  const action = rust.replace('      - name: Rust toolchain\n        run: make install-tools TOOLS=rust\n',
    '      - uses: dtolnay/rust-toolchain@stable\n        with:\n          components: clippy\n');
  assert.deepEqual(rustToolchainErrors(toolchain, makefile, { 'ci.yml': action }, '1.98.1'), [
    'ci.yml chooses a Rust toolchain with dtolnay/rust-toolchain; rust-toolchain.toml declares it',
    'ci.yml does not install the toolchain of rust-toolchain.toml with make install-tools TOOLS=rust',
  ]);
  // A bare rustup toolchain install installs the exported RUSTUP_TOOLCHAIN and reads neither the components nor the targets
  // of the file (CI run 44038491048), so it is not the install of the file's toolchain.
  assert.deepEqual(rustToolchainErrors(toolchain, makefile, { 'ci.yml': rust.replace('run: make install-tools TOOLS=rust', 'run: rustup toolchain install') }, '1.98.1'),
    ['ci.yml does not install the toolchain of rust-toolchain.toml with make install-tools TOOLS=rust', 'ci.yml installs the Rust toolchain with rustup toolchain install, which installs the exported RUSTUP_TOOLCHAIN without the components and targets of rust-toolchain.toml; run make install-tools TOOLS=rust']);
  for (const tools of ['make install-tools', "make install-tools 'TOOLS=go rust'"])
    assert.deepEqual(rustToolchainErrors(toolchain, makefile, { 'ci.yml': rust.replace('make install-tools TOOLS=rust', tools) }, '1.98.1'), [], tools);
  assert.deepEqual(rustToolchainErrors(toolchain, makefile, { 'ci.yml': rust.replace('make install-tools TOOLS=rust', 'make install-tools TOOLS=go') }, '1.98.1'), ['ci.yml does not install the toolchain of rust-toolchain.toml with make install-tools TOOLS=rust']);
  for (const run of ['rustup toolchain install 1.98.0', 'rustup default stable', 'cargo +nightly test']) {
    assert.deepEqual(rustToolchainErrors(toolchain, makefile, { 'ci.yml': rust.replace('cargo test --locked', `true; ${run}`).replace('run: make install-tools TOOLS=rust', `run: make install-tools TOOLS=rust && ${run}`) }, '1.98.1'),
      ['ci.yml chooses a Rust toolchain itself; rust-toolchain.toml declares it'], run);
  }
  assert.deepEqual(rustToolchainErrors(toolchain, 'PHYSICAL_RUST_TOOLCHAIN ?= 1.98.1\n', {}, '1.98.1'), [
    'Makefile does not read PHYSICAL_RUST_TOOLCHAIN from rust-toolchain.toml',
    'Makefile declares a Rust toolchain itself; rust-toolchain.toml declares it',
  ]);
});

caseTest('a rustc other than rust-toolchain.toml fails', () => {
  assert.deepEqual(rustToolchainErrors(toolchain, makefile, {}, '1.98.0'), ['rustc 1.98.0 runs the checks; rust-toolchain.toml declares 1.98.1']);
  assert.deepEqual(rustToolchainErrors('[toolchain]\nchannel = "stable"\ncomponents = ["clippy"]\n', makefile, {}, '1.98.1'), [
    'rust-toolchain.toml must declare one channel x.y.z under [toolchain]',
    'rust-toolchain.toml does not install rustfmt',
  ]);
});

// A crate is the directory of the nearest Cargo.toml above a file ('.' above none). A #[path] whose target lies in another
// crate couples two crates' sources, so the helpers they share belong in a crate of their own that each one depends on.
const crateOf = (file: string, crates: Set<string>) => {
  let dir = posix.dirname(file);
  while (dir !== '.' && !crates.has(dir)) dir = posix.dirname(dir);
  return dir;
};
const crossCrateErrors = (files: string[], read: (path: string) => string, crates: Set<string>) => files.flatMap(file =>
  [...read(file).matchAll(/#\[path\s*=\s*"([^"]+)"\]/g)]
    .map(([, target = '']) => ({ target, crosses: crateOf(posix.join(posix.dirname(file), target), crates) !== crateOf(file, crates) }))
    .filter(({ crosses }) => crosses)
    .map(({ target }) => `${file} names ${target} by #[path], a file of another crate`));

caseTest('a Rust file names no file of another crate by #[path]', () => {
  const crates = new Set([...trackedAll].filter(file => file.endsWith('Cargo.toml')).map(file => posix.dirname(file)));
  assert.deepEqual(crossCrateErrors(trackedFiles('*.rs'), text, crates), []);
});

caseTest('a #[path] into another crate fails the Rust crate check', () => {
  const crates = new Set(['packages/rust/a', 'packages/rust/b', 'packages/rust/programs']);
  const sources: Record<string, string> = {
    'packages/rust/a/tests/case.rs': '#[path = "../src/lib.rs"]\nmod own;\n#[path = "../../b/src/shared.rs"]\nmod shared;\n',
    'examples/complex/rust/main.rs': '#[path = "../../../packages/rust/programs/tests/common/bench_dsn.rs"]\nmod bench_dsn;\n',
  };
  assert.deepEqual(crossCrateErrors(Object.keys(sources), source => sources[source] ?? '', crates), [
    'packages/rust/a/tests/case.rs names ../../b/src/shared.rs by #[path], a file of another crate',
    'examples/complex/rust/main.rs names ../../../packages/rust/programs/tests/common/bench_dsn.rs by #[path], a file of another crate',
  ]);
});

// A PHPUnit run starts through kit's run-tests, which stops a test at its timeout (K436): no line of the Makefile starts the
// vendor PHPUnit binary itself, whether in a recipe or in a variable such as PHP_EXTENSION_TESTS.
caseTest('every PHPUnit run of the Makefile goes through run-tests', () => {
  const direct = /[=;&(@\s]vendor-php\/bin\/phpunit\s/;
  assert.deepEqual(text('Makefile').split('\n').filter(line => direct.test(line)), []);
});

// legacy/packages/python/tests/testcase.py ends no case by a clock (T474), and run-tests holds no time limit (kit 0.0.105), so
// a case fails only on its result.
caseTest('every Python run of run-tests goes through the testcase harness and gives run-tests no time limit', () => {
  const makefile = text('Makefile');
  assert.match(makefile, /^PYTHON_TESTS = (?:[A-Z_]+=\S+ )*\$\(RUN_TESTS\) python --venv \$\(PYTHON_VENV\) --module legacy\.packages\.python\.tests\.testcase$/m,
    'PYTHON_TESTS runs the testcase harness with no --timeout');
  assert.deepEqual(makefile.split('\n').filter(line => /\$\(RUN_TESTS\) python\b/.test(line) && !line.startsWith('PYTHON_TESTS = ')), [],
    'every Python run of run-tests goes through PYTHON_TESTS');
});

caseTest('the PHP extension suite and its profiled native cases use their owning inputs', () => {
  const makefile = text('Makefile');
  const filterText = /^PHP_EXTENSION_NATIVE_CASES = (.+)$/m.exec(makefile)?.[1];
  assert.ok(filterText, 'the extension suite declares its native test selection');
  const nativeCases = new RegExp(filterText);
  assert.ok(nativeCases.test('Polyspec\\Orm\\Extension\\Tests\\CodecRecipeTestExtensionTest::testNone "decode_errors"'));
  assert.ok(!nativeCases.test('Polyspec\\Orm\\Tests\\CodecRecipeTest::testNone "decode_errors"'));
  for (const test of [
    'Polyspec\\Orm\\Extension\\Tests\\MermaidErrorBoundaryTest::testCatalogBuildFailureBecomesDiagnostic',
    'Polyspec\\Orm\\Extension\\Tests\\MermaidErrorBoundaryTest::testUnexpectedNativeCatalogErrorKeepsIdentity',
    'Polyspec\\Orm\\Extension\\Tests\\ParentSlotExpansionNativeTest::testBareDollarInLiteralIsPreserved',
  ]) {
    assert.ok(!nativeCases.test(test), `${test} requires its dedicated native-test profile`);
  }
  assert.match(makefile, /test-php-ext: export CASES \?= \$\(PHP_EXTENSION_NATIVE_CASES\)/);
  assert.match(makefile, /^codec-check\/php-extension: .*build-php-ext$/m);
  assert.match(
    makefile,
    /env ORM_PHP_MODE=extension .*--configuration legacy\/packages\/php-ext\/phpunit\.xml\.dist legacy\/packages\/php-ext\/tests\/CodecRecipeTestExtensionTest\.php/,
  );
  for (const [target, source] of [
    ['mermaid-error-php-extension-check', 'legacy/packages/php-ext/tests/MermaidErrorBoundaryTest.php'],
    ['parent-slot-expansion-php-extension-check', 'legacy/packages/php-ext/tests/ParentSlotExpansionNativeTest.php'],
  ] as const) {
    const checkTargets = /^CHECK_TARGETS = (.+)$/m.exec(makefile)?.[1]?.split(/\s+/) ?? [];
    assert.ok(checkTargets.includes(target), `${target} must remain in CHECK_TARGETS`);
    const start = makefile.indexOf(`${target}:`);
    assert.notEqual(start, -1, `${target} must remain a repository check target`);
    const nextTarget = makefile.indexOf('\n\n', start);
    const recipe = makefile.slice(start, nextTarget === -1 ? undefined : nextTarget);
    assert.ok(recipe.includes('native-test'), `${target} must build the test-only module`);
    assert.ok(recipe.includes(source), `${target} must run ${source}`);
  }
  const dbspecPhpExtensionTargets = /^CI_TARGETS_dbspec_php_extension = (.+)$/m.exec(makefile)?.[1]?.split(/\s+/) ?? [];
  assert.ok(dbspecPhpExtensionTargets.includes('mermaid-error-php-extension-check'));
  assert.ok(dbspecPhpExtensionTargets.includes('parent-slot-expansion-php-extension-check'));
});

caseTest('the Rust test recipe gives Kit one libtest thread option', async () => {
  const recipe = /^dbspec-verify-errors-rust-check:[^\n]*\n((?:\t[^\n]*\n)+)/m.exec(text('Makefile'))?.[1];
  assert.ok(recipe, 'the Rust test recipe exists');
  const command = recipe.split('\n').find(line => line.includes('$(RUN_TESTS) cargo --cwd packages/rust -- '));
  assert.ok(command, 'the recipe uses Kit run-tests for cargo');
  const prefix = '$(RUN_TESTS) cargo --cwd packages/rust -- ';
  const cargoArgs = command.slice(command.indexOf(prefix) + prefix.length).trim().split(/\s+/);

  const directory = mkdtempSync(join(tmpdir(), 'dbspec-verify-cargo-runner-'));
  try {
    const stubDirectory = join(directory, 'bin');
    mkdirSync(stubDirectory);
    // The case runs in a work tree of its own (T544), a git root of no link declaration, so the cargo link of kit runs the
    // stub as given whether or not the checkout declares links: the case makes what it reads.
    const root = join(directory, 'tree');
    mkdirSync(join(root, 'packages/rust'), { recursive: true });
    const init = spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8', env: isolatedEnvironment() });
    assert.equal(init.status, 0, init.stderr);
    const argumentsFile = join(directory, 'arguments.json');
    const stub = join(stubDirectory, 'cargo');
    writeFileSync(stub, [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.CARGO_STUB_ARGUMENTS, JSON.stringify(process.argv.slice(2)));",
      "process.stderr.write('Running tests/dbspec_apply_cleanup.rs (target/debug/deps/dbspec_apply_cleanup-stub)\\n');",
      "process.stdout.write('running 1 test\\ntest apply_reports_verify_errors_separately_from_drift ... ok\\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\\n');",
      '',
    ].join('\n'));
    chmodSync(stub, 0o755);

    const output = await new Promise<{ code: number; text: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        fileURLToPath(import.meta.resolve('@polyspec/kit/run-tests')),
        'cargo',
        '--cwd',
        'packages/rust',
        '--',
        ...cargoArgs,
      ], {
        cwd: root,
        env: isolatedEnvironment({
          // The recipe names the stub as its cargo (CARGO, as the template does, T28.99), so the case holds with or without
          // a link declaration: the stub is not a cargo on PATH that a link would ask.
          CARGO: stub,
          CARGO_STUB_ARGUMENTS: argumentsFile,
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let text = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { text += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { text += chunk; });
      child.once('error', reject);
      child.once('close', code => resolve({ code: code ?? 1, text }));
    });
    assert.equal(output.code, 0, output.text);
    assert.match(output.text, /1 passed, 0 failed/);
    const parsed: unknown = JSON.parse(readFileSync(argumentsFile, 'utf8'));
    if (!isStringArray(parsed)) throw new Error('cargo test arguments fixture is not a string array');
    const actual = parsed;
    const harness = actual.slice(actual.indexOf('--') + 1);
    assert.deepEqual(harness, ['--test-threads=1', 'dbspec_apply_verification_errors_none::', '--nocapture']);
    assert.equal(actual.filter(argument => argument === '--test-threads=1').length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

// The CHECK_TARGETS case checks the repository's workflow and Makefile, and the minimal workflow.
caseTest('the CI workflow runs every target of CHECK_TARGETS once', () => {
  const targets = checkTargets(text('Makefile'));
  for (const target of ['ts-min-check', 'php-min-check', 'feature-performance-check', 'feature-verify-rust', 'feature-verify-other', 'go-test-check', 'catalog-described-temporal-go-check'])
    assert.ok(targets.includes(target), `${target} is not in CHECK_TARGETS`);
  assert.deepEqual(ciCheckTargetErrors(workflow, text('Makefile')), []);
  assert.deepEqual(checkTargets('CHECK_TARGETS = first\nCHECK_TARGETS += second third\n'), ['first', 'second', 'third']);
});

// groupWorkflow and groupRecipes are the minimal form of the CI group jobs (T497): the job plan writes the matrix include of the jobs
// test and preflight from CI_GROUPS, and each runs the recipe of its group.
const groupWorkflow = (extra = '') => ['jobs:', '  plan:', '    steps:', '      - run: make ci-plan',
  '  test:', '    needs: [plan]', '    strategy:', '      matrix:', '        include: ${{ fromJSON(needs.plan.outputs.groups) }}', '    steps:', '      - run: make ci-test GROUP=${{ matrix.group }}',
  '  preflight:', '    needs: [plan]', '    strategy:', '      matrix:', '        include: ${{ fromJSON(needs.plan.outputs.preflight) }}', '    steps:', '      - run: make ci-preflight',
  extra, ''].join('\n');
const groupRecipes = ['ci-plan:', '\t@$(NODE) scripts/check/ci-plan.mts $(CI_GROUPS)', 'ci-test:', '\t@$(CI_JOB) check $(CI_NAME) -- check-run GROUP=$(GROUP)',
  'ci-preflight:', '\t$(MAKE) ci-test GROUP=preflight', ''].join('\n');

caseTest('T497: a job whose recipe runs a target of CHECK_TARGETS outside the check runner fails', () => {
  const make = `CHECK_TARGETS = repo-check ts-min-check\nCI_GROUPS = one\nCI_TARGETS_one = repo-check ts-min-check\n${groupRecipes}`;
  assert.deepEqual(ciCheckTargetErrors(groupWorkflow(), make), []);
  const docs = groupWorkflow('  docs:\n    steps:\n      - run: make ci-docs');
  assert.deepEqual(ciCheckTargetErrors(docs, `${make}ci-docs:\n\t@$(CI_JOB) check $(CI_NAME) -- ts-min-check\n`), [
    'ci.yml job docs runs ts-min-check through make ci-docs, which make orm-check runs',
  ]);
  assert.deepEqual(ciCheckTargetErrors(groupWorkflow(), 'CHECK =\n'), ['Makefile declares no CHECK_TARGETS']);
});

// The CI group case (G5.111) checks whether the repository's Makefile and workflow split CHECK_TARGETS exactly into groups, and the minimal
// one rejects a target missing from the Makefile and workflow, a target in two groups, a target outside CHECK_TARGETS, and a matrix other than CI_GROUPS.
caseTest('the CI groups run every target of CHECK_TARGETS but the gates of kit in exactly one job', () => {
  const makefile = text('Makefile');
  const { groups, targets } = ciGroups(makefile);
  assert.ok(groups.length > 1, 'the Makefile declares more than one CI group');
  const byCodeUnit = (a: string, b: string) => (a < b ? -1 : Number(a > b));
  const own = jobTargets(makefile);
  assert.deepEqual([...groups.flatMap(group => targets[group] ?? []), ...own.docs].sort(byCodeUnit), checkTargets(makefile).filter(target => !kitGates(makefile).includes(target)).sort(byCodeUnit));
  assert.ok((targets.static ?? []).includes('dbspec-vscode-check'), 'the VS Code extension check, which needs no VS Code, runs in the static CI group; CI does not run the VS Code integration test (T704)');
  assert.deepEqual(targets.preflight, ['repo-check', 'spec-release-check', 'runner-check', 'docs-rules-check', 'comment-language-check'], 'the group preflight runs the structure checks and the release-spec check (T428, T682)');
  assert.ok((targets.static ?? []).includes('catalog-described-temporal-go-check'), 'the appended owner check runs in the static CI group');
  for (const [group, expected] of Object.entries({
    client_db_go: ['client-db-go-check', 'dialect-facts-check'],
    client_db_php: ['client-db-php-check', 'complex-query-check/php'],
    client_db_php_extension: ['client-db-php-extension-check', 'complex-query-check/php-extension'],
    client_db_typescript: ['client-db-typescript-check', 'complex-query-check/typescript'],
    client_db_python: ['client-db-python-check', 'complex-query-check/python'],
    client_db_rust: ['client-db-rust-check', 'complex-query-check/rust'],
    dbspec_go: ['dbspec-introspect-check'],
    dbspec_php: ['dbspec-introspect-php-check'],
    dbspec_php_extension: ['dbspec-introspect-php-extension-check'],
    dbspec_typescript: ['dbspec-introspect-ts-check'],
    dbspec_python: ['dbspec-introspect-python-check'],
    dbspec_rust: ['dbspec-introspect-rust-check'],
    performance: ['perf-check'],
  })) {
    for (const target of expected) assert.ok((targets[group] ?? []).includes(target), `${target} runs in ${group}`);
  }
  for (const runtime of ['go', 'php', 'php-extension', 'typescript', 'python', 'rust']) {
    const groupRuntime = runtime.replaceAll('-', '_');
    const markdown = [`markdown-session-check/${runtime}`];
    assert.deepEqual(targets[`markdown_${groupRuntime}`], markdown, `${markdown.join(' and ')} is the only target in its native runtime cell`);
  }
  assert.deepEqual(targets.feature_performance, ['feature-performance-check'], 'the performance measurement has its own CI job');
  // The suite of each runtime has its own CI job (scripts/suite-test.mts).
  for (const runtime of ['php', 'typescript', 'python']) assert.deepEqual(targets[`suite_${runtime}`], [`suite-${runtime}-check`], `suite-${runtime}-check has its own CI job`);
  assert.ok(checkTargets(makefile).includes('layout-check') && kitGates(makefile).includes('layout-check'));
  assert.ok(!groups.some(group => targets[group]?.includes('layout-check')), 'layout-check runs in the gates workflow of kit');
  assert.equal(groupOutputs(targets.static ?? [], declaredNeeds(repository.pathname)).php, true,
    'the static group bootstraps the pinned PHP before the full tool inventory is installed');
  const workflowValue: unknown = parseYaml(workflow);
  assert.ok(typeof workflowValue === 'object' && workflowValue !== null && 'jobs' in workflowValue, 'the workflow has a jobs mapping');
  const jobs = workflowValue.jobs;
  assert.ok(typeof jobs === 'object' && jobs !== null && !Array.isArray(jobs) && 'test' in jobs, 'the CI test matrix exists');
  const testJob = jobs.test;
  assert.ok(typeof testJob === 'object' && testJob !== null && !Array.isArray(testJob), 'the test job has a mapping');
  assert.deepEqual('needs' in testJob ? testJob.needs : undefined, ['plan', 'preflight'],
    'runtime and comparison jobs wait only for the plan and the preflight job (T427), start alongside kit and install their own dependencies');
  // T497: the recipe of the group job runs the setup steps; the job runner hands the outputs of the group to each make call
  // (CI_GROUP_PHP, CI_GROUP_PYTHON), so ci-install-tools reads them without a step output.
  const groupLines = makeTargets(makefile).filter(entry => entry.target === 'ci-test').flatMap(entry => entry.commands).map(line => line.trim());
  assert.ok(groupLines.includes('@$(CI_JOB) setup $(CI_NAME) go -- ci-install-tools GROUP=$(GROUP)'), 'the recipe of the group job installs the tools of its group');
  const installTools = (group: string, php: string, python: string) => {
    const result = spawnSync('make', ['-n', 'ci-install-tools', `GROUP=${group}`], {
      cwd: repository.pathname,
      encoding: 'utf8',
      env: isolatedEnvironment({ CI_GROUP_PHP: php, CI_GROUP_PYTHON: python }),
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  // A recursive make carries the variables of kit K762 (KIT=... KIT_EXT=...) before its flags, so the dry run is matched by
  // the invoked target, never by the command text before it (T245).
  assert.match(installTools('static', 'false', 'false'), /\s--no-print-directory install-tools$/m);
  assert.doesNotMatch(installTools('static', 'false', 'false'), /install-tools TOOLS=/);
  const selectedTools = /install-tools TOOLS="([^"]+)"/.exec(installTools('client_db_php', 'true', 'false'))?.[1]?.split(/\s+/) ?? [];
  assert.deepEqual(selectedTools, ['go', 'php', 'composer']);
  const pythonTools = /install-tools TOOLS="([^"]+)"/.exec(installTools('client_db_python', 'false', 'true'))?.[1]?.split(/\s+/) ?? [];
  assert.deepEqual(pythonTools, ['go', 'python', 'uv']);
  const mise = parseToml(text('mise.toml')) as { tools?: Record<string, unknown> };
  const toolchainValue: unknown = JSON.parse(text('config/toolchain.json'));
  assert.ok(typeof toolchainValue === 'object' && toolchainValue !== null, 'toolchain.json contains a mapping');
  const phpToolchain = 'php' in toolchainValue ? toolchainValue.php : undefined;
  const declaredTools = new Set([
    ...(mise.tools && Object.hasOwn(mise.tools, 'go') ? ['go'] : []),
    ...(mise.tools && Object.hasOwn(mise.tools, 'python') ? ['python'] : []),
    ...(mise.tools && Object.hasOwn(mise.tools, 'uv') ? ['uv'] : []),
    ...(Array.isArray(phpToolchain) && phpToolchain.length > 0 ? ['php'] : []),
    ...(mise.tools && Object.hasOwn(mise.tools, 'http:composer') ? ['composer'] : []),
  ]);
  for (const selected of [...selectedTools, ...pythonTools]) {
    assert.ok(declaredTools.has(selected), `CI selects ${selected} for Kit install-tools, but it is not declared by this checkout`);
  }
  assert.match(makefile, /^orm-install-python: orm-codes-python\n\t\$\(MAKE\) --no-print-directory install-tools TOOLS="python uv"$/m,
    'the Python installer does not widen a runtime-specific setup back to the full tool inventory');
  // The link of kit reads the uv project of orm, and a PHP job installs no uv, so only orm-install-python and make install link.
  for (const target of ['orm-install-php', 'orm-install-php-extension-runtime']) {
    const recipe = new RegExp(`^${target}:.*\\n((?:\\t.*\\n)*)`, 'm').exec(makefile)?.[1];
    assert.ok(recipe !== undefined, `the Makefile has no recipe of ${target}`);
    assert.doesNotMatch(recipe, /\b(?:install-)?link\b/, `${target} links, but its CI job installs no uv`);
  }
  // The npm that the lowest Node release bundles refuses the checkout, whose devEngines names the npm of mise.toml
  // (EBADDEVENGINES): ts-min-check runs the npm of mise.toml, whose bin directory comes before the lowest Node.
  const tsMin = /^ts-min-check:.*\n((?:\t.*\n)*)/m.exec(makefile)?.[1];
  assert.ok(tsMin !== undefined, 'the Makefile has no recipe of ts-min-check');
  assert.doesNotMatch(tsMin, /\$\$NODE_MIN\/npm\b/, 'ts-min-check runs the npm of the lowest Node release');
  assert.match(tsMin, /NPM_DIR="\$\$\(\$\(KIT_TOOLS\)\/bin\/mise where npm:npm\)\/node_modules" && NPM_CLI="\$\$NPM_DIR\/npm\/bin\/npm-cli\.js" && /,
    'ts-min-check runs the npm of mise.toml');
  // The npm scripts start npm by name (npm run typescript:build), so the npm of mise.toml comes before the lowest Node.
  assert.match(tsMin, /PATH="\$\$NPM_DIR\/\.bin:\$\$NODE_MIN:\$\$PATH"/, 'the npm scripts of ts-min-check find the npm of the lowest Node release');
  assert.match(tsMin, /"\$\$NODE_MIN\/node" "\$\$NPM_CLI" run typescript:test/, 'ts-min-check runs npm with the lowest Node release');
  assert.doesNotMatch(makefile, /^install-packages:\s+orm-install-interfaces-typescript$/m,
    'Kit owns npm package installation; the package target does not widen it with TypeScript 6');
  assert.match(makefile, /^install:.*orm-install-interfaces-typescript$/m,
    'the full install still prepares the TypeScript checker used by the interface extractor');
  assert.ok(groupLines.includes('@$(CI_JOB) setup $(CI_NAME) interfaces-typescript --when interfaces-typescript -- orm-install-interfaces-typescript'));
  // The PHP extension setup that every job runs writes the copy of the SQLite cancel callback that the build compiles (T290) and
  // the SQLite result code names that it includes (INT-154); the build runs the gen_stub.php of the PHP itself, so the setup
  // installs no arginfo generator (kit K930).
  assert.match(makefile, /^orm-install-php-extension-tools: \$\(PHP_EXT_SQLITE_CANCEL\) orm-codes-php-extension\n\t\$\(NODE\) scripts\/ci\/php-extension-tools\.mts\n(?!\t)/m,
    'PHP extension setup writes the copy of the SQLite cancel callback and the SQLite result code names, and installs no arginfo generator');
  assert.equal(groupLines.filter(line => line.endsWith('-- orm-install-go-lease')).length, 1, 'every group installs the shared runner dependency in its own job');
  assert.ok(groupLines.includes('@$(CI_JOB) setup $(CI_NAME) go-lease-modules -- orm-install-go-lease'));
  assert.ok(groupLines.includes('@$(CI_JOB) setup $(CI_NAME) go-modules --when go -- orm-install-go'));
  assert.ok(groupLines.includes('@$(CI_JOB) check $(CI_NAME) -- check-run GROUP=$(GROUP)'), 'the recipe of the group job runs make check-run for its group');
  assert.ok(workflow.includes('      - run: make ci-test GROUP=${{ matrix.group }}\n'), 'ci.yml runs the recipe of the group of its matrix');
  assert.deepEqual(ciCheckTargetErrors(workflow, makefile), []);
});

caseTest('database-free dbspec verification stays in the static CI group', () => {
  const makefile = text('Makefile');
  const staticGroup = /^CI_TARGETS_static = (.*)$/m.exec(makefile)?.[1]?.split(/\s+/) ?? [];
  const dbspecApplyGroup = /^CI_TARGETS_dbspec_apply = (.*)$/m.exec(makefile)?.[1]?.split(/\s+/) ?? [];
  assert.ok(staticGroup.includes('dbspec-verify-errors-check'));
  assert.ok(!dbspecApplyGroup.includes('dbspec-verify-errors-check'));
  const verifyRecipe = /^dbspec-verify-errors-check:[^\n]*\n((?:\t[^\n]*\n)+)/m.exec(makefile)?.[1] ?? '';
  assert.ok(verifyRecipe, 'the focused owner target has a recipe');
  assert.doesNotMatch(verifyRecipe, /\$\(CARGO_TEST\).*--test dbspec_apply_cleanup -- --nocapture/);
  const inputs = readCheckInputs(repository.pathname);
  assert.ok(!inputs.targets['dbspec-verify-errors-check']?.needs.includes('databases'));
});

caseTest('the CI groups leave out the gates of kit, which the gates workflow runs (KSTD-5-115)', () => {
  const grouped = groupWorkflow();
  const make = (...lines: string[]) => ['CHECK_TARGETS = a-check lint-go layout-check', ...lines, groupRecipes].join('\n');
  assert.deepEqual(ciCheckTargetErrors(grouped, make('CI_KIT_GATES = lint-go layout-check', 'CI_GROUPS = one', 'CI_TARGETS_one = a-check')), []);
  assert.deepEqual(ciCheckTargetErrors(grouped, make('CI_KIT_GATES = lint-go layout-check', 'CI_GROUPS = one', 'CI_TARGETS_one = a-check lint-go')), [
    'CI group one runs lint-go, a gate of kit (CI_KIT_GATES) that the gates workflow runs',
  ]);
  assert.deepEqual(ciCheckTargetErrors(grouped, make('CI_KIT_GATES = lint-go layout-check b-check', 'CI_GROUPS = one', 'CI_TARGETS_one = a-check')), [
    'CI_KIT_GATES names b-check, which is not a target of CHECK_TARGETS',
  ]);
  const makefile = text('Makefile');
  const gates = /^CI_KIT_GATES = (.*)$/m.exec(makefile)?.[1]?.split(/\s+/) ?? [];
  assert.ok(gates.includes('layout-check') && gates.includes('lint-ts'), 'the Makefile declares the gates of kit');
});

caseTest('python-format formats with the ruff of mise.toml the root that lint-python checks with ruff format --check .', () => {
  const recipe = /^python-format:.*\n\t(.*)$/m.exec(text('Makefile'))?.[1];
  assert.equal(recipe, '$(RUFF) format .');
});

caseTest('a CI group set that omits, repeats or adds a target of CHECK_TARGETS fails', () => {
  const make = (groups: string[]) => ['CHECK_TARGETS = a-check b-check c-check', ...groups, groupRecipes].join('\n');
  const good = make(['CI_GROUPS = one two', 'CI_TARGETS_one = a-check c-check', 'CI_TARGETS_two = b-check']);
  assert.deepEqual(ciCheckTargetErrors(groupWorkflow(), good), []);
  const multipleMissing = make(['CHECK_TARGETS += d-check e-check f-check', 'CI_GROUPS = one two', 'CI_TARGETS_one = a-check', 'CI_TARGETS_two = b-check']);
  assert.deepEqual(ciCheckTargetErrors(groupWorkflow(), multipleMissing), [
    'no CI group runs c-check of CHECK_TARGETS; add it to one CI_TARGETS_<group>',
    'no CI group runs d-check of CHECK_TARGETS; add it to one CI_TARGETS_<group>',
    'no CI group runs e-check of CHECK_TARGETS; add it to one CI_TARGETS_<group>',
    'no CI group runs f-check of CHECK_TARGETS; add it to one CI_TARGETS_<group>',
  ]);
  assert.deepEqual(ciCheckTargetErrors(groupWorkflow(), make(['CI_GROUPS = one two', 'CI_TARGETS_one = a-check b-check d-check', 'CI_TARGETS_two = b-check'])), [
    'CI groups one, two each run b-check; every target of CHECK_TARGETS runs in exactly one group',
    'no CI group runs c-check of CHECK_TARGETS; add it to one CI_TARGETS_<group>',
    'CI group one runs d-check, which is not a target of CHECK_TARGETS',
  ]);
  assert.deepEqual(ciCheckTargetErrors(groupWorkflow(), make(['CI_GROUPS = one one two', 'CI_TARGETS_one = a-check c-check', 'CI_TARGETS_two = b-check'])), [
    'Makefile CI_GROUPS lists one twice',
    'CI groups one, one each run a-check; every target of CHECK_TARGETS runs in exactly one group',
    'CI groups one, one each run c-check; every target of CHECK_TARGETS runs in exactly one group',
  ]);
  assert.deepEqual(ciCheckTargetErrors(groupWorkflow(), make(['CI_GROUPS = one two', 'CI_TARGETS_one = a-check b-check c-check', 'CI_TARGETS_three = b-check'])), [
    'Makefile CI group two declares no CI_TARGETS_two',
    'Makefile declares CI_TARGETS_three, but three is not in CI_GROUPS',
  ]);
  assert.deepEqual(ciCheckTargetErrors(groupWorkflow(), make([])), ['ci.yml runs the CI group jobs, but the Makefile declares no CI_GROUPS']);
  // T497: the jobs test and preflight take their matrix from the plan, and the plan writes it from CI_GROUPS.
  assert.deepEqual(ciCheckTargetErrors(groupWorkflow().replace('        include: ${{ fromJSON(needs.plan.outputs.groups) }}', '        group: [one, two]'), good), [
    'ci.yml job test does not take its matrix include from ${{ fromJSON(needs.plan.outputs.groups) }}, which make ci-plan writes from CI_GROUPS',
  ]);
  assert.deepEqual(ciCheckTargetErrors(groupWorkflow().replace('make ci-test GROUP=${{ matrix.group }}', 'make check-run GROUP=${{ matrix.group }}'), good), [
    'ci.yml job test does not run make ci-test GROUP=${{ matrix.group }}',
  ]);
  assert.deepEqual(ciCheckTargetErrors(groupWorkflow(), good.replace(' $(CI_GROUPS)', ' one two')), [
    'the recipe ci-plan does not write the matrix of the group jobs from CI_GROUPS with scripts/check/ci-plan.mts',
  ]);
  // A group job whose recipe also runs a CHECK_TARGETS target separately runs it twice.
  assert.deepEqual(ciCheckTargetErrors(groupWorkflow(), `${good}ci-test:\n\t@$(CI_JOB) check $(CI_NAME) -- b-check\n`), [
    'ci.yml job test runs b-check through make ci-test, which make orm-check runs',
    'ci.yml job preflight runs b-check through make ci-preflight, which make orm-check runs',
  ]);
});

// The report path case (G5.128) checks whether the report directory a CI job uploads is the directory that the runner uses, for each group of CI_GROUPS, as that job's ORM_CHECK_RUN_ID
// directory. The runner replaces `-` with `_`, so reports of a group with `-` in its name were not uploaded.
caseTest('every CI group uploads the report directory that the runner writes', () => {
  assert.deepEqual(ciReportPathErrors(workflow, text('Makefile')), []);
  const make = text('Makefile').replace(/^CI_GROUPS = (.*)$/m, 'CI_GROUPS = $1 stress-x').concat('\nCI_TARGETS_stress-x = feature-stress-mysql-check\n');
  assert.deepEqual(ciReportPathErrors(workflow, make), [
    'ci.yml job test group stress-x uploads .runtime/check/ci_1_1_stress-x/report/, but the runner writes the report of ORM_CHECK_RUN_ID 1-1-stress-x to .runtime/check/ci_1_1_stress_x/report/; name the group with lowercase letters, digits and _ only',
  ]);
});

// The group setup case (G5.127) checks, for every group in CI_GROUPS, whether the group runs the target's need and the setup step of that need's setup stage requires,
// using the repository's Makefile and contracts/check-inputs.json. databases/create starts the server as a server-programs
// program, so a group of a target that declares only databases also needs the server-programs output. The output is checked in the
// control case, where the target does not look at databases: stress-db skips the server-programs setup step.
caseTest('every CI group runs the setup steps of its needs and of the setup step databases/create', () => {
  assert.deepEqual(expandNeeds(['databases']), ['databases', 'go-lease', 'node-modules', 'server-programs']);
  assert.deepEqual(expandNeeds(['php-extension-tools']), ['php-extension-tools', 'php', 'composer', 'node-modules']);
  assert.deepEqual(expandNeeds(['interfaces-typescript']), ['interfaces-typescript', 'node-modules']);
  assert.deepEqual(expandNeeds(['rust', 'go']), ['rust', 'go']);
  assert.deepEqual(expandNeeds(['php']), ['php']);
  const { groups, targets } = ciGroups(text('Makefile'));
  assert.ok(groups.length > 0 && groups.every(group => (targets[group]?.length ?? 0) > 0), groups.join(' '));
  const needs = declaredNeeds(repository.pathname);
  const layout = Object.fromEntries(groups.map(group => [group, targets[group] ?? []]));
  assert.deepEqual(groupSetupErrors(layout, needs), []);
  const outputs = (group: string) => groupOutputs(targets[group] ?? [], needs);
  assert.equal(outputs('client_db_php')['php-extension-tools'], false, 'PHP library groups skip the native build tool install');
  assert.equal(outputs('client_db_php_extension')['php-extension-tools'], true, 'PHP-extension groups install their native build tools');
  assert.equal(outputs('static')['interfaces-typescript'], true, 'the static TypeScript extractor installs its pinned checker');
  for (const need of ['go', 'rust', 'php', 'php-extension-tools', 'python', 'databases', 'node-modules'])
    assert.equal(outputs('conformance')[need], true, `the cross-runtime comparison group installs ${need}`);
  const declaredOnly = (names: readonly string[], declared: Record<string, string[]>) => {
    const wanted = new Set(names.flatMap(name => declared[name] ?? []));
    return Object.fromEntries(Object.entries(GROUP_OUTPUTS).map(([output, from]) => [output, from.filter(need => output !== 'server-programs' || need !== 'databases').some(need => wanted.has(need))]));
  };
  assert.deepEqual(groupSetupErrors({ 'stress-db': ['stress-only'] }, { 'stress-only': ['go', 'databases'] }, declaredOnly).map(line => line.replace(/ which installs.*/, '')),
    ['CI group stress-db skips the setup step server-programs,']);
  assert.deepEqual(groupSetupErrors({ 'stress-db': ['stress-only'] }, { 'stress-only': ['go', 'databases'] }), []);
  // A group of the MariaDB servers installs the MariaDB packages, which conflict with the MySQL ones, so it starts no MySQL server.
  assert.deepEqual(groupOutputs(['m'], { m: ['go', 'mariadb-server'] }),
    { 'node-modules': false, 'interfaces-typescript': false, go: true, rust: false, php: false, 'php-extension-tools': false, 'server-programs': true, mariadb: true, databases: false, python: false, 'binding-python': false, 'wasm-bindgen': false });
  assert.deepEqual(groupSetupErrors({ both: ['m', 'd'] }, { m: ['go', 'mariadb-server'], d: ['go', 'databases'] }).filter(line => line.includes('mariadb-server')),
    ['CI group both needs both databases and mariadb-server; the runner installs the MySQL or the MariaDB packages, which conflict, so the targets of MariaDB are a group of their own']);
});

caseTest('feature helper checks provision the databases and PHP extension their owners execute', () => {
  const needs = declaredNeeds(repository.pathname)['feature-helper-check'] ?? [];
  assert.ok(needs.includes('databases'), 'the helper target reads the run-owned databases');
  assert.ok(needs.includes('php-extension-tools'), 'the helper target builds the PHP extension');
  const recipe = makeRecipes(text('Makefile')).find(unit => unit.name === 'Makefile feature-helper-check')?.commands.join('\n') ?? '';
  assert.match(recipe, /\$\(call php_ext_build,/);
  assert.match(recipe, /POLYSPEC_ORM_EXTENSION=/);
});

// The ci-passed case (G5.113-2) checks whether the repository's ci.yml places job ci-passed last and takes every other job as needs, and the minimal
// workflow rejects a missing job, a job that is not last, a condition other than always(), and another step.
caseTest('the job ci-passed runs last under always() and needs every other job', () => {
  assert.deepEqual(ciPassedErrors(workflow), []);
  const step = `    steps:\n${yamlSteps(CI_PASSED_STEPS)}`;
  const job = (condition: string, needs: string) => `  ci-passed:\n    if: ${condition}\n    needs: [${needs}]\n    runs-on: ubuntu-26.04-arm\n${step}`;
  const others = '  test:\n    steps:\n      - run: make ci-test GROUP=static\n  docs:\n    steps:\n      - run: make ci-docs\n';
  assert.deepEqual(ciPassedErrors(`jobs:\n${others}${job('${{ always() }}', 'test, docs')}`), []);
  assert.deepEqual(ciPassedErrors(`jobs:\n${others}`), ['ci.yml has no job ci-passed, the check that the ruleset requires; add it as the last job with if: ${{ always() }} and needs: every other job']);
  assert.deepEqual(ciPassedErrors(`jobs:\n${job('${{ success() }}', 'test, pages')}${others}`), [
    'ci.yml job ci-passed is not the last job; move it after docs',
    'ci.yml job ci-passed does not run with if: ${{ always() }}, so a failed or cancelled job skips it instead of failing it',
    'ci.yml job ci-passed does not need the job docs; list every other job under needs',
    'ci.yml job ci-passed needs pages, which is no other job of ci.yml',
  ]);
  assert.match(ciPassedErrors(`jobs:\n${others}${job('${{ always() }}', 'test, docs').replace('make ci-passed', 'echo passed')}`)[0] ?? '', /^ci\.yml job ci-passed has the steps .* instead of \[\{"uses":"actions\/checkout@v5"\}/);
  // A job without the checkout runs make where the repository is not, and make finds no Makefile.
  assert.match(ciPassedErrors(`jobs:\n${others}${job('${{ always() }}', 'test, docs').replace('      - uses: actions/checkout@v5\n', '')}`)[0] ?? '', /^ci\.yml job ci-passed has the steps \[\{"uses":"\.\/\.github\/actions\/kit-bootstrap"\}/);
});

// The duplicate-run case checks the repository's workflow, Makefile, feature contract and the minimal workflow.
caseTest('the CI workflow does not run a verification command of feature-check again', () => {
  const commands = featureCommands(readFeatures(repository.pathname));
  for (const command of ['make perf-check', 'node tests/run-long.mts typescript-build -- npm run typescript:build && ORM_PYTHON=legacy/packages/python/.venv/bin/python PATH=$HOME/.cargo/bin:$PATH node tests/interfaces/check/main.mts --self-test'])
    assert.ok(commands.includes(command), `${command} is not a verification command of contracts/features.json`);
  assert.deepEqual(ciDuplicateCommandErrors(workflow, text('Makefile'), commands), []);
});

caseTest('a workflow that runs a verification command of feature-check again fails', () => {
  const make = [
    'CHECK_TARGETS = feature-check',
    'interface-check:',
    '\tPATH="$(HOME)/.cargo/bin:$(PATH)" go run ./tests/interfaces/check --self-test',
    'perf-check:',
    '\t$(WITH_TEST_ENV) export ORM_BENCH_DSN="$$ORM_BENCH_MYSQL_DSN" && node scripts/perf-test.mts',
    'fuzz-check:',
    "\tgo test ./legacy/packages/go/engine/ir -run '^$$' -fuzz FuzzDecodeRequest",
    '',
  ].join('\n');
  const commands = featureCommands({ features: [{ verification: [
    { id: 'interfaces', command: 'PATH="$HOME/.cargo/bin:$PATH" go run ./tests/interfaces/check --self-test' },
    { id: 'perf', command: 'node scripts/perf-test.mts' },
    { id: 'elsewhere', command: 'php legacy/packages/php/tests/CodecRecipeTest.php', cwd: 'legacy/packages/php' },
  ] }] });
  assert.deepEqual(commands, ['PATH="$HOME/.cargo/bin:$PATH" go run ./tests/interfaces/check --self-test', 'node scripts/perf-test.mts']);
  // The job test runs make ci-test, whose recipe runs these targets with the job runner.
  const job = 'jobs:\n  test:\n    steps:\n      - run: make ci-test\n';
  const recipe = (...targets: string[]) => `ci-test:\n${targets.map(target => `\t@$(CI_JOB) check $(CI_NAME) -- ${target}\n`).join('')}`;
  assert.deepEqual(ciDuplicateCommandErrors(job, `${make}${recipe('orm-check', 'interface-check', 'fuzz-check')}`, commands), [
    'ci.yml job test runs make interface-check, whose commands make orm-check runs in feature-check',
  ]);
  assert.deepEqual(ciDuplicateCommandErrors(job, `${make}${recipe('orm-check', 'fuzz-check')}`, commands), []);
  // A target whose name holds a slash is a target of the Makefile too (makeTargets, T137-1-4-2-2).
  assert.deepEqual(ciDuplicateCommandErrors(job, `${make}perf-check/run:\n\tnode scripts/perf-test.mts\n${recipe('orm-check', 'perf-check/run')}`, commands), [
    'ci.yml job test runs make perf-check/run, whose commands make orm-check runs in feature-check',
  ]);
});

// The helper environment case checks whether the Makefile exports the shell variables read by the make commands of helper checks: the repository's contracts/features.json and
// Makefile, and a minimal manifest that reads a variable (ORM_OWNER_TEST_ENV) that set only one execution path.
caseTest('every variable a helper make command reads is exported by the Makefile', () => {
  assert.deepEqual(helperEnvironmentErrors(readFeatures(repository.pathname), text('Makefile')), []);
  const makefile = 'export ORM_TEST_ENV = $(abspath $(TEST_ENV))\nDECIMAL_ENV =\nexport DECIMAL_ENV\nexport A B\n';
  const manifest = { helpers: [
    { id: 'exported', command: 'make --no-print-directory TEST_ENV="$ORM_TEST_ENV" DECIMAL_ENV="${DECIMAL_ENV}" A="$A" B="$B" x-check' },
    { id: 'owner-only', command: 'make --no-print-directory TEST_ENV="$ORM_OWNER_TEST_ENV" x-check' },
    { id: 'script', command: 'sh scripts/x.sh "$HOME"' },
  ] };
  assert.deepEqual(helperEnvironmentErrors(manifest, makefile), [
    'contracts/features.json helper owner-only reads $ORM_OWNER_TEST_ENV, which the Makefile does not export; export it from the Makefile, as ORM_TEST_ENV and DECIMAL_ENV are, so that every make target that runs the helper passes it',
  ]);
});

// The runner case checks the repository's .github/runner and workflow, and the minimal workflow.
// A workflow in the form of kit follows kit's example, so the workflow rules of this repository do not check it (T115, T391).
const kitWorkflowPaths = kitOwned.filter(path => path.startsWith('.github/workflows/'));

caseTest('the workflow rules skip the workflows in the form of kit', () => {
  // T497: release.yml and ci-pipeline.yml run their jobs through recipes of orm, so the rules of orm read every workflow.
  assert.deepEqual(kitWorkflowPaths, []);
  const all = { '.github/workflows/ci.yml': 'a', '.github/workflows/release.yml': 'b', '.github/workflows/ci-pipeline.yml': 'c' };
  assert.deepEqual(ownWorkflows(all, kitWorkflowPaths), all);
  assert.deepEqual(ownWorkflows(all, ['.github/workflows/release.yml']), { '.github/workflows/ci.yml': 'a', '.github/workflows/ci-pipeline.yml': 'c' });
  assert.throws(() => ownWorkflows(all, null), /no Kit-owned paths/);
});

caseTest('the files in the form of kit are tracked files of orm, read from no installed package', () => {
  // kit 0.0.98 writes no copy (kit docs/spec/utilities-and-recipes.md), so the list is orm's own and names only files it tracks.
  const all = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: repository }).toString().split('\0').filter(Boolean));
  for (const file of [...Object.keys(copies), ...kitOwned]) assert.ok(all.has(file), `${file} is tracked`);
  assert.ok(!Object.hasOwn(copies, '.claude/settings.json'), 'the Claude Code settings of the kit hook are gone');
});

caseTest('every workflow job runs on the runner of .github/runner', () => {
  assert.equal(text('.github/runner'), 'ubuntu-26.04-arm\n');
  assert.deepEqual(runnerErrors(text('.github/runner'), ownWorkflows(workflows, kitOwned)), []);
});

caseTest('a job on another runner fails', () => {
  const job = 'jobs:\n  test:\n    runs-on: ubuntu-26.04-arm\n    steps:\n      - run: "true"\n';
  assert.deepEqual(runnerErrors('ubuntu-26.04-arm\n', { 'ci.yml': job }), []);
  assert.deepEqual(runnerErrors('ubuntu-26.04-arm\n', { 'ci.yml': job.replace('ubuntu-26.04-arm', 'ubuntu-24.04') }), [
    'ci.yml job test runs on ubuntu-24.04; .github/runner declares ubuntu-26.04-arm',
  ]);
  assert.deepEqual(runnerErrors('ubuntu-26.04-arm\n', { 'ci.yml': job.replace('    runs-on: ubuntu-26.04-arm\n', '') }), ['ci.yml job test declares no runs-on']);
  const call = 'jobs:\n  kit:\n    uses: ./.github/workflows/ci-pipeline.yml\n';
  assert.deepEqual(runnerErrors('ubuntu-26.04-arm\n', { 'ci.yml': call }), []);
  const platform = (runners: string[]) => `jobs:\n  platform:\n    strategy:\n      matrix:\n        include:\n${runners.map(runner => `          - runner: ${runner}\n`).join('')}    runs-on: \${{ matrix.runner }}\n    steps:\n      - run: "true"\n`;
  assert.deepEqual(runnerErrors('ubuntu-26.04-arm\n', { '.github/workflows/assets.yml': platform(['ubuntu-26.04', 'ubuntu-26.04-arm', 'macos-15']) }), []);
  assert.deepEqual(runnerErrors('ubuntu-26.04-arm\n', { '.github/workflows/assets.yml': platform(['ubuntu-26.04', 'windows-2025']) }), [
    '.github/workflows/assets.yml job platform runs on the runners ["ubuntu-26.04","windows-2025"] of its matrix; the binding assets are built on macos-15, ubuntu-26.04, ubuntu-26.04-arm',
  ]);
  assert.deepEqual(runnerErrors('ubuntu-26.04-arm\n', { '.github/workflows/ci.yml': platform(['ubuntu-26.04', 'ubuntu-26.04-arm', 'macos-15']) }), [
    '.github/workflows/ci.yml job platform runs on ${{ matrix.runner }}; .github/runner declares ubuntu-26.04-arm',
  ], 'the matrix exception is the job platform of assets.yml alone');
  assert.deepEqual(runnerErrors('', {}), ['.github/runner must hold one runner label and a newline, found ""']);
  assert.deepEqual(runnerErrors('macos-26\n', {}), [
    '.github/runner macos-26 is not a Linux runner; the linux-runner checks of contracts/features.json run only there',
  ]);
});

caseTest('T497: the lowest PHP release comes only from the output php_min of the job plan', () => {
  const setup = (version: string) => ['      - uses: shivammathur/setup-php@v2', '        with:', `          ${version}`, '          coverage: none'];
  const minimum = [
    'jobs:',
    '  plan:',
    '    steps:',
    '      - run: make ci-plan',
    '  preflight:',
    '    needs: plan',
    '    steps:',
    ...setup('php-version: ${{ needs.plan.outputs.php_min }}'),
    ...setup('php-version-file: .php-version'),
    '      - run: make ci-preflight',
    '',
  ].join('\n');
  const plan = 'ci-plan:\n\t@{ echo "php_min=$$($(NODE) scripts/php/php-min.mts --version)"; } >> "$${GITHUB_OUTPUT:-/dev/stdout}"\n';
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': minimum }, plan), []);
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': minimum.replace('    needs: plan\n', '') }, plan), [
    'ci.yml job preflight reads ${{ needs.plan.outputs.php_min }} without needing the job plan whose make ci-plan writes it with node scripts/php/php-min.mts',
  ]);
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': minimum }, 'ci-plan:\n\t@echo php_min=8.4\n'), [
    'ci.yml job preflight reads ${{ needs.plan.outputs.php_min }} without needing the job plan whose make ci-plan writes it with node scripts/php/php-min.mts',
  ]);
  const reversed = minimum.replace('php-version: ${{ needs.plan.outputs.php_min }}', 'X').replace('php-version-file: .php-version', 'php-version: ${{ needs.plan.outputs.php_min }}').replace('X', 'php-version-file: .php-version');
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': reversed }, plan), [
    'ci.yml must set up the PHP of .php-version last, so that it is php on PATH',
  ]);
});

// The socket case starts the servers of a checkout whose socket folder (T135) is long. Before any server starts, start
// must fail naming the first socket path over the platform limit (Linux 107, macOS 103 bytes) and that limit, creating
// neither the socket folder nor the servers directory. That the real declaration fits for any checkout is the case of
// scripts/test-servers.test.mts.
caseTest('test-servers.mts refuses a socket path longer than the platform limit', async () => {
  const limits: Partial<Record<NodeJS.Platform, number>> = { linux: 107, darwin: 103 };
  const limit = limits[process.platform];
  assert.ok(limit !== undefined, `the socket path limit of ${process.platform} is not known`);
  const base = mkdtempSync('/tmp/orm-sock-');
  try {
    const fits = (name: string) => (folder: string) => Buffer.byteLength(join(folder, name)) <= limit;
    // The first folder puts even the shortest socket, mysql.sock, over the limit; the second only the longest,
    // proxysql-admin-pgsql.sock.
    const deep = (name: string, keep?: (folder: string) => boolean) => {
      let folder = join(base, 'sockets');
      while (fits(name)(folder)) {
        const next = join(folder, 'd');
        folder = keep && !keep(next) ? `${folder}x` : next;
      }
      return folder;
    };
    const system = process.platform === 'linux' ? 'Linux' : 'macOS';
    for (const [folder, name] of [[deep('mysql.sock'), 'mysql.sock'], [deep('proxysql-admin-pgsql.sock', fits('mysql.sock')), 'proxysql-admin-pgsql.sock']] as const) {
      const socket = join(folder, name);
      await assert.rejects(startServers(['start'], serverPaths(base, folder)),
        (error: unknown) => error instanceof TestServerError && error.status === 1 &&
          error.message === `test-servers: socket path ${socket} is ${Buffer.byteLength(socket)} bytes; ${system} allows at most ${limit}`);
      assert.equal(existsSync(join(base, 'sockets')), false, 'the socket folder was created');
      assert.equal(existsSync(join(base, '.runtime/servers')), false, 'the servers directory was created');
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// The shared target case checks the repository's Makefile and a minimal Makefile.
caseTest('the Makefile runs no program from the shared Rust target directory and builds there under its lease', () => {
  assert.deepEqual(sharedTargetErrors(text('Makefile')), []);
  const makefile = [
    'DOCUMENT = $(CARGO_TARGET_DIR)/dbspec/stress.dbs',
    'run:',
    '\t$(RUN_LONG) rust-build/x --cwd packages/rust -- cargo build --locked --example x',
    '\tX=$(CARGO_TARGET_DIR)/debug/examples/x go test ./a',
    'copied:',
    '\t$(RUN_LONG) rust-build/y --cwd packages/rust -- $(CARGO_COPY) debug/y -- cargo build --locked --bin y',
    '\t$(RUN_LONG) rust-build/z -- $(CARGO_LEASED) cargo test --no-run --locked',
    '\t# $(CARGO_TARGET_DIR)/debug/y in a comment',
    '',
  ].join('\n');
  assert.deepEqual(sharedTargetErrors(makefile), [
    'Makefile:1 uses a path in the shared Rust target directory; run the copy in $(RUN_TARGET) and write run files into $(RUN_DIR): DOCUMENT = $(CARGO_TARGET_DIR)/dbspec/stress.dbs',
    'Makefile:4 uses a path in the shared Rust target directory; run the copy in $(RUN_TARGET) and write run files into $(RUN_DIR): X=$(CARGO_TARGET_DIR)/debug/examples/x go test ./a',
    'Makefile run builds into the shared Rust target directory without its lease; run the build under $(CARGO_LEASED) or $(CARGO_COPY): $(RUN_LONG) rust-build/x --cwd packages/rust -- cargo build --locked --example x',
  ]);
});

// The executable file case checks the repository's Makefile and a minimal Makefile.
caseTest('the files of one run live in its run directory and a TypeScript build holds its output', () => {
  assert.deepEqual(runtimePathErrors(text('Makefile')), []);
  assert.deepEqual(typescriptHolderErrors(text('Makefile')), []);
  const makefile = [
    'TEST_ENV = .runtime/servers/env',
    'TEST_ENV ?= .runtime/servers/env',
    'SEND_SQLITE_DSN = sqlite://$(dir $(abspath $(TEST_ENV)))send-savepoint.sqlite',
    'TIMING = .runtime/timing/dbspec.test',
    'LEASE = $(abspath .runtime/bin/lease)',
    'RUN_DIR = $(abspath .runtime/run)/$@-$$PPID',
    'X_LEASES = $(abspath .runtime/x.leases)',
    'held:',
    '\t$(HOLD_TYPESCRIPT)',
    '\t$(TSC_BUILD)',
    'bare:',
    '\tnpm run typescript:test',
    '',
  ].join('\n');
  assert.deepEqual(runtimePathErrors(makefile), [
    'Makefile:3 names a fixed file that runs would share; put the file of one run into $(RUN_DIR): SEND_SQLITE_DSN = sqlite://$(dir $(abspath $(TEST_ENV)))send-savepoint.sqlite',
    'Makefile:4 names a fixed file that runs would share; put the file of one run into $(RUN_DIR): TIMING = .runtime/timing/dbspec.test',
  ]);
  assert.deepEqual(typescriptHolderErrors(makefile), ['Makefile bare builds the TypeScript client without holding its build output; start the recipe with $(HOLD_TYPESCRIPT)']);
  // A target holds the build through a prerequisite that holds it, as ts-check/types does through ts-check/hold; a target
  // whose name holds a slash is checked like any other (T137-1-4-2-2).
  const parts = 'ts/hold: tool\n\t$(HOLD_TYPESCRIPT)\nts/types: ts/hold\n\tnpm run typescript:check\nts/later: ts/types\n\tnpm run typescript:test\nts/bare: tool\n\tnpm run typescript:test\n';
  assert.deepEqual(typescriptHolderErrors(parts), ['Makefile ts/bare builds the TypeScript client without holding its build output; start the recipe with $(HOLD_TYPESCRIPT)']);
  // A command inside the exclusive lease holds the build for its own length; the shared lease does not hold a build.
  assert.deepEqual(typescriptHolderErrors('ts/own: tool\n\t$(NODE) build.mts --current || $(LEASE) run $(TYPESCRIPT_LEASES) exclusive --wait -- npm run typescript:build\n'), []);
  assert.deepEqual(typescriptHolderErrors('ts/read: tool\n\t$(LEASE) run $(TYPESCRIPT_LEASES) shared --wait -- npm run typescript:build\n'), ['Makefile ts/read builds the TypeScript client without holding its build output; start the recipe with $(HOLD_TYPESCRIPT)']);
});

// The Makefile reading case checks whether, as make reads it, each target gives back its prerequisite targets and recipe (T137-1-4-2-2).
caseTest('the Makefile reader names every target with its prerequisites and recipe', () => {
  const makefile = [
    '.PHONY: a b/c',
    'A := 1',
    'a: b/c d \\',
    '  e | f',
    '\techo a \\',
    '\t  more',
    'b/c x/y: ; echo inline',
    '\techo c',
    '# comment',
    'p/%: RUN_DIR = /tmp/$@',
    'p/%:',
    '\techo $*',
    'B = 2',
    '\techo after-variable',
    'z::',
    '',
  ].join('\n');
  assert.deepEqual(makeTargets(makefile), [
    { target: '.PHONY', prerequisites: ['a', 'b/c'], commands: [] },
    { target: 'a', prerequisites: ['b/c', 'd', 'e', 'f'], commands: ['echo a \\\n  more'] },
    { target: 'b/c', prerequisites: [], commands: ['echo inline', 'echo c'] },
    { target: 'x/y', prerequisites: [], commands: ['echo inline', 'echo c'] },
    { target: 'p/%', prerequisites: [], commands: ['echo $*'] },
    { target: 'z', prerequisites: [], commands: [] },
  ]);
  assert.deepEqual(makeRecipes(makefile).map(unit => unit.name), ['Makefile a', 'Makefile b/c', 'Makefile x/y', 'Makefile p/%', 'Makefile']);
});

// The lease case checks commands outside the Makefile and a minimal unit.
caseTest('commands outside the Makefile build into the shared Rust target directory only under its lease', () => {
  const { packageUnits } = runUnits();
  const commands = [...makeRecipes(text('Makefile')), ...featureUnits(), ...packageUnits].flatMap(unit => unit.commands.map(command => ({ command, dialect: unit.dialect })));
  const scripts = reachedScripts(commands, readScript, { throughLong: true });
  assert.deepEqual(unleasedCargoErrors([...featureUnits(), ...packageUnits, ...scripts]), []);
  const unit = (name: string, command: string) => ({ name, commands: [command], dialect: 'sh' as const });
  const build = (segment: string) => `x builds into the shared Rust target directory without its lease; run the build under "$LEASE" run "$CARGO_LEASES" exclusive --wait --: ${segment}`;
  assert.deepEqual(unleasedCargoErrors([
    unit('x', 'node tests/run-long.mts b -- cargo build --locked'),
    unit('x', '"$LEASE" run "$CARGO_LEASES" exclusive --wait -- cargo test --no-run --locked'),
    unit('x', 'node tests/cargo-test.mts a -- cargo test --locked --test a'),
    unit('x', '"${CARGO_TARGET_DIR:?unset; run make}/debug/integration" a'),
  ]), [build('node tests/run-long.mts b -- cargo build --locked'),
    'x runs a program of the shared Rust target directory; run a copy made under its lease (scripts/cargo-build-copy.mts): "${CARGO_TARGET_DIR:?unset; run make}/debug/integration" a']);
});

// The link case (T531): every cargo starts through the cargo link of kit, and a rule that reads a cargo call reads one through it.
caseTest('every cargo starts through the cargo link of kit, and the rules of cargo read a call through it', () => {
  const unit = (name: string, command: string) => ({ name, commands: [command], dialect: 'sh' as const });
  const own = (segment: string) => `x starts cargo itself; start it through the cargo link, node scripts/cargo-link.mts <dir> <cargo arguments> ($(CARGO_LINK) in the Makefile): ${segment}`;
  assert.deepEqual(unlinkedCargoErrors([
    unit('x', 'cargo build --locked'),
    unit('x', 'env A=1 cargo +nightly fmt --check'),
    unit('x', 'node scripts/cargo-link.mts . build --locked'),
    unit('x', 'node tests/cargo-test.mts a -- cargo test --locked'),
    unit('x', 'PATH="$HOME/.cargo/bin:$PATH" node scripts/cargo-link.mts . test --no-run'),
    // The cargo runner of kit run-tests starts cargo through the cargo link of kit (K1266, kit 0.0.116).
    unit('x', 'node node_modules/@polyspec/kit/dist/run-tests.mjs cargo --cwd packages/rust -- --locked -p a'),
    unit('x', 'node kit/dist/runtime-targets.mjs test --runner cargo --roots packages/rust -- --workspace'),
    unit('x', 'node kit/run-tests.$(if $(wildcard kit/link.mts),mts,mjs) cargo --cwd packages/rust -- --locked'),
    unit('x', 'node run-tests.mjs.bak; cargo build'),
  ]), [own('cargo build --locked'), own('env A=1 cargo +nightly fmt --check'), own('cargo build')]);
  // T595: maturin runs cargo itself, so a wheel builds through the maturin link of kit (K1266). A maturin that starts otherwise,
  // or a PEP 517 build front end (uv build, uv pip install, pip wheel, python -m build) of a directory whose pyproject.toml names
  // the build backend maturin, whatever its arguments, builds the released tag in a linked checkout; the backend is read from the file.
  const maturin = (segment: string) => `x starts maturin itself; start it through the maturin link of kit, MATURIN=<maturin> node $(KIT)/link.$(KIT_EXT) maturin <dir> <maturin arguments>: ${segment}`;
  const frontEnd = (dir: string, segment: string) => `x builds ${dir}, whose pyproject.toml names the build backend maturin, with a PEP 517 build front end, which starts maturin without the cargo link; build it through the maturin link of kit, MATURIN=<maturin> node $(KIT)/link.$(KIT_EXT) maturin <dir> <maturin arguments>: ${segment}`;
  const projects: Record<string, string> = {
    'packages/python/pyproject.toml': '[build-system]\nrequires = ["maturin==1.16.0"]\nbuild-backend = "maturin"\n',
    'legacy/packages/python/pyproject.toml': '[build-system]\nrequires = ["setuptools==84.0.0"]\nbuild-backend = "setuptools.build_meta"\n',
  };
  const read = (path: string) => projects[path];
  assert.deepEqual(unlinkedCargoErrors([
    unit('x', 'var/tools/mise/shims/maturin build --release --locked'),
    unit('x', 'uv build packages/python'),
    unit('x', "MATURIN_PEP517_ARGS='--locked' var/tools/mise/shims/uv build --wheel --python venv/bin/python --out-dir w packages/python"),
    unit('x', 'uv pip install --python venv/bin/python ./packages/python/'),
    unit('x', 'venv/bin/pip wheel packages/python'),
    unit('x', 'python3 -m build --wheel packages/python'),
    unit('x', 'node kit/runtime-targets.mjs build --roots packages/python -- uv build'),
    unit('x', 'MATURIN=var/tools/mise/shims/maturin node kit/dist/link.mjs maturin packages/python build --release --locked'),
    unit('x', 'MATURIN=m node kit/scripts/kit/link.mts maturin packages/python build --locked'),
    unit('x', 'uv pip install --python venv/bin/python -r siblings.txt wheels/*.whl'),
    // A build of a setuptools project starts no maturin.
    unit('x', 'uv build legacy/packages/python'),
    unit('x', 'node kit/runtime-targets.mjs build --roots legacy/packages/python -- var/tools/mise/shims/uv build'),
  ], read), [maturin('var/tools/mise/shims/maturin build --release --locked'),
    frontEnd('packages/python', 'uv build packages/python'),
    frontEnd('packages/python', "MATURIN_PEP517_ARGS='--locked' var/tools/mise/shims/uv build --wheel --python venv/bin/python --out-dir w packages/python"),
    frontEnd('packages/python', 'uv pip install --python venv/bin/python ./packages/python/'),
    frontEnd('packages/python', 'venv/bin/pip wheel packages/python'),
    frontEnd('packages/python', 'python3 -m build --wheel packages/python'),
    frontEnd('packages/python', 'node kit/runtime-targets.mjs build --roots packages/python -- uv build')]);
  assert.deepEqual(unlinkedCargoSourceErrors({
    'scripts/a.mts': "spawn('cargo', ['build']);\nconst b = ['--', 'cargo', 'check'];\nif (word === 'cargo') {}\nconst c = { format: 'cargo' };\nconst d = ['tests/cargo-test.mts', 'x', '--', 'cargo', 'test'];\n// spawn('cargo')\n",
    'scripts/cargo-link.mts': "spawn('cargo', []);\n",
  }), ["scripts/a.mts:1 starts cargo by its name; start it with cargoLink of scripts/cargo-link.mts: spawn('cargo', ['build']);",
    "scripts/a.mts:2 starts cargo by its name; start it with cargoLink of scripts/cargo-link.mts: const b = ['--', 'cargo', 'check'];"]);
  // The lease rule reads a build through the link as a build.
  assert.equal(unleasedCargoErrors([unit('x', 'node tests/run-long.mts b -- node scripts/cargo-link.mts . build --locked')]).length, 1);
});

// The TypeScript reading case checks the repository's Makefile, a minimal Makefile, and a file.
caseTest('a target that runs code using the TypeScript build output holds it', () => {
  const files = new Set(trackedFiles('*'));
  assert.deepEqual(typescriptReaderErrors(text('Makefile'), (path: string) => files.has(path) ? text(path) : undefined), []);
  const sources: Record<string, string> = {
    'scripts/reads.mjs': "const run = ['node', ['legacy/packages/ts/tests/db.mjs']];\n",
    'legacy/packages/ts/tests/db.mjs': "const { Db } = await import('../dist/index.js');\n",
    'scripts/quoted.mjs': "const fixture = \"import { Db } from '../dist/index.js';\";\n",
  };
  const makefile = 'reader:\n\tnode scripts/reads.mjs\nheld: typescript-current\n\t$(READ_TYPESCRIPT)\n\tnode scripts/reads.mjs\nquoted:\n\tnode --test scripts/quoted.mjs\n';
  assert.deepEqual(typescriptReaderErrors(makefile, (path: string) => sources[path]), [
    'Makefile reader runs scripts/reads.mjs, which uses the TypeScript build output, without holding it; start the recipe with $(READ_TYPESCRIPT)',
  ]);
});

// T339-5: a target that reads the build output holds it, and reaches typescript-build through its prerequisites, so the output exists when it runs alone.
caseTest('a TypeScript reader holds the build output and has typescript-build as a prerequisite', () => {
  const sources: Record<string, string> = { 'legacy/packages/ts/tests/db.mjs': "const { Db } = await import('../dist/index.js');\n" };
  const read = (path: string) => sources[path];
  const reader = (target: string) => `Makefile ${target} reads the TypeScript build output without the prerequisite typescript-current, which builds it; add typescript-current to its prerequisites`;
  const holds = 'typescript-build:\n\t$(HOLD_TYPESCRIPT)\n\tnpm run typescript:build\ntypescript-current:\n\t$(LEASE) run $(TYPESCRIPT_LEASES) exclusive --wait -- npm run typescript:build\n';
  assert.deepEqual(typescriptReaderErrors(`${holds}direct: typescript-current\n\t$(READ_TYPESCRIPT)\n\tnode legacy/packages/ts/tests/db.mjs\nhub: php-vendor-check\n\t$(READ_TYPESCRIPT)\n\tnode legacy/packages/ts/tests/db.mjs\nphp-vendor-check: typescript-current\n\ttrue\n`, read), []);
  assert.deepEqual(typescriptReaderErrors(`${holds}queues: hub2\n\t$(READ_TYPESCRIPT)\n\tnode legacy/packages/ts/tests/db.mjs\nhub2: typescript-build\n\ttrue\n`, read), ['Makefile queues reads the TypeScript build output under the prerequisite typescript-build, which holds the exclusive lease for the whole make; use typescript-current']);
  assert.deepEqual(typescriptReaderErrors(`${holds}alone:\n\t$(READ_TYPESCRIPT)\n\tnode legacy/packages/ts/tests/db.mjs\n`, read), [reader('alone')]);
});

// Runs share the Python model directories of .runtime/run, so a publish holds their lease: six runs of bind-python-models together failed in mv.
caseTest('the shared Python model directories are published under a lease', () => {
  for (const target of ['bind-python-models', 'conformance-python-models']) {
    const commands = makeTargets(text('Makefile')).filter(rule => rule.target === target).flatMap(rule => rule.commands);
    assert.ok(commands.length === 1 && commands[0]?.includes('$(call py_models_publish,'), `${target}: ${commands.join(' ')}`);
  }
  assert.match(text('Makefile'), /^py_models_publish = \$\(LEASE\) run \$\(PY_MODELS_LEASES\) exclusive --wait -- \$\(GENERATE_ONCE\) /m);
});

// A target that only builds the output and runs node on it holds the shared lease, so runs of such targets go together.
caseTest('a target that only reads the TypeScript build output does not hold it exclusively', () => {
  assert.deepEqual(typescriptExclusiveReaderErrors(text('Makefile')), []);
  const error = (target: string) => `Makefile ${target} holds the TypeScript build output exclusively only to read it; start the recipe with $(READ_TYPESCRIPT) and add typescript-current`;
  assert.deepEqual(typescriptExclusiveReaderErrors('a/typescript: tool\n\t$(HOLD_TYPESCRIPT)\n\t$(TSC_BUILD)\n\t$(WITH_TEST_ENV) $(NODE) --test x.mjs\n'), [error('a/typescript')]);
  assert.deepEqual(typescriptExclusiveReaderErrors('b: tool\n\t$(HOLD_TYPESCRIPT)\n\t$(TSC_BUILD)\n\t$(RUN_LONG) label -- $(NODE) x.mjs\n'), [error('b')]);
  assert.deepEqual(typescriptExclusiveReaderErrors('writes: tool\n\t$(HOLD_TYPESCRIPT)\n\t$(TSC_BUILD)\n\t$(NPM) run --workspace x build\n\t$(NODE) --test x.mjs\n'), []);
  assert.deepEqual(typescriptExclusiveReaderErrors('reads: typescript-current\n\t$(READ_TYPESCRIPT)\n\t$(NODE) --test x.mjs\n'), []);
  assert.deepEqual(typescriptExclusiveReaderErrors('c: tool\n\t$(HOLD_TYPESCRIPT)\n\t$(RUN_LONG) typescript-build -- npm run typescript:build\n\tenv A=1 $(RUN_TESTS) phpunit -- x\n'), [error('c')]);
  assert.deepEqual(typescriptExclusiveReaderErrors('d: typescript-build\n\t$(NODE) --test x.mjs\n'), ['Makefile d takes the exclusive lease of the TypeScript build output through typescript-build for the life of its make; name typescript-read']);
  assert.deepEqual(typescriptExclusiveReaderErrors('build-ts: typescript-build\n'), []);
  assert.deepEqual(typescriptExclusiveReaderErrors('e: f g\nf:\n\t$(READ_TYPESCRIPT)\ng:\n\t$(HOLD_TYPESCRIPT)\n'), ['Makefile e takes the shared lease of the TypeScript build output before the exclusive one in one make; run the exclusive holder first']);
  assert.deepEqual(typescriptExclusiveReaderErrors('e: g f\nf:\n\t$(READ_TYPESCRIPT)\ng:\n\t$(HOLD_TYPESCRIPT)\n'), []);
});

// T341-1: a target that runs PHPUnit with the legacy/packages/php configuration reaches php-models, which writes the bootstrap it requires, directly or through a prerequisite.
caseTest('a PHPUnit reader of legacy/packages/php reaches php-models', () => {
  const makefile = [
    'php-models: php-vendor-check\n\ttrue',
    'php-vendor-check:\n\ttrue',
    'direct: php-vendor-check php-models\n\t$(RUN_TESTS) phpunit -- --configuration legacy/packages/php/phpunit.xml.dist legacy/packages/php/tests/A.php',
    'hub: php-models-hub\n\t$(RUN_TESTS) phpunit -- --configuration legacy/packages/php/phpunit.xml.dist legacy/packages/php/tests/A.php',
    'php-models-hub: php-models\n\ttrue',
    'order: php-vendor-check | php-models\n\t$(RUN_TESTS) phpunit -- --configuration legacy/packages/php/phpunit.xml.dist legacy/packages/php/tests/A.php',
    'named-only: php-vendor-check\n\t$(RUN_TESTS) phpunit -- --configuration legacy/packages/php/phpunit.xml.dist legacy/packages/php/tests/A.php',
    'other-config: php-vendor-check\n\t$(RUN_TESTS) phpunit -- --configuration legacy/packages/php-ext/phpunit.xml.dist legacy/packages/php-ext/tests/A.php',
    '',
  ].join('\n');
  assert.deepEqual(phpunitModelErrors(makefile), [
    'Makefile named-only runs PHPUnit with legacy/packages/php/phpunit.xml.dist, which requires legacy/packages/php/gen/bootstrap.php, without the prerequisite php-models, which writes it; add php-models to its prerequisites',
  ]);
});

// The name-only case (G5.40) does not count as reading a TypeScript test whose path is only written as a string (expected output of a fake node, stub,
// template, regular expression), but counts as reading a file that runs that path with node (a program and argument array, or the shell string of exec or spawn),
// and checks that a multi-line import also counts as reading.
caseTest('a test that only names a TypeScript test path does not read the build output', () => {
  const sources: Record<string, string> = {
    'legacy/packages/ts/tests/db.mjs': "const { Db } = await import('../dist/index.js');\n",
    'scripts/names.test.mjs': [
      "assert.deepEqual(ran, ['node legacy/packages/ts/tests/db.mjs']);",
      "assert.match(stderr, /node packages\\/ts\\/tests\\/db\\.mjs \\(exit 3\\)/);",
      "const stub = `#!/bin/sh\\necho \"node $*\" >> log # node legacy/packages/ts/tests/db.mjs`;",
      '',
    ].join('\n'),
    'scripts/array.mjs': "const run = ['node', ['legacy/packages/ts/tests/db.mjs']];\n",
    'scripts/exec-path.mjs': "spawnSync(process.execPath, ['legacy/packages/ts/tests/db.mjs', '--x']);\n",
    'scripts/shell.mjs': "execSync('node --conditions=orm-test legacy/packages/ts/tests/db.mjs');\n",
    // A multi-line import is a reading. An import example in a comment after a function body is not one.
    'legacy/packages/ts/tests/multi.mjs': "import {\n  Db,\n  OrmError as Failure,\n} from '../dist/index.js';\n",
    'scripts/multi.mjs': "const run = ['node', ['legacy/packages/ts/tests/multi.mjs']];\n",
    'scripts/comment.mjs': "export function f(a) {\n  // an import may span lines: `import {\\n  a,\\n} from '../dist/index.js'`\n}\n",
  };
  const makefile = 'names:\n\tnode --test scripts/names.test.mjs\narray:\n\tnode scripts/array.mjs\nexec-path:\n\tnode scripts/exec-path.mjs\nshell:\n\tnode scripts/shell.mjs\nmulti:\n\tnode scripts/multi.mjs\ncomment:\n\tnode scripts/comment.mjs\n';
  const reader = (target: string, file: string) => `Makefile ${target} runs ${file}, which uses the TypeScript build output, without holding it; start the recipe with $(READ_TYPESCRIPT)`;
  assert.deepEqual(typescriptReaderErrors(makefile, (path: string) => sources[path]), [
    reader('array', 'scripts/array.mjs'), reader('exec-path', 'scripts/exec-path.mjs'), reader('shell', 'scripts/shell.mjs'), reader('multi', 'scripts/multi.mjs'),
  ]);
});

// The go run case checks a minimal unit. The whole repository is checked by the repository check.
caseTest('a go run, whose build has no step log, fails', () => {
  assert.deepEqual(goRunErrors([
    { name: 'raw', commands: ['go run ./tests/interfaces/check --self-test'], dialect: 'sh' },
    { name: 'env', commands: ['PATH="$HOME/.cargo/bin:$PATH" go run ./bench/install -dsn x'], dialect: 'sh' },
    { name: 'wrapped', commands: ['node tests/go-run.mts interfaces-check ./tests/interfaces/check --self-test'], dialect: 'sh' },
  ]), [
    'raw runs go run, whose build has no step log; run it through tests/go-run.mts: go run ./tests/interfaces/check --self-test',
    'env runs go run, whose build has no step log; run it through tests/go-run.mts: PATH="$HOME/.cargo/bin:$PATH" go run ./bench/install -dsn x',
  ]);
});

caseTest('generated Go model helpers build through the logged go-run wrapper', () => {
  const helpers = (readFeatures(repository.pathname).helpers ?? []).filter(helper => ['go-decimal-model-generated', 'go-markdown-model-generated'].includes(helper.id));
  assert.deepEqual(helpers.map(helper => helper.id), ['go-decimal-model-generated', 'go-markdown-model-generated']);
  for (const helper of helpers) assert.match(helper.command, /node \.\.\/\.\.\/\.\.\/tests\/go-run\.mts/);
  assert.deepEqual(goRunErrors(helpers.map(helper => ({ name: helper.id, commands: [helper.command], dialect: 'sh' }))), []);
});

// The language case checks the repository's tracked files and a minimal list.
caseTest('every tool of the repository is written in Go, PHP, Rust or TypeScript', () => {
  assert.deepEqual(toolingLanguageErrors(trackedFiles('*')), []);
  assert.deepEqual(toolingLanguageErrors(['scripts/stop-process.py', 'tests/stop-process/main.go', 'scripts/a.sh', 'tools/x.rb', 'legacy/packages/php/src/Db.php']), [
    'scripts/stop-process.py is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them',
    'tools/x.rb is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them',
  ]);
  // the Python exemption is exactly the five places of scripts/repo/scripts.mts; nothing else is exempt
  assert.deepEqual(toolingLanguageErrors(['legacy/packages/python/src/polyspec/orm/core.py', 'legacy/packages/python/testing/interfaces/python.py', 'tests/interfaces/test_schema_utils.py',
    'legacy/packages/python/testing/conformance/runner_python.py', 'legacy/packages/python/testing/dbspec/compare/python.py']), []);
  assert.deepEqual(toolingLanguageErrors(['tests/interfaces/helper.py', 'tests/conformance/vectors.py', 'tests/dbspec/compare/other.py',
    'scripts/python_tool.py', 'packages/orm-python-old/x.py']), [
    'tests/interfaces/helper.py is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them',
    'tests/conformance/vectors.py is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them',
    'tests/dbspec/compare/other.py is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them',
    'scripts/python_tool.py is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them',
    'packages/orm-python-old/x.py is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them',
  ]);
});

// The startLogged case starts a fake server with startLogged from test-servers.mts. Starting a server is long-running work, so it has no deadline. It writes
// a ready line and keeps running: startLogged must return before the server ends, and the lines up to the ready line appear on stderr. Only 1.5 seconds
// later does it write the ready line. It also starts a slow but normal server, and a server that ends without a ready line fails with its log. The server runs
// outside the process group of the process that started it, in its own session (G5.62). Its output goes to a file of another node process.
caseTest('startLogged waits for a ready line or an exit, with no deadline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orm-logged-'));
  try {
    const module = new URL('../test-servers.mts', import.meta.url).pathname;
    const run = (server: string) => {
      const out = join(dir, 'stdout'), err = join(dir, 'stderr');
      const code = `const { startLogged, TestServerError } = await import(${JSON.stringify(module)});
try { await startLogged(${JSON.stringify(dir)}, 'fake', 'accepting connections', 'sh', ['-c', ${JSON.stringify(server)}]); console.log('returned'); }
catch (error) { if (!(error instanceof TestServerError)) throw error; console.error(error.message); process.exitCode = 1; }`;
      const status = spawnSync(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', openSync(out, 'w'), openSync(err, 'w')] }).status;
      return { status, stdout: readFileSync(out, 'utf8'), stderr: readFileSync(err, 'utf8') };
    };
    // The first line of a start names what it waits for (FCV-18).
    const waits = `test-servers: fake: waits for the line 'accepting connections' with no time limit; its log is ${dir}/fake.log\n`;
    const pid = () => Number(readFileSync(join(dir, 'fake.pid'), 'utf8').trim());
    const alive = () => {
      try { process.kill(pid(), 0); return true; }
      catch (error) {
        if (errorCode(error) !== 'ESRCH') throw error;
        return false;
      }
    };
    const ready = run('echo starting; echo now accepting connections; echo serving; exec sleep 30');
    assert.equal(ready.status, 0, ready.stderr);
    assert.equal(ready.stdout, 'returned\n');
    assert.equal(ready.stderr, `${waits}test-servers: fake: starting\ntest-servers: fake: now accepting connections\n`);
    assert.ok(alive(), 'startLogged returned only after the server ended');
    const groupOf = (id: number) => spawnSync('ps', ['-o', 'pgid=', '-p', String(id)], { encoding: 'utf8' }).stdout.trim();
    assert.notEqual(groupOf(pid()), groupOf(process.pid), 'the server runs in the process group of the command that started it');
    assert.match(readFileSync(join(dir, 'fake.log'), 'utf8'), /^starting\nnow accepting connections\n/);
    process.kill(pid());
    rmSync(join(dir, 'fake.log'));
    // The slow server creates a marker file just before the ready line. If that file exists when startLogged returns, startLogged waited for the ready line.
    const slow = run(`echo starting; sleep 1.5; echo still starting; sleep 1; touch ${dir}/ready-marker; echo now accepting connections; exec sleep 30`);
    assert.equal(slow.status, 0, slow.stderr);
    assert.equal(slow.stdout, 'returned\n');
    assert.equal(slow.stderr, `${waits}test-servers: fake: starting\ntest-servers: fake: still starting\ntest-servers: fake: now accepting connections\n`);
    assert.ok(existsSync(join(dir, 'ready-marker')), 'startLogged returned before the slow server logged its ready line');
    assert.ok(alive(), 'startLogged returned only after the slow server ended');
    process.kill(pid());
    rmSync(join(dir, 'fake.log'));
    const exited = run('echo starting; exit 3');
    assert.equal(exited.status, 1);
    assert.equal(exited.stderr, `${waits}test-servers: fake: starting\ntest-servers: fake exited before it logged 'accepting connections'; last lines of ${dir}/fake.log:\nstarting\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The timeout case checks that the repository's workflow and the minimal workflow have no timeout-minutes on their steps and jobs.
caseTest('no workflow step or job has timeout-minutes', () => {
  assert.deepEqual(stepTimeoutErrors(workflows), []);
  const plain = [
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-26.04-arm',
    '    steps:',
    '      - uses: actions/checkout@v5',
    '      - name: install',
    '        run: npm ci',
    '      - name: checks',
    '        run: make orm-check',
    '',
  ].join('\n');
  assert.deepEqual(stepTimeoutErrors({ 'ci.yml': plain }), []);
  const step = (name: string) => `ci.yml step "${name}" has timeout-minutes; a long operation gets step logs and no deadline`;
  assert.deepEqual(stepTimeoutErrors({ 'ci.yml': plain
    .replace('      - uses: actions/checkout@v5', '      - uses: actions/checkout@v5\n        timeout-minutes: 10')
    .replace('        run: npm ci', '        timeout-minutes: 20\n        run: npm ci')
    .replace('        run: make orm-check', '        timeout-minutes: 90\n        run: make orm-check') }),
  [step('uses: actions/checkout@v5'), step('install'), step('checks')]);
  assert.deepEqual(stepTimeoutErrors({ 'ci.yml': plain.replace('    runs-on:', '    timeout-minutes: 360\n    runs-on:') }), [
    'ci.yml job test has timeout-minutes, a deadline for a whole job; a long operation gets step logs and no deadline',
  ]);
});

// The lease case checks that the repository's workflow does not run, outside make, a program that reads the lease variable, and that the minimal workflow's
// step rejects running such a program (Go checker, Node script, shell script) directly. It checks that make targets
// allow a program that does not read the lease.
caseTest('a workflow step runs a program that reads the lease variables only through make', () => {
  const all = execFileSync('git', ['ls-files', '-z'], { cwd: repository }).toString().split('\0').filter(Boolean).filter(notVendored);
  const read = (path: string) => all.includes(path) ? text(path) : undefined;
  assert.deepEqual(ciLeaseErrors(workflows, all, read), []);
  const files: Record<string, string> = {
    'tests/leased/main.go': 'package main\nfunc main() { _ = os.Getenv("LEASE") }\n',
    'tests/leased/main_test.go': 'package main\n',
    'tests/plain/main.go': 'package main\nfunc main() {}\n',
    'scripts/leased.mjs': "const { LEASE: lease, CARGO_LEASES: leases } = process.env;\n",
    'scripts/leased.sh': '"${LEASE:?}" run "$CARGO_LEASES" exclusive -- true\n',
    'scripts/plain.mjs': 'console.log(1);\n',
  };
  const workflow = (run: string[]) => ['jobs:', '  test:', '    steps:', '      - name: contracts', '        run: |', ...run.map((line: string) => `          ${line}`), ''].join('\n');
  const errors = ciLeaseErrors({ 'ci.yml': workflow([
    'node tests/go-run.mts leased ./tests/leased --results out',
    'PATH="$HOME/.cargo/bin:$PATH" go run ./tests/leased',
    'node scripts/leased.mjs && sh scripts/leased.sh',
    'node tests/go-run.mts plain ./tests/plain',
    'node scripts/plain.mjs',
    'make conformance-check',
  ]) }, Object.keys(files), (path: string) => files[path]);
  const error = (program: string, file: string) => `ci.yml step "contracts" runs ${program} outside make; ${file} reads LEASE, which make exports, so the step runs it through a make target`;
  assert.deepEqual(errors, [
    error('./tests/leased', 'tests/leased/main.go'),
    error('./tests/leased', 'tests/leased/main.go'),
    error('scripts/leased.mjs', 'scripts/leased.mjs'),
    error('scripts/leased.sh', 'scripts/leased.sh'),
  ]);
});

// The target case rejects an execution command that writes packages/rust/target/ directly.
caseTest('a run command names the Rust target directory through CARGO_TARGET_DIR', () => {
  assert.deepEqual(targetPathErrors({
    Makefile: '# measured packages/rust/target 10 GiB\nexport CARGO_TARGET_DIR := $(abspath packages/rust/target)\nx:\n\t$(CARGO_TARGET_DIR)/debug/integration\n',
    'scripts/a.sh': '"${CARGO_TARGET_DIR:?}/debug/integration"\n',
  }), []);
  assert.deepEqual(targetPathErrors({
    Makefile: 'x:\n\tpackages/rust/target/debug/integration\n',
    'scripts/a.mjs': "resolve(root, 'packages/rust/target/debug/integration')\n",
    'tests/b/main.go': '\t\ttarget = filepath.Join(root, "packages", "rust", "target")\n',
  }), [
    'Makefile:2 names packages/rust/target instead of CARGO_TARGET_DIR',
    'scripts/a.mjs:1 names packages/rust/target instead of CARGO_TARGET_DIR',
    'tests/b/main.go:1 names packages/rust/target instead of CARGO_TARGET_DIR',
  ]);
  assert.deepEqual(targetPathErrors({ 'tests/x/main.go': '\t// cargo builds into packages/rust/target by default\n' }), []);
  assert.deepEqual(targetPathErrors({ 'scripts/rust/compiler-fixtures.mts': text('scripts/rust/compiler-fixtures.mts') }), []);
  assert.ok(runFile('contracts/features.json') && runFile('tests/dbspec/compare/runners.mts'));
  assert.ok(!runFile('examples/complex/rust/main.rs') && !runFile('packages/rust/README.md') && !runFile('scripts/repo/target.mts'));
});

// The manifest directory case rejects Rust source that reads the package directory with env! at compile time.
caseTest('Rust source reads the package directory when the program runs', () => {
  assert.deepEqual(manifestDirErrors({
    'packages/rust/tests/a.rs': 'let dir = polyspec_orm_testcase::manifest_dir();\n// env!("CARGO_MANIFEST_DIR") was the old form\n',
    'benchmarks/rust/tests/b.rs': 'let program = env!("CARGO_BIN_EXE_native");\ninclude!(concat!(env!("OUT_DIR"), "/m.rs"));\n',
    // include! reads the file when the crate compiles and puts no path into the program.
    'packages/ts/src/lib.rs': 'include!(concat!(env!("CARGO_MANIFEST_DIR"), "/generated/lib.rs"));\n',
  }), []);
  assert.deepEqual(manifestDirErrors({
    'packages/rust/tests/a.rs': 'use std::path::PathBuf;\nlet root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");\n',
    'packages/rust/src/codec.rs': '        let root = concat!(env!( "CARGO_MANIFEST_DIR" ), "/../../../tests/codec");\n',
  }), [
    'packages/rust/tests/a.rs:2 reads CARGO_MANIFEST_DIR at compile time; read it when the test runs',
    'packages/rust/src/codec.rs:1 reads CARGO_MANIFEST_DIR at compile time; read it when the test runs',
  ]);
});

// The connection probe case rejects a statement that the client runtime asks the server for when it connects.
caseTest('a client connects without a probe statement', () => {
  assert.deepEqual(connectProbeErrors({
    'legacy/packages/go/orm/db.go': '\tversion := sqliteVersion\n',
    'legacy/packages/ts/src/database.ts': "    try { (await pool.reserve()).release(false); } catch (error) { throw error; }\n",
    'legacy/packages/go/orm/cancel_test.go': '\tc.Raw("", "SELECT sqlite_version()", nil)\n',
    'legacy/packages/php/src/Dbspec/SqliteCatalog.php': "SELECT sqlite_version()\n",
  }), []);
  assert.deepEqual(connectProbeErrors({
    'legacy/packages/go/orm/db.go': '\tif err := s.QueryRowContext(ctx, "SELECT sqlite_version()").Scan(&version); err != nil {\n',
    'legacy/packages/php/src/Orm.php': "                    $version = (string) $pdo->query('SELECT sqlite_version()')->fetchColumn();\n",
    'legacy/packages/ts/src/database.ts': "    try { await pool.execute('SELECT 1', [], undefined, unobserved); } catch (error) { throw error; }\n",
    'packages/rust/src/db.rs': '                let version: String = sqlx::query_scalar("SELECT sqlite_version()").fetch_one(&pool).await?;\n',
  }), [
    'legacy/packages/go/orm/db.go:1 asks the server for the SQLite version; read the library version from the driver',
    'legacy/packages/php/src/Orm.php:1 asks the server for the SQLite version; read the library version from the driver',
    'legacy/packages/ts/src/database.ts:1 sends SELECT 1 to check the connection; open a connection without a statement',
    'packages/rust/src/db.rs:1 asks the server for the SQLite version; read the library version from the driver',
  ]);
});

// The program path case rejects a Rust test that reads the path of a package program with env! at compile time.
caseTest('Rust tests read the paths of package programs when they run', () => {
  assert.deepEqual(binExeErrors({
    'benchmarks/rust/tests/a.rs': 'let program = &polyspec_orm_testcase::program("native");\n// env!("CARGO_BIN_EXE_native") was the old form\n',
  }), []);
  assert.deepEqual(binExeErrors({ 'benchmarks/rust/tests/b.rs': 'let program = env!("CARGO_BIN_EXE_native");\n' }), [
    'benchmarks/rust/tests/b.rs:1 reads the program path at compile time with CARGO_BIN_EXE; read it when the test runs with polyspec_orm_testcase::program',
  ]);
});

// The test declaration case checks the repository's JavaScript files and a minimal file.
// The helper run case (G5.120) checks whether make orm-check runs each helper check once: the repository's Makefile, feature contract and
// scripts/check/databases.mts, and a minimal Makefile that runs a helper twice or never.
caseTest('make orm-check runs the check of every helper once', () => {
  assert.deepEqual(helperRunErrors(readFeatures(repository.pathname), text('Makefile'), scriptTexts.get('scripts/check/databases.mts') ?? ''), []);
  const manifest = { features: [], helpers: [
    { id: 'plain', command: 'php tests/plain_test.php' },
    { id: 'suite', command: 'make --no-print-directory TEST_ENV="$ORM_TEST_ENV" suite-check' },
    { id: 'nested', command: 'make --no-print-directory nested-check' },
    { id: 'seed', command: 'sh scripts/seed.sh' },
    { id: 'seedts', command: 'node scripts/seedts.mts' },
    { id: 'stress', command: 'make stress-bench' },
  ] };
  const make = (suite: string, stress: string) => [
    'CHECK_TARGETS = helper-check stress-check suite-check outer-check',
    `STRESS = ${stress}`,
    `SUITE = ${suite}`,
    'helper-check:',
    '	$(WITH_TEST_ENV) node scripts/features/check.mts --run --helpers $(addprefix --without-helper ,$(STRESS) $(SUITE))',
    'stress-check:',
    '	$(WITH_TEST_ENV) node scripts/features/check.mts --run $(addprefix --helper ,$(STRESS))',
    'suite-check:',
    '	go test ./suite',
    'outer-check: nested-check',
    '	go test ./outer',
    'nested-check:',
    '	go test ./nested',
    '',
  ].join('\n');
  const setup = 'BENCH_MYSQL_DSN=x "$ROOT/scripts/seed.sh"\nBENCH_MYSQL_DSN=x node "$ROOT/scripts/seedts.mts"\n';
  assert.deepEqual(helperRunErrors(manifest, make('suite nested seed seedts', 'stress'), setup), []);
  const twice = (id: string, places: string) => `make orm-check runs the check of helper ${id} 2 times: ${places}; run it once, and add a helper whose check a target or setup step of make orm-check runs to FEATURE_SUITE_HELPERS, which make feature-helper-check leaves out`;
  assert.deepEqual(helperRunErrors(manifest, make('suite', 'stress'), setup), [
    twice('nested', 'make helper-check; make nested-check, a target of make orm-check'),
    twice('seed', 'make helper-check; the setup step databases/create of make orm-check (scripts/check/databases.mts runs scripts/seed.sh)'),
    twice('seedts', 'make helper-check; the setup step databases/create of make orm-check (scripts/check/databases.mts runs scripts/seedts.mts)'),
  ]);
  // A prerequisite on a continuation line is a prerequisite too (makeTargets, T137-1-4-2-2).
  assert.deepEqual(helperRunErrors(manifest, make('suite', 'stress').replace('outer-check: nested-check', 'outer-check: suite-check \\\n  nested-check'), setup), [
    twice('nested', 'make helper-check; make nested-check, a target of make orm-check'),
    twice('seed', 'make helper-check; the setup step databases/create of make orm-check (scripts/check/databases.mts runs scripts/seed.sh)'),
    twice('seedts', 'make helper-check; the setup step databases/create of make orm-check (scripts/check/databases.mts runs scripts/seedts.mts)'),
  ]);
  assert.deepEqual(helperRunErrors(manifest, make('suite nested seed seedts plain', 'stress'), setup), [
    'make orm-check runs no check of helper plain: no target of CHECK_TARGETS selects it and its command is no target or setup step of make orm-check; leave it out of FEATURE_STRESS_HELPERS and FEATURE_SUITE_HELPERS so that make feature-helper-check runs it',
  ]);
  assert.deepEqual(helperRunErrors(manifest, make('suite nested seed seedts', 'stress').replace('--helpers $(addprefix --without-helper ,$(STRESS) $(SUITE))', '--helpers $(addprefix --without-helper ,$(SUITE))'), setup), [
    twice('stress', 'make helper-check; make stress-check'),
  ]);
});

caseTest('every JavaScript test declares its cases with caseTest', () => {
  const javascript = ['*.mjs', '*.mts', '*.js'].flatMap(pattern => trackedFiles(pattern)).filter(path => !path.startsWith('docs/'));
  assert.deepEqual(nodeTestErrors(trackedTexts(javascript)), []);
});

caseTest('a JavaScript test that declares tests with node:test directly fails', () => {
  const message = (path: string) => `${path} declares tests with node:test directly; use caseTest of tests/testcase.mts, which reports each case with its RUN, PASS or FAIL line`;
  assert.deepEqual(nodeTestErrors({
    'a.test.mjs': "import { test } from 'node:test';\n",
    'b.test.mjs': "import test from 'node:test';\n",
    'c.test.mjs': "import { after, it as check } from 'node:test';\n",
    'd.test.mjs': "import { after } from 'node:test';\nimport { caseTest } from '../testcase.mts';\n",
    'tests/testcase.mts': "import test from 'node:test';\n",
  }), [message('a.test.mjs'), message('b.test.mjs'), message('c.test.mjs')]);
});

// The calling environment case (G5.119) checks that a JavaScript test does not pass the environment of the process that ran it to a child process. The make -n orm-check run
// by the CI group's job stopped after receiving the job's GROUP.
caseTest('a JavaScript test gives its child processes only the variables of the case', () => {
  assert.deepEqual(callerEnvironmentErrors(trackedTexts(trackedFiles('*.test.mjs'))), []);
  // The environment names in the fixture below are assembled so that this file itself does not fall under that rule.
  const caller = ['process', 'env'].join('.');
  const spawn = 'spawn' + 'Sync';
  const spread = (at: string) => `${at} gives a child process the environment of its caller; give it isolatedEnvironment of tests/environment.mts with the variables of the case`;
  const make = (at: string) => `${at} runs make with the environment of its caller, whose GROUP, GITHUB_ACTIONS and MAKEFLAGS reach the recipe; pass env: isolatedEnvironment(...) of tests/environment.mts with the variables of the case`;
  assert.deepEqual(callerEnvironmentErrors({
    'a.test.mjs': `${spawn}('make', ['-n', 'orm-check'], { cwd: repo, encoding: 'utf8', env: { ...${caller}, GITHUB_ACTIONS: '' } });\n`,
    'b.test.mjs': `const dry = ${spawn}('make', ['-n', 'orm-check'], { cwd: repo });\nrun('sh', [], { env: ${caller} });\n`,
    'c.test.mjs': `${spawn}('make', ['-n', 'orm-check'], { env: isolatedEnvironment({ GROUP: 'static' }) });\nrun('sh', [], { env: isolatedEnvironment({ PATH: ${caller}.PATH }) });\n`,
    'd.mjs': `${spawn}('make', ['orm-check'], { env: { ...${caller} } });\n`,
  }), [spread('a.test.mjs:1'), make('b.test.mjs:1'), spread('b.test.mjs:2')]);
  // The env of a make spawn is read from the whole call, which may span lines (KSTD-5-116).
  assert.deepEqual(callerEnvironmentErrors({
    'e.test.mts': `const r = ${spawn}('make', ['-n', 'ci-install-tools'], {\n  cwd: repo,\n  env: isolatedEnvironment({ GROUP: 'static' }),\n});\n`,
    'f.test.mts': `const r = ${spawn}('make', ['-n', 'ci-install-tools'], {\n  cwd: repo,\n});\nrun('sh', [], { env: isolatedEnvironment() });\n`,
  }), [make('f.test.mts:1')]);
});

caseTest('every Rust test starts its case with the shared testcase package', () => {
  assert.deepEqual(rustTestCaseErrors(trackedTexts(trackedFiles('*.rs'))), []);
});

caseTest('a Rust test without a case of its own fails', () => {
  const rust = [
    '#[tokio::test]',
    'async fn started() {',
    '    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);',
    '}',
    '#[test]',
    'fn bare() {',
    '    assert!(true);',
    '}',
    '',
  ].join('\n');
  assert.deepEqual(rustTestCaseErrors({ 'packages/rust/tests/a.rs': rust }), [
    'packages/rust/tests/a.rs: bare does not start its case with polyspec_orm_testcase, so it runs without a RUN line',
  ]);
});

// The case report case checks the PHP and TypeScript tests the repository runs, and a minimal file.
caseTest('every PHP and TypeScript test that a check runs reports its cases', () => {
  const commands = [
    ...recipeLines(text('Makefile')).filter(line => line.recipe).map(line => ({ source: 'Makefile', command: line.text })),
    ...featureCommands(readFeatures(repository.pathname)).map(command => ({ source: 'contracts/features.json', command })),
    ...[...scriptTexts].map(([path, script]) => ({ source: path, command: script })),
    ...Object.values(readPackage(join(repository.pathname, 'package.json')).scripts ?? {}).map(command => ({ source: 'package.json', command })),
  ];
  const files = new Set(trackedFiles('*'));
  assert.ok(commands.some(({ command }) => /vendor-php\/bin\/phpunit .*packages\/php\/tests\/DecimalModelDbTest\.php/.test(command)));
  assert.deepEqual(reportingScriptErrors(commands, path => files.has(path) ? text(path) : undefined), []);
});

caseTest('every relative require and import of the legacy tree names a file in the repository', () => {
  const files = new Set(trackedFiles('*'));
  assert.deepEqual(movedPathErrors([...files], path => files.has(path) ? text(path) : undefined), []);
});

caseTest('a relative require or import of the legacy tree that names a path one directory too deep or outside the repository fails', () => {
  const files: Record<string, string> = {
    'legacy/packages/php/testing/dbspec/apply/php.php': "<?php\nrequire __DIR__ . '/../../../../../vendor-php/autoload.php';\nrequire __DIR__ . '/../../../../../tests/dbspec/input.php';\nrequire __DIR__ . '/../../../tests/dbspec_plan_cases.php';\nrequire_once dirname(__DIR__, 3) . '/tests/repository_root.php';\nrequire ormRepositoryRoot() . '/vendor-php/autoload.php';\n",
    'legacy/packages/ts/tests/far.mjs': "import { caseTest } from '../../../../../tests/testcase.mts';\nimport { cases } from '../../../../tests/testcase.mts';\n",
    'legacy/packages/php/tests/dbspec_plan_cases.php': '',
    'legacy/packages/php/tests/repository_root.php': '',
    'legacy/tests/dbspec/ddl.json': '',
    'tests/dbspec/input.php': '',
    'tests/testcase.mts': '',
    'scripts/outside.mjs': "import { x } from '../../../y.mjs';\n",
  };
  assert.deepEqual(movedPathErrors(Object.keys(files), path => files[path]), [
    'legacy/packages/php/testing/dbspec/apply/php.php requires legacy/vendor-php/autoload.php, a directory that legacy does not hold; find the root by the helper of its language (ormRepositoryRoot() of PHP) in place of a count of directories',
    'legacy/packages/php/testing/dbspec/apply/php.php requires legacy/tests/dbspec/input.php, which is tests/dbspec/input.php of the root; find the root by the helper of its language (ormRepositoryRoot() of PHP) in place of a count of directories',
    'legacy/packages/ts/tests/far.mjs requires ../tests/testcase.mts, outside the repository; find the root by the helper of its language (ormRepositoryRoot() of PHP) in place of a count of directories',
  ]);
});

caseTest('a PHP test outside PHPUnit or a TypeScript test without the shared case report fails', () => {
  const files: Record<string, string> = {
    'legacy/packages/php/tests/BareTest.php': "<?php\nfinal class BareTest extends PHPUnit\\Framework\\TestCase {}\n",
    'legacy/packages/ts/tests/bare.mjs': "import { Db } from '../dist/index.js';\n",
    'legacy/packages/ts/tests/cased.mjs': "import { cases } from '../../../../tests/testcase.mts';\n",
    'tests/testcase.mts': '',
  };
  const read = (path: string) => files[path];
  assert.deepEqual(testEntries('. "$DECIMAL_ENV" && node --conditions=orm-test legacy/packages/ts/tests/bare.mjs --dialect mysql'), ['legacy/packages/ts/tests/bare.mjs']);
  assert.deepEqual(reportingScriptErrors([
    { source: 'Makefile', command: 'php legacy/packages/php/tests/BareTest.php && php vendor-php/bin/phpunit --configuration legacy/packages/php/phpunit.xml.dist legacy/packages/php/tests/BareTest.php' },
    { source: 'contracts/features.json', command: 'node --test legacy/packages/ts/tests/bare.mjs legacy/packages/ts/tests/cased.mjs' },
    { source: 'scripts/x.sh', command: 'php legacy/packages/php/tests/missing.php' },
    { source: 'scripts/y.sh', command: 'php scripts/setup.php' },
  ], read), [
    'Makefile runs legacy/packages/php/tests/BareTest.php with php, not with PHPUnit (vendor-php/bin/phpunit with the phpunit.xml.dist of its package), so it runs without a deadline or a case report',
    'contracts/features.json runs legacy/packages/ts/tests/bare.mjs, which reports no case through tests/testcase.mts, so it runs without a RUN line',
    'scripts/x.sh runs legacy/packages/php/tests/missing.php, which is not a tracked file',
  ]);
});

// The tool case checks the repository's verification commands and a minimal command.
function featureUnits() {
  const manifest = readFeatures(repository.pathname);
  return [...manifest.features.flatMap(feature => feature.verification
    .filter(check => (check.cwd ?? '.') === '.').map(check => ({ name: `contracts/features.json ${feature.id}/${check.id}`, commands: [check.command], dialect: 'sh' as const }))),
  ...(manifest.helpers ?? []).map(helper => ({ name: `contracts/features.json helper ${helper.id}`, commands: [helper.command], dialect: 'sh' as const }))];
}

caseTest('every build tool of a verification command runs under run-long without a deadline', () => {
  assert.deepEqual(unwrappedToolErrors(featureUnits()), []);
});

caseTest('a build tool outside run-long or under a deadline fails', () => {
  assert.deepEqual(segments(`a && node tests/run-long.mts x -- sh -c 'go generate ./ && git diff' || (cd b; c | d)`, 'sh'),
    ['a', `node tests/run-long.mts x -- sh -c 'go generate ./ && git diff'`, 'cd b', 'c', 'd']);
  const unit = (name: string, command: string) => ({ name, commands: [command], dialect: 'sh' as const });
  const outside = (name: string, tool: string, segment: string) => `${name} runs ${tool} outside tests/run-long.mts, so it has no RUN line or step log: ${segment}`;
  const timed = (name: string, tool: string, form: string, segment: string) => `${name} runs ${tool} under a deadline (${form}); a long operation gets step logs and no deadline: ${segment}`;
  assert.deepEqual(unwrappedToolErrors([
    unit('tsc', 'node legacy/packages/ts/node_modules/typescript/bin/tsc -p legacy/packages/ts/tsconfig.json --noEmit'),
    unit('generate', 'go test ./legacy/packages/go/generator && cd legacy/packages/go/model && go generate ./'),
    unit('vet', 'go vet ./legacy/packages/go/internal/conformance'),
    unit('build', 'PATH="$HOME/.cargo/bin:$PATH" cargo build --locked -p polyspec-orm-tests --bin integration && ./integration'),
    unit('npm', 'npm run typescript:build >/dev/null'),
    unit('later', 'node tests/run-long.mts a -- go vet ./a && go vet ./b'),
    unit('wrapped', 'node tests/run-long.mts go-generate --cwd legacy/packages/go/model -- sh -c \'go generate ./ && git diff --exit-code -- .\''),
    unit('make', '$(RUN_LONG) rust-build/x --cwd packages/rust -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --locked'),
    unit('tsc-build', '$(TSC_BUILD)'),
    unit('run-case', 'node tests/run-case.mjs typescript-types 5m -- node legacy/packages/ts/node_modules/typescript/bin/tsc --noEmit'),
    unit('make-case', '$(RUN_CASE) rust-build/x $(BUILD_DEADLINE) --cwd packages/rust -- cargo build --locked'),
    unit('timeout', 'node tests/run-long.mts vet -- timeout 300 go vet ./...'),
  ]), [
    outside('tsc', 'tsc', 'node legacy/packages/ts/node_modules/typescript/bin/tsc -p legacy/packages/ts/tsconfig.json --noEmit'),
    outside('generate', 'go generate', 'go generate ./'),
    outside('vet', 'go vet', 'go vet ./legacy/packages/go/internal/conformance'),
    outside('build', 'cargo build', 'PATH="$HOME/.cargo/bin:$PATH" cargo build --locked -p polyspec-orm-tests --bin integration'),
    outside('npm', 'a TypeScript build', 'npm run typescript:build >/dev/null'),
    outside('later', 'go vet', 'go vet ./b'),
    timed('run-case', 'tsc', 'run-case.mjs', 'node tests/run-case.mjs typescript-types 5m -- node legacy/packages/ts/node_modules/typescript/bin/tsc --noEmit'),
    timed('make-case', 'cargo build', '$(RUN_CASE)', '$(RUN_CASE) rust-build/x $(BUILD_DEADLINE) --cwd packages/rust -- cargo build --locked'),
    timed('timeout', 'go vet', 'timeout 300', 'node tests/run-long.mts vet -- timeout 300 go vet ./...'),
  ]);
});

// The cargo test case checks the repository's Makefile, verification commands, scripts and a minimal unit.
function runUnits() {
  const recipes = makeRecipes(text('Makefile'));
  const packageUnits = Object.entries(readPackage(join(repository.pathname, 'package.json')).scripts ?? {}).map(([name, command]) => ({ name: `package.json ${name}`, commands: [command], dialect: 'sh' as const }));
  const commands = [...recipes, ...featureUnits(), ...packageUnits].flatMap(unit => unit.commands.map(command => ({ command, dialect: unit.dialect })));
  return { recipes, packageUnits, scripts: reachedScripts(commands, readScript) };
}

caseTest('every cargo test run goes through cargo-test.mts', () => {
  const { recipes, packageUnits, scripts } = runUnits();
  assert.ok(scripts.some(unit => unit.name === 'scripts/client-db-test.mts'));
  assert.ok(!scripts.some(unit => unit.name === 'scripts/package-check.mts'), 'package-check.sh runs under run-long');
  assert.deepEqual(unbuiltCargoTestErrors([...recipes, ...featureUnits(), ...packageUnits, ...scripts]), []);
});

caseTest('a cargo test run outside cargo-test.mts, or a build under a deadline, fails', () => {
  assert.deepEqual(makeRecipes('A = 1\nx: y\n\tcd a && cargo test\n\n# c\nz:\n\techo\n').map(unit => unit.name), ['Makefile x', 'Makefile z']);
  const message = (name: string, args: string) => `${name} runs cargo test ${args} outside tests/cargo-test.mts, so it runs the test binaries of the shared Rust target directory`;
  const timed = (name: string, args: string, form: string, segment: string) => `${name} runs the build cargo test --no-run ${args} under a deadline (${form}); a long operation gets step logs and no deadline: ${segment}`;
  assert.deepEqual(unbuiltCargoTestErrors([
    { name: 'bare', commands: ['$(WITH_TEST_ENV) cd packages/rust && cargo +$(T) test --locked --test a -- --nocapture'], dialect: 'make' },
    { name: 'built', commands: ['$(RUN_LONG) b --cwd packages/rust -- $(CARGO_LEASED) cargo +$(T) test --no-run --locked --test a', 'cd packages/rust && cargo +$(T) test --locked --test a'], dialect: 'make' },
    { name: 'copied', commands: ['cd packages/rust && $(CARGO_TEST) c -- cargo +$(T) test --locked --test a -- --nocapture', 'node tests/cargo-test.mts d -- cargo test --locked --lib'], dialect: 'make' },
    { name: 'timed', commands: ['node tests/run-case.mjs b 8m -- cargo test --no-run --locked --test a'], dialect: 'sh' },
  ]), [message('bare', '--locked --test a'), message('built', '--locked --test a'),
    timed('timed', '--locked --test a', 'run-case.mjs', 'node tests/run-case.mjs b 8m -- cargo test --no-run --locked --test a')]);
});

caseTest('every build tool of the Makefile, package.json and the scripts runs under run-long', () => {
  const { recipes, packageUnits, scripts } = runUnits();
  assert.ok(scripts.some(unit => unit.name === 'scripts/typescript/sqlite-test.mts'));
  assert.deepEqual(unwrappedToolErrors([...recipes, ...packageUnits.filter(unit => segments(unit.commands[0] ?? '', 'sh').length > 1), ...scripts]), []);
});

caseTest('a go command is go or a path to go, and a make target name that holds go is none', () => {
  const goBuild = tools.find(([name]) => name === 'go build')?.[1];
  assert.ok(goBuild);
  for (const command of ['go build ./...', 'cd legacy/packages/go && go build ./...', '/repo/var/tools/mise/shims/go build ./...'])
    assert.equal(goBuild.test(command), true, command);
  for (const command of ['$(MAKE) --no-print-directory build-go build-php', 'make build-go build-ts', 'cargo build --locked'])
    assert.equal(goBuild.test(command), false, command);
  assert.deepEqual(unwrappedToolErrors([{ name: 'Makefile build', commands: ['$(MAKE) --no-print-directory build-go build-php'], dialect: 'make' }]), []);
  assert.equal(unwrappedToolErrors([{ name: 'Makefile build-go', commands: ['$(NODE) runtime-targets.mjs build --roots legacy/packages/go -- /repo/var/tools/mise/shims/go build ./...'], dialect: 'make' }]).length, 1);
});

// The rerun case checks the repository's workflow and the minimal workflow by the runner's identity.
caseTest('the CI workflow runs no test runner outside make orm-check', () => {
  assert.deepEqual(ciRerunErrors(workflow, text('Makefile')), []);
});

caseTest('a workflow that runs a test runner after make orm-check fails by identity', () => {
  assert.equal(runnerIdentity('PATH="$HOME/.cargo/bin:$PATH" cargo +1.98.1 test --locked -p polyspec-orm codec'), 'cargo test');
  assert.equal(runnerIdentity("go test -v -timeout 0 ./legacy/packages/go/engine/ir -run '^$' -fuzz FuzzDecodeRequest -fuzztime=1s"), undefined);
  assert.equal(runnerIdentity('go run ./tests/interfaces/check --results tests/conformance/out'), undefined);
  assert.equal(runnerIdentity('node tests/go-test.mts -v -timeout 0 ./legacy/packages/go/engine -count=1'), 'go test');
  assert.equal(runnerIdentity('node --test tests/conformance/check/main.test.mts'), 'node test');
  assert.equal(runnerIdentity('php -d extension=x.so vendor-php/bin/phpunit --configuration legacy/packages/php/phpunit.xml.dist legacy/packages/php/tests/DbspecTest.php'), 'phpunit vendor-php/bin/phpunit');
  assert.equal(runnerIdentity("node tests/run-long.mts fuzz/ir -- go test -v ./legacy/packages/go/engine/ir -run '^$' -fuzz FuzzDecodeRequest"), undefined);
  assert.equal(runnerIdentity('node tests/run-long.mts rust-build/x -- cargo test --no-run --locked'), 'cargo test');
  const make = [
    'CHECK_TARGETS = repo-check',
    'GO_TEST = go test -v -timeout 0',
    'fuzz-check:',
    "\t$(GO_TEST) ./legacy/packages/go/engine/ir -run '^$$' -fuzz FuzzDecodeRequest -fuzztime=1s",
    'vet-again:',
    '\t$(GO_TEST) ./legacy/packages/go/orm -run TestCodec',
    '',
  ].join('\n');
  // T497: the job test runs make ci-test, whose recipe runs the targets after `--` of its lines.
  const job = 'jobs:\n  test:\n    steps:\n      - run: make ci-test GROUP=${{ matrix.group }}\n';
  const recipe = (...targets: string[]) => `ci-test:\n${targets.map(target => `\t@$(CI_JOB) check $(CI_NAME) -- ${target}\n`).join('')}`;
  const message = (identity: string, via = '') => `ci.yml job test runs ${identity}${via} outside make orm-check; make orm-check runs every test once, and a check it lacks belongs in a target of CHECK_TARGETS`;
  assert.deepEqual(ciRerunErrors(job, `${make}${recipe('check-run GROUP=$(GROUP)', 'fuzz-check', 'vet-again')}`), [message('go test', ' through make vet-again')]);
  assert.deepEqual(ciRerunErrors(job, `${make}${recipe('check-run GROUP=$(GROUP)', 'repo-check')}`), []);
  // A setup step installs and runs no test.
  assert.deepEqual(ciRerunErrors(job, `${make}ci-test:\n\t@$(CI_JOB) setup $(CI_NAME) go -- vet-again\n`), []);
  // A workflow without the group jobs runs no part of make orm-check.
  assert.deepEqual(ciRerunErrors(job.replace('make ci-test GROUP=${{ matrix.group }}', 'make ci-docs'), `${make}ci-docs:\n\t@$(CI_JOB) check $(CI_NAME) -- vet-again\n`), []);
});

// The generation case checks the recipe and verification commands of make orm-check, and a minimal unit.
caseTest('make orm-check runs each go generate once', () => {
  const targets = new Set(checkTargets(text('Makefile')));
  const { recipes } = runUnits();
  assert.deepEqual(repeatedGenerateErrors([...recipes.filter(unit => targets.has(unit.name.replace(/^Makefile /, ''))), ...featureUnits()]), []);
});

caseTest('a go generate that make orm-check runs twice fails', () => {
  assert.deepEqual(generateRuns(`$(RUN_LONG) go-model -- sh -c 'cd legacy/packages/go/model && go generate ./ && git diff --exit-code -- .'`, 'make'), ['legacy/packages/go/model']);
  assert.deepEqual(generateRuns(`go test ./legacy/packages/go/generator && node tests/run-long.mts g --cwd legacy/packages/go/model -- sh -c 'go generate ./ && git diff'`, 'sh'), ['legacy/packages/go/model']);
  assert.deepEqual(generateRuns('cd legacy/packages/go/other && go generate ./', 'sh'), ['legacy/packages/go/other']);
  assert.deepEqual(repeatedGenerateErrors([
    { name: 'Makefile go-model-check', commands: [`$(RUN_LONG) go-model -- sh -c 'cd legacy/packages/go/model && go generate ./ && git diff --exit-code -- .'`], dialect: 'make' },
    { name: 'contracts/features.json model_generation/generation-go', commands: [`node tests/run-long.mts g --cwd legacy/packages/go/model -- sh -c 'go generate ./ && git diff'`], dialect: 'sh' },
    { name: 'other', commands: ['cd legacy/packages/go/other && go generate ./'], dialect: 'sh' },
  ]), ['go generate of legacy/packages/go/model runs 2 times in make orm-check: Makefile go-model-check, contracts/features.json model_generation/generation-go']);
});

// The go test case checks the repository's Makefile (with variables resolved), verification commands, scripts and a minimal unit.
caseTest('every go test runs through go-test.mts or run-long', () => {
  const makefile = text('Makefile');
  const variables = makeVariables(makefile);
  const { recipes, scripts } = runUnits();
  const expanded = recipes.map(unit => ({ ...unit, commands: unit.commands.map(command => expand(command, variables)) }));
  assert.deepEqual(rawGoTestErrors([...expanded, ...featureUnits(), ...scripts]), []);
});

caseTest('a go test without its build step, or under a deadline, fails', () => {
  const message = (name: string, segment: string) => `${name} runs go test outside tests/go-test.mts, so its compile has no RUN line or step log: ${segment}`;
  const fuzz = "$(RUN_CASE) fuzz/ir 8m -- go test -v -timeout 0 ./legacy/packages/go/engine/ir -run '^$$' -fuzz FuzzDecodeRequest -fuzztime=1s";
  assert.deepEqual(rawGoTestErrors([
    { name: 'raw', commands: ['go test -v -timeout 0 ./legacy/packages/go/orm -run X -count=1'], dialect: 'sh' },
    { name: 'env', commands: ['ORM_RUN_PERF_GATE=1 go test -v ./legacy/packages/go/bench'], dialect: 'sh' },
    { name: 'wrapped', commands: ['node tests/go-test.mts -v -timeout 0 ./legacy/packages/go/engine -count=1'], dialect: 'sh' },
    { name: 'fuzz', commands: ["$(RUN_LONG) fuzz/ir -- go test -v -timeout 0 ./legacy/packages/go/engine/ir -run '^$$' -fuzz FuzzDecodeRequest -fuzztime=1s"], dialect: 'make' },
    { name: 'build', commands: ['node tests/run-long.mts go-build -- go test -c -o x ./legacy/packages/go/engine/dbspec'], dialect: 'sh' },
    { name: 'timed', commands: [fuzz], dialect: 'sh' },
  ]), [message('raw', 'go test -v -timeout 0 ./legacy/packages/go/orm -run X -count=1'), message('env', 'ORM_RUN_PERF_GATE=1 go test -v ./legacy/packages/go/bench'),
    `timed runs go test under a deadline ($(RUN_CASE)); a long operation gets step logs and no deadline: ${fuzz}`]);
});

// The deadline case checks the repository's Makefile (with variables resolved), verification commands, package.json scripts, and every script,
// including those under run-long, and a minimal unit.
caseTest('no check puts a deadline on a long operation', () => {
  const makefile = text('Makefile');
  const variables = makeVariables(makefile);
  const { recipes, packageUnits } = runUnits();
  const commands = [...recipes, ...featureUnits(), ...packageUnits].flatMap(unit => unit.commands.map(command => ({ command, dialect: unit.dialect })));
  const scripts = reachedScripts(commands, readScript, { throughLong: true });
  assert.ok(scripts.some(unit => unit.name === 'scripts/package-check.mts'), 'the scripts under run-long are checked');
  const expanded = recipes.map(unit => ({ ...unit, commands: unit.commands.map(command => expand(command, variables)) }));
  assert.deepEqual(longDeadlineErrors([...expanded, ...featureUnits(), ...packageUnits, ...scripts]), []);
});

caseTest('a deadline on a long operation fails', () => {
  const message = (name: string, form: string, segment: string) => `${name} puts a deadline (${form}) on a long operation; it gets step logs and no deadline, and only a test case has its own: ${segment}`;
  const units = {
    'run-case': 'node tests/run-case.mjs package 8m -- node scripts/package-check.mts',
    make: '$(RUN_CASE) go-fmt $(TOOL_DEADLINE) -- gofmt -l .',
    variable: 'node tests/run-long.mts x -- sh -c "sleep $(BUILD_DEADLINE)"',
    timeout: 'timeout 600 cargo build --locked',
    'go-default': 'go test ./...',
    'go-timeout': 'node tests/go-test.mts -v -timeout 10m ./legacy/packages/go/engine',
    'go-none': 'go test -timeout 0 ./...',
    'go-build': 'go test -c -o x ./legacy/packages/go/engine/dbspec',
    'go-runner': 'node tests/go-test.mts -v -timeout 0 ./legacy/packages/go/engine -count=1',
    long: 'node tests/run-long.mts rust-build/x -- cargo test --no-run --locked',
  };
  assert.deepEqual(longDeadlineErrors(Object.entries(units).map(([name, command]) => ({ name, commands: [command], dialect: 'make' as const }))), [
    message('run-case', 'run-case.mjs', units['run-case']),
    message('make', '$(RUN_CASE)', units.make),
    message('variable', '$(BUILD_DEADLINE)', units.variable),
    message('timeout', 'timeout 600', units.timeout),
    message('go-default', 'go test without -timeout 0 (the default 10m)', units['go-default']),
    message('go-timeout', 'go test -timeout 10m', units['go-timeout']),
  ]);
});

// The full suite rule case (G5.38-5) checks that AGENTS.md and AGENTS.ko.md state the rule that the full suite runs in CI after push, and do not state the earlier
// local rule.
caseTest('AGENTS states that the full suite runs on CI after a push', () => {
  const read = (path: string) => readFileSync(new URL(path, repository), 'utf8');
  assert.deepEqual(fullSuiteRuleErrors({ 'AGENTS.md': read('AGENTS.md'), 'AGENTS.ko.md': read('AGENTS.ko.md') }), []);
  assert.deepEqual(fullSuiteRuleErrors({ 'AGENTS.md': 'The full suite (`make orm-check`) runs exactly once, when every active checklist\n  item is complete.', 'AGENTS.ko.md': '' }).slice(0, 2), [
    'AGENTS.md does not state the full-suite rule: "runs on GitHub CI after a push"',
    'AGENTS.md does not state the full-suite rule: "collect enough information to fix every failure it found before the next CI run"',
  ]);
  assert.ok(fullSuiteRuleErrors({ 'AGENTS.md': 'runs exactly once, when every active checklist\n  item is complete', 'AGENTS.ko.md': '' })
    .includes('AGENTS.md still states the local full-suite rule: "runs exactly once, when every active checklist   item is complete"'));
});

// make install-tools checks the checkout PHP version before installing its tools; the npm-only install does not need PHP. The
// job reaches make install-tools through the recipe of its run step.
caseTest('T497: a job whose recipe installs the PHP tools sets up the PHP of .php-version before its run step', () => {
  const workflow = (steps: string) => `jobs:\n  test:\n    steps:\n${steps}      - run: make ci-test\n`;
  const php = `      - uses: shivammathur/setup-php@v2\n        with:\n          php-version-file: .php-version\n`;
  const recipe = (tools: string) => `ci-test:\n\t@$(CI_JOB) setup $(CI_NAME) tools -- ci-install-tools\nci-install-tools:\n\t$(MAKE) install-tools${tools}\n`;
  const none = { setup: {}, output: {} };
  const late = ['ci.yml job test runs make install-tools through make ci-test before setup-php installs .php-version'];
  const errors = (steps: string, tools: string) => ciSetupErrors({ 'ci.yml': workflow(steps) }, recipe(tools), none).filter(error => error.startsWith('ci.yml'));
  assert.deepEqual(errors(php, ''), []);
  assert.deepEqual(errors('', ''), late);
  assert.deepEqual(errors('', ' TOOLS=go'), []);
  assert.deepEqual(errors('', ' TOOLS="go php"'), late);
  assert.deepEqual(errors('', ' TOOLS=npm'), []);
});

// A phpunit line names its test: with its configuration alone it runs the whole suite (T646, run 44309325651: client_db_php
// ran the full PHP suite in request-hook-check/php, parameter-chunking-check/php and aes-rotation-check/php, 18 minutes each).
// A wait waits on an event: a shell loop with a body that does nothing spins (T645, scripts/check/step.test.mts).
caseTest('T645: a shell loop that does nothing while it waits is refused: do :; done, do true; done and do ; done', () => {
  const nothing = ['do', ':;', 'done'].join(' ');
  const files = {
    'a.mts': `const W = 'until ps -o args= -p $! | grep -q "^sleep "; ${nothing}';`,
    'b.sh': `while test ! -f ready; ${nothing.replace(':', 'true')}`,
    'c.sh': 'until test -f ready; do read -r line <fifo; done',
    'd.sh': 'for f in a b; do :; done',
    'e.sh': `until test -f ready; ${nothing.replace(' :;', ' ;')}`,
  };
  assert.deepEqual(busyLoopErrors(files).map(error => error.split(' ')[0]), ['a.mts:1', 'b.sh:1', 'e.sh:1']);
});

caseTest('T646: a recipe that runs phpunit with its configuration alone is refused', () => {
  const makefile = [
    'RUN_TESTS = node run-tests.mjs',
    'bare:', '\tenv ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration legacy/packages/php/phpunit.xml.dist',
    'ext:', '\t$(RUN_TESTS) phpunit --php-extension "x.so" -- --configuration legacy/packages/php-ext/phpunit.xml.dist || status=1',
    'file:', '\t$(RUN_TESTS) phpunit -- --configuration legacy/packages/php/phpunit.xml.dist legacy/packages/php/tests/ATest.php',
    'filtered:', "\tvendor/bin/phpunit -c phpunit.xml.dist --filter 'testA'",
  ].join('\n') + '\n';
  assert.deepEqual(unselectedPhpunitErrors(makefile).map(error => error.split(' runs ')[0]), ['Makefile bare', 'Makefile ext']);
  assert.deepEqual(unselectedPhpunitErrors(text('Makefile')), []);
});

// The independent test case (G5.53) treats as an error a recipe with two or more separate test or lint runs, or a verification command that chains tests with `&&`.
// A second run of the same test, a line that only compiles, a line that creates input, and a build of a dependency tool are not tests.
caseTest('a recipe or a command that runs independent tests in sequence is refused', () => {
  const makefile = [
    'GO_TEST = node tests/go-test.mts -v -timeout 0',
    'two:', "\t$(GO_TEST) ./a -count=1", '\tphp legacy/packages/php/tests/b_test.php',
    'again:', '\tphp legacy/packages/php/tests/b_test.php', '\tphp legacy/packages/php/tests/b_test.php',
    'built:', '\tnode tests/dbspec/stress.mts > out.dbs', '\tgo test -c -o x ./legacy/packages/go/engine', '\tnode legacy/packages/ts/node_modules/typescript/bin/tsc -p x', '\tnode --test tests/x.test.mjs',
    'linted:', '\tcargo +$(shell sed -n \'s/x/\\1/p\' f) clippy -p polyspec-orm -- -D warnings', '\tnode $(abspath tests/cargo-test.mts) y -- cargo test -p polyspec-orm',
    'parts: parts/a parts/b', 'parts/a:', "\t$(GO_TEST) ./a -count=1", 'parts/b:', '\tphp legacy/packages/php/tests/b_test.php',
  ].join('\n');
  assert.deepEqual(independentTestErrors(makefile).map(error => error.split(' runs ')[0]), ['Makefile two', 'Makefile linted']);
  assert.deepEqual(chainedCommandErrors({ features: [{ id: 'f', verification: [{ id: 'chained', command: 'node legacy/packages/ts/tests/a.mjs && node legacy/packages/ts/tests/b.mjs' }, { id: 'built', command: 'npm run typescript:build && node legacy/packages/ts/tests/a.mjs' }] }], helpers: [] }).map(error => error.split(' chains ')[0]),
    ['contracts/features.json f/chained']);
  const root = new URL('../..', import.meta.url).pathname;
  assert.deepEqual(independentTestErrors(readFileSync(join(root, 'Makefile'), 'utf8')), []);
  assert.deepEqual(chainedCommandErrors(readFeatures(root)), []);
  // The planner target runs no test in its own recipe: its suites are parts that make -j runs together (KSTD-5-23).
  const makefileLines = readFileSync(join(root, 'Makefile'), 'utf8').split('\n');
  const plannerAt = makefileLines.findIndex(line => line.startsWith('dbspec-php-extension-check/planner:'));
  const plannerRecipe: string[] = [];
  for (let index = plannerAt + 1; index < makefileLines.length && makefileLines[index]?.startsWith('\t'); index++) plannerRecipe.push(makefileLines[index] ?? '');
  assert.deepEqual(plannerRecipe, []);
});

caseTest('a script that starts a process group of its own checks that group after it ends', () => {
  assert.deepEqual(detachedGroupErrors({
    'a.mjs': "const child = spawn('go', ['test'], { detached: true });",
    'b.mjs': "const child = spawn('go', ['test'], { detached: true });\nchild.on('exit', () => endGroup(child.pid));",
    'c.mjs': "const child = spawn('go', ['test']);",
  }), ['a.mjs starts a process in a group of its own (detached: true) and never checks that group after it ends; check it with endGroup of scripts/check/step.mts and fail on what it left']);
  const root = new URL('../..', import.meta.url).pathname;
  const tracked = execFileSync('git', ['ls-files', '*.js', '*.mjs'], { cwd: root }).toString().split('\n').filter(Boolean).filter(notVendored);
  assert.deepEqual(detachedGroupErrors(Object.fromEntries(tracked.map(path => [path, readFileSync(join(root, path), 'utf8')]))), []);
});

caseTest('a test does not fail on a measured time above a bound', () => {
  assert.deepEqual(timeFailureErrors({
    'b.rs': '    assert!(cpu < Duration::from_secs(1), "cpu {cpu:?}");\n',
    'c.test.mjs': "    assert.ok(parseMs <= PARSE_BUDGET_MS, 'slow');\n",
    'd.php': "if ($cpuMs > 10000) {\n    throw new RuntimeException('slow');\n}\n",
  }).map(error => error.split(' fails ')[0]), ['b.rs:1', 'c.test.mjs:1', 'd.php:1']);
  // Warnings, lower bounds, comparisons of two measurements, and comparisons with 0 are not failures or are correctness checks.
  assert.deepEqual(timeFailureErrors({
    'f.rs': '    assert!(waited >= Duration::from_millis(200), "too early");\n    assert!(cpu * 4 < wall, "clock");\n',
    'g.test.mjs': "    check(event.elapsed >= 0, 'negative');\n",
  }), []);
  // Go source is read by the analyzer timefailure of tests/analyzers, never by this text rule.
  assert.throws(() => timeFailureErrors({ 'a_test.go': 'package a\n' }), /timeFailureErrors reads no Go source \(a_test\.go\); go vet runs the analyzer timefailure of tests\/analyzers over it/);
});

// The selection cases of ci.yml by the changed paths of a push (T418): its push trigger starts no run when every changed path
// is a document of DOCUMENT_PATHS, and every job otherwise; the version commit, an undeclared path and a change under
// legacy/packages/go run every group, the Go groups among them.
const repositoryRoot = new URL('../..', import.meta.url).pathname;
const ciPush = (): unknown => {
  const on = readWorkflow(readFileSync(join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8'), 'ci.yml').value['on'];
  return typeof on === 'object' && on !== null ? Object.entries(on).find(([event]) => event === 'push')?.[1] : undefined;
};
const SELECTION: { name: string; paths: string[]; starts: boolean }[] = [
  { name: 'a document-only push, the checklist cells of a row', paths: ['docs/plans/execution/checklist.md', 'docs/plans/execution/checklist.ko.md'], starts: false },
  { name: 'a push of the root documents and the plans', paths: ['README.md', 'README.ko.md', 'CHANGELOG.md', 'CHANGELOG.ko.md', 'PRINCIPLES.md', 'SECURITY.md', 'CONTRIBUTING.ko.md', 'CODE_OF_CONDUCT.md', 'docs/plans/cross-verification/plan.md', 'docs/plans/kit-standard/checklist.ko.md'], starts: false },
  { name: 'a change under legacy/packages/go', paths: ['legacy/packages/go/orm/db.go'], starts: true },
  { name: 'a change under legacy/packages/go pushed with documents', paths: ['docs/plans/execution/checklist.md', 'legacy/packages/go/orm/db.go'], starts: true },
  { name: 'AGENTS.md, which repo-check reads', paths: ['AGENTS.md'], starts: true },
  { name: 'the checklist of kit-standard, which the feature checks read', paths: ['docs/plans/kit-standard/checklist.md'], starts: true },
  { name: 'a spec, which the docs-implementation and recipe checks read', paths: ['docs/spec/dbspec.md'], starts: true },
  { name: 'an undeclared path', paths: ['notes.txt'], starts: true },
  { name: 'an undeclared plan', paths: ['docs/plans/new-plan/plan.md'], starts: true },
  { name: 'a version commit', paths: ['VERSION', 'CHANGELOG.md', 'CHANGELOG.ko.md', 'package.json', 'legacy/packages/ts/package.json', 'legacy/packages/php/composer.json'], starts: true },
];
for (const change of SELECTION) {
  caseTest(`ci.yml on push: ${change.name} ${change.starts ? 'starts every group' : 'starts no run'}`, () => {
    assert.equal(workflowStarts(ciPush(), change.paths), change.starts, `${change.paths.join(', ')} against ${JSON.stringify(ciPush())}`);
  });
}

caseTest('ci.yml ignores no package file of config/release.json and no VERSION, so a version commit runs every group', () => {
  const release: unknown = JSON.parse(readFileSync(join(repositoryRoot, 'config/release.json'), 'utf8'));
  const manifests: unknown = typeof release === 'object' && release !== null ? Object.entries(release).find(([key]) => key === 'manifests')?.[1] : undefined;
  assert.ok(typeof manifests === 'object' && manifests !== null, 'config/release.json names its manifests');
  for (const file of ['VERSION', ...Object.keys(manifests)]) assert.ok(workflowStarts(ciPush(), [file]), `ci.yml ignores ${file}`);
});

caseTest('T495: config/release.json releases the Composer package of the PHP extension of the binding under the name of the contract', () => {
  const release = parseJsonValue(text('config/release.json'), 'config/release.json');
  const contract = parseJsonValue(text('packages/rust/interface.json'), 'packages/rust/interface.json');
  const member = (value: Json | undefined, key: string): Json | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value[key] : undefined);
  const name = member(member(member(contract, 'packages'), 'php'), 'package');
  assert.equal(typeof name, 'string', 'packages/rust/interface.json names the PHP package in packages.php.package');
  assert.equal(readComposer(join(repositoryRoot, 'packages/php-ext/composer.json')).name, name, 'packages/php-ext/composer.json has the name of the contract');
  const packages = member(release, 'packages');
  const declared = Array.isArray(packages) ? packages.filter(item => member(item, 'directory') === 'packages/php-ext') : [];
  // PIE installs the extension from packages.json, which the release tool writes only for a package of the kind composer.
  assert.deepEqual(declared, [{ kind: 'composer', directory: 'packages/php-ext', name, product: 'orm', runtime: 'php-ext' }]);
  // The release tool packs a package only when its manifest is an archive manifest; git-tag names a manifest that no asset carries.
  assert.equal(member(member(release, 'manifests'), 'packages/php-ext/composer.json'), 'archive');
});

caseTest('a push trigger without a path filter starts on every push, and paths-ignore reads * within one segment', () => {
  assert.equal(workflowStarts({ branches: ['main'] }, ['README.md']), true);
  assert.equal(workflowStarts({ 'paths-ignore': ['*.md'] }, ['README.md']), false);
  assert.equal(workflowStarts({ 'paths-ignore': ['*.md'] }, ['legacy/packages/go/README.md']), true);
  assert.equal(workflowStarts({ 'paths-ignore': ['docs/plans/**'] }, ['docs/plans/a/b/c.md']), false);
  assert.throws(() => workflowStarts({ 'paths-ignore': 'docs/**' }, ['a']), /paths-ignore is no list of patterns/);
});

caseTest('every path that ci.yml ignores is read by the document checks of documents.yml alone', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repositoryRoot }).toString().split('\0').filter(Boolean);
  const documentChecks = (makeVariables(readFileSync(join(repositoryRoot, 'Makefile'), 'utf8')).get('DOCUMENT_CHECKS') ?? '').split(/\s+/).filter(Boolean);
  assert.ok(documentChecks.length > 0, 'the Makefile declares DOCUMENT_CHECKS');
  assert.deepEqual(documentPathErrors(DOCUMENT_PATHS, tracked, readCheckInputs(repositoryRoot).targets, documentChecks), []);
  assert.ok(tracked.some(file => !workflowStarts(ciPush(), [file])), 'ci.yml ignores a tracked path');
  // A path that a code check reads is refused: by the inputs of an owner target, by a lint that names it, and by a suite read.
  const targets = { 'docs-check': { inputs: ['**/*.md'] }, 'spec-check': { inputs: ['docs/spec/**'] }, 'go-vet-check': { lints: ['**/*.go'] }, 'repo-check': { lints: ['**'] } };
  assert.deepEqual(documentPathErrors(['docs/**', '*.go'], ['docs/spec/a.md', 'docs/plans/p.md', 'a.go'], targets, ['docs-check'], { 'feature-verify-rust': ['docs/plans/p.md'] }), [
    'ci.yml ignores docs/spec/a.md, which spec-check reads; remove it from DOCUMENT_PATHS of scripts/repo/ci.mts and the paths-ignore of ci.yml',
    'ci.yml ignores docs/plans/p.md, which feature-verify-rust reads; remove it from DOCUMENT_PATHS of scripts/repo/ci.mts and the paths-ignore of ci.yml',
    'ci.yml ignores a.go, which go-vet-check reads; remove it from DOCUMENT_PATHS of scripts/repo/ci.mts and the paths-ignore of ci.yml',
  ]);
});

const SHA_BEFORE = 'a'.repeat(40);
const SHA_AFTER = 'b'.repeat(40);
caseTest('the diff of a push is the two-dot diff of its before and after commits, and a manual run has none', () => {
  assert.deepEqual(diffOf('push', { ref: 'refs/heads/main', before: SHA_BEFORE, after: SHA_AFTER }), { range: `${SHA_BEFORE}..${SHA_AFTER}` });
  assert.ok('none' in diffOf('workflow_dispatch', {}));
  assert.throws(() => diffOf('push', { ref: 'refs/heads/main', before: '0'.repeat(40), after: SHA_AFTER }), /creates refs\/heads\/main/);
  assert.throws(() => diffOf('push', { before: SHA_BEFORE }), /the event has no after/);
  assert.throws(() => diffOf('pull_request', {}), /pull_request is none that ci\.yml filters/);
});

caseTest(`a diff of ${LIMIT} files passes the size check and one of ${LIMIT + 1} fails it`, () => {
  assert.equal(judge('x..y', LIMIT), undefined);
  assert.match(judge('x..y', LIMIT + 1) ?? '', /x\.\.y changes 3001 files, more than the 3000/);
});

caseTest('the size check counts the changed files of the range, a rename as its two paths', () => {
  const directory = mkdtempSync(join(tmpdir(), 'diff-size-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: directory, encoding: 'utf8' }).trim();
    git('init', '-q');
    writeFileSync(join(directory, 'a.md'), 'a\n');
    writeFileSync(join(directory, 'b.go'), 'package b\n');
    git('add', '.');
    git('commit', '-q', '--no-verify', '-m', 'one');
    const before = git('rev-parse', 'HEAD');
    writeFileSync(join(directory, 'a.md'), 'a2\n');
    git('mv', 'b.go', 'c.go');
    writeFileSync(join(directory, 'with space.txt'), 'x\n');
    git('add', '.');
    git('commit', '-q', '--no-verify', '-m', 'two');
    assert.equal(changedFiles(directory, `${before}..HEAD`), 4);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// The run check of a release (T418): make release-tag takes a successful push or manual run of ci.yml on the commit it tags,
// and refuses a run of any other workflow before kit tags. The fixtures are answers of gh api repos/<repo>/actions/runs/<id>.
const RELEASE_SHA = 'c'.repeat(40);
const apiRun = (fields: Record<string, unknown>): Record<string, unknown> => ({ id: 7, name: 'ci', path: '.github/workflows/ci.yml', event: 'push', status: 'completed', conclusion: 'success', head_sha: RELEASE_SHA, head_branch: 'main', ...fields });

caseTest('make release-tag runs the run check on RUN before kit tags its commit', () => {
  const makefile = readFileSync(join(repositoryRoot, 'Makefile'), 'utf8');
  const recipe = makefile.split(/^release-tag:.*\n/m)[1]?.split(/^\S/m)[0] ?? '';
  const check = recipe.indexOf('scripts/repo/release-run.mts "$$RUN"$(if $(AUTO), --commit "$$(git rev-parse HEAD)")');
  assert.ok(check >= 0, `the recipe of release-tag runs scripts/repo/release-run.mts on RUN:\n${recipe}`);
  assert.ok(recipe.indexOf('release-run.$(KIT_EXT) tag "$$RUN"') > check, 'the run check comes before the tag step of kit');
});

caseTest('a release takes a successful push or manual run of ci.yml, also on the commit that it tags', () => {
  assert.deepEqual(runErrors('7', apiRun({})), []);
  assert.deepEqual(runErrors('7', apiRun({}), RELEASE_SHA), []);
  assert.deepEqual(runErrors('7', apiRun({ event: 'workflow_dispatch' })), []);
});

caseTest('a release refuses a run of documents.yml and of docs-pages.yml and names the workflow', () => {
  for (const [id, workflow] of [['8', 'documents.yml'], ['9', 'docs-pages.yml']] as const) {
    assert.deepEqual(runErrors(id, apiRun({ path: `.github/workflows/${workflow}` })), [
      `run ${id} is a run of .github/workflows/${workflow}, not of .github/workflows/ci.yml; a release takes a successful run of .github/workflows/ci.yml`,
    ]);
  }
});

caseTest('a release refuses a ci.yml run of another event, without success or on another commit', () => {
  assert.deepEqual(runErrors('7', apiRun({ event: 'workflow_run' })), ['run 7 is a workflow_run run, not a push or workflow_dispatch run']);
  assert.deepEqual(runErrors('7', apiRun({ conclusion: 'cancelled' })), ['run 7 has the conclusion cancelled, not success']);
  assert.deepEqual(runErrors('7', apiRun({}), 'd'.repeat(40)), [`run 7 ran on ${RELEASE_SHA}, not on the commit ${'d'.repeat(40)} that the release tags`]);
  assert.deepEqual(runErrors('7', apiRun({ head_sha: 'abc' })), ['run 7 names no head_sha']);
  assert.equal(runErrors('7', { message: 'Not Found' }).length, 4);
  assert.equal(repositoryOf({ repositoryUrl: 'https://github.com/polyspec/orm' }), 'polyspec/orm');
  assert.throws(() => repositoryOf({}), /no repositoryUrl/);
});

// The trigger case (G5.98) checks that the `on:` blocks of ci.yml and docs-pages.yml match their declarations, and that other workflows do not run on push,
// pull_request or merge_group.
caseTest('every workflow runs on its declared events only', () => {
  const root = new URL('../..', import.meta.url).pathname;
  const directory = join(root, '.github/workflows');
  const actual = Object.fromEntries(readdirSync(directory).filter(name => /\.ya?ml$/.test(name)).map(name => [`.github/workflows/${name}`, readFileSync(join(directory, name), 'utf8')]));
  assert.deepEqual(workflowTriggerErrors(ownWorkflows(actual, kitOwned)), []);
  const text = (on: string[]) => `name: x\n${on.join('\n')}\n\njobs:\n  a:\n    runs-on: ubuntu\n`;
  const declared = Object.fromEntries(Object.entries(WORKFLOW_TRIGGERS).map(([path, on]) => [path, text([stringify({ on })])]));
  assert.deepEqual(workflowTriggerErrors(declared), []);
  assert.deepEqual(workflowTriggerErrors({ ...declared, '.github/workflows/ci.yml': text(['on:', '  pull_request:', '  push:', '    branches: [main]', '  workflow_dispatch:']) }), [
    `.github/workflows/ci.yml has the triggers {"pull_request":null,"push":{"branches":["main"]},"workflow_dispatch":null} instead of ${JSON.stringify(WORKFLOW_TRIGGERS['.github/workflows/ci.yml'])}`,
  ]);
  assert.deepEqual(workflowTriggerErrors({ ...declared, '.github/workflows/docs-pages.yml': text(['on:', '  push:', '    branches: [main]', '  pull_request:', '  workflow_dispatch:']) }), [
    '.github/workflows/docs-pages.yml has the triggers {"push":{"branches":["main"]},"pull_request":null,"workflow_dispatch":null} instead of {"push":{"branches":["main"]},"workflow_dispatch":null}',
  ]);
  const { ['.github/workflows/docs-pages.yml']: _, ...withoutPages } = declared;
  assert.deepEqual(workflowTriggerErrors({ ...withoutPages, '.github/workflows/review.yml': text(['on:', '  schedule:', "    - cron: '0 3 * * 1'", '  pull_request:']) }), [
    '.github/workflows/docs-pages.yml is missing; it runs on {"push":{"branches":["main"]},"workflow_dispatch":null}',
    '.github/workflows/review.yml runs on pull_request; only ci.yml, documents.yml and docs-pages.yml run on these events',
  ]);
  assert.deepEqual(workflowTriggerErrors({ ...declared, '.github/workflows/review.yml': text(['on:', '  schedule:', "    - cron: '0 3 * * 1'", '  workflow_dispatch:']) }), []);
  // release.yml is owned by Kit, so the table holds no entry for it (KSTD-5-25).
  assert.equal(Object.hasOwn(WORKFLOW_TRIGGERS, '.github/workflows/release.yml'), false);
  assert.deepEqual(workflowTriggerErrors({ ...declared, '.github/workflows/release.yml': text(['on:', '  push:', '    branches: [main]']) }), [
    '.github/workflows/release.yml runs on push; only ci.yml, documents.yml and docs-pages.yml run on these events',
  ]);
});

caseTest('every workflow that runs on push cancels the run of the push before it', () => {
  const concurrency = 'concurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\n';
  const workflow = (on: string, extra = '') => `name: x\non:\n${on}\n${extra}jobs:\n  a:\n    runs-on: ubuntu\n`;
  assert.deepEqual(concurrencyErrors({ 'a.yml': workflow('  push:\n    branches: [main]', concurrency) }), []);
  assert.deepEqual(concurrencyErrors({ 'b.yml': workflow('  workflow_dispatch:') }), []);
  assert.deepEqual(concurrencyErrors({ 'c.yml': workflow('  push:', 'concurrency:\n  group: c-${{ github.ref }}\n  cancel-in-progress: false\n') }).map(error => error.split(' ')[0]), ['c.yml']);
  assert.deepEqual(concurrencyErrors({ 'd.yml': workflow('  push:') }).map(error => error.split(' ')[0]), ['d.yml']);
  const root = new URL('../..', import.meta.url).pathname;
  const directory = join(root, '.github/workflows');
  assert.deepEqual(concurrencyErrors(ownWorkflows(Object.fromEntries(readdirSync(directory).filter(name => /\.ya?ml$/.test(name)).map(name => [name, readFileSync(join(directory, name), 'utf8')])), kitOwned)), []);
});

// mise.toml declares the one Go release (kit K127), which make install-tools installs from mise.lock, and every workflow
// that runs Go installs it with make install-tools, never with actions/setup-go.
const goWorkflow = 'jobs:\n  test:\n    steps:\n      - run: make install-tools TOOLS=npm\n      - run: make install-tools\n      - run: make orm-check\n';
caseTest('every workflow runs the Go of mise.toml', () => {
  assert.deepEqual(goVersionErrors({ 'ci.yml': goWorkflow }, ''), []);
  assert.deepEqual(goVersionErrors({ 'ci.yml': goWorkflow.replace('      - run: make install-tools\n', '      - uses: actions/setup-go@v6\n        with: { go-version-file: go.mod }\n') }, ''), [
    'ci.yml sets up Go with actions/setup-go; the Go of mise.toml is installed by make install-tools',
    'ci.yml runs Go without the Go of mise.toml; add a step that runs make install-tools',
  ]);
  assert.deepEqual(goVersionErrors({ 'ci.yml': 'jobs:\n  test:\n    steps:\n      - run: make install-tools TOOLS=npm\n      - run: make orm-check\n' }, ''), [
    'ci.yml runs Go without the Go of mise.toml; add a step that runs make install-tools',
  ]);
  // make ci-install-tools installs the Go of mise.toml in every CI group (KSTD-5-116).
  assert.deepEqual(goVersionErrors({ 'ci.yml': 'jobs:\n  test:\n    steps:\n      - run: make install-tools TOOLS=npm\n      - run: make ci-install-tools GROUP=static\n      - run: make orm-install-go\n' }, ''), []);
});

// The Go module path case (G5.113-5) checks that every go.mod in the repository declares the module path of its own directory, and rejects, in a minimal file, a root or subdirectory go.mod that declares another
// path.
caseTest('every go.mod declares the module path of its directory', () => {
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: repository }).toString().split('\0').filter(path => /(?:^|\/)go\.mod$/.test(path) && notVendored(path));
  assert.ok(paths.includes('legacy/packages/go/go.mod') && paths.includes('tests/go.mod') && paths.includes('examples/go.mod'), paths.join(' '));
  assert.deepEqual(goModulePathErrors(Object.fromEntries(paths.map(path => [path, text(path)]))), []);
  assert.deepEqual(goModulePathErrors({ 'go.mod': 'module github.com/polyspec/orm\n', 'tools/gen/go.mod': 'module github.com/polyspec/orm/tools/gen\n', 'README.md': '' }), []);
  assert.deepEqual(goModulePathErrors({ 'go.mod': 'module github.com/polyspec/orm/v2\n', 'legacy/packages/go/go.mod': 'module github.com/polyspec/orm\n', 'x/go.mod': 'go 1.27\n' }), [
    'go.mod declares the module github.com/polyspec/orm/v2; declare github.com/polyspec/orm, the path of its directory, so go get resolves it and its tags',
    'legacy/packages/go/go.mod declares the module github.com/polyspec/orm; declare github.com/polyspec/orm/legacy/packages/go, the path of its directory, so go get resolves it and its tags',
    'x/go.mod declares the module (none); declare github.com/polyspec/orm/x, the path of its directory, so go get resolves it and its tags',
  ]);
});

const MISE = '[tools]\n"http:composer" = { version = "2.10.3", url = "https://getcomposer.org/download/{{ version }}/composer.phar", bin = "composer" }\n';
caseTest('every setup-php step installs the Composer of mise.toml', () => {
  const php = 'jobs:\n  test:\n    steps:\n      - uses: shivammathur/setup-php@v2\n        with:\n          php-version-file: .php-version\n          tools: composer:2.10.3\n';
  assert.deepEqual(composerVersionErrors(MISE, { 'ci.yml': php }, '2.10.3'), []);
  assert.deepEqual(composerVersionErrors(MISE, { 'ci.yml': php.replace('          tools: composer:2.10.3\n', '') }, '2.11.0'), [
    'ci.yml sets up PHP without tools: composer:2.10.3; setup-php installs the newest Composer otherwise, so add tools: composer:2.10.3',
    'Composer 2.11.0 runs the checks; mise.toml declares 2.10.3, so its major and minor must be 2.10; run make install-tools, which installs the Composer of mise.toml, or change mise.toml together with the CI evidence of the new release',
  ]);
  assert.deepEqual(composerVersionErrors('[tools]\n', { 'ci.yml': php }, '2.10.3'), [
    'mise.toml must declare the tool http:composer with one exact Composer release x.y.z as its version, found ""; write the release that CI and the local checks run',
  ]);
});

// T70: a running Composer is accepted regardless of patch if its major and minor match the declared release.
caseTest('a running Composer with the declared major and minor passes whatever its patch', () => {
  const php = 'jobs:\n  test:\n    steps:\n      - uses: shivammathur/setup-php@v2\n        with:\n          php-version-file: .php-version\n          tools: composer:2.10.3\n';
  for (const running of ['2.10.3', '2.10.0', '2.10.9'])
    assert.deepEqual(composerVersionErrors(MISE, { 'ci.yml': php }, running), [], running);
  for (const running of ['2.9.9', '2.11.0'])
    assert.deepEqual(composerVersionErrors(MISE, { 'ci.yml': php }, running), [
      `Composer ${running} runs the checks; mise.toml declares 2.10.3, so its major and minor must be 2.10; run make install-tools, which installs the Composer of mise.toml, or change mise.toml together with the CI evidence of the new release`,
    ], running);
});

caseTest('a Makefile build output is published through a temporary file', () => {
  const makefile = [
    'LEASE_BUILD = go build -o $(LEASE) ./tests/lease',
    'PUBLISHED = $(PUBLISH) $(LEASE) go build -o @OUT@ ./tests/lease',
    'doc:',
    '\tnode tests/dbspec/stress.mts > $(DOC)',
    '\t$(PUBLISH) $(DOC) node tests/dbspec/stress.mts',
    '\ttest -f x || { echo "x is missing" >&2; exit 1; }',
    '\t@test -n "$(W)" || { echo "usage: make x W=<path>" >&2; exit 2; }',
    '\tsh -c "node x.mts > out.txt"',
    '\tnode legacy/packages/ts/node_modules/typescript/bin/tsc -p legacy/packages/ts/tsconfig.build.json',
    '\tnode legacy/packages/ts/node_modules/typescript/bin/tsc -p legacy/packages/ts/tsconfig.json --noEmit',
    '# go build -o $(LEASE) in a comment',
    '\tvendor-php/bin/orm-gen gen --set contracts/fixtures/bench/dbspec-set.json --out legacy/packages/php/gen',
    'test-x: ## Run the tests with CASES=<pattern>; offline',
    '\t@for name in $(NAMES); do echo "$$name=$$(printenv $$name)"; done >> "$$GITHUB_ENV"',
  ].join('\n');
  assert.deepEqual(unpublishedOutputErrors(makefile).map(error => error.split(', so ')[0]), [
    'Makefile:1 writes a Go build output in place',
    'Makefile:4 redirects a command into a file in place',
    'Makefile:8 redirects a command into a file in place',
    'Makefile:9 runs tsc into dist in place',
    'Makefile:12 writes the generated output directory in place',
  ]);
  assert.deepEqual(unpublishedOutputErrors(readFileSync(new URL('../../Makefile', import.meta.url), 'utf8')), []);
});

caseTest('a failure message for a missing condition names its fix', () => {
  // The fixture's text is built by concatenation: this file is also a check target.
  const required = ['is', 'required'].join(' ');
  const files: Record<string, string> = {
    'tests/a.mjs': `if (!dsn) throw new Error('ORM_TEST_MYSQL_DSN ${required}; database tests never skip');\n// ORM_TEST_MYSQL_DSN ${required} in a comment\n`,
    'tests/b_test.go': `\tt.Fatal("ORM_TEST_MYSQL_DSN ${required}; run the test through its make target, which reads the environment of make orm-test-servers")\n`,
    'scripts/c.sh': `: "\${BENCH_DSN:?BENCH_DSN ${required}}"\ncommand -v x >/dev/null || { echo "x ${['is', 'not', 'installed'].join(' ')}; run make orm-install-server-programs" >&2; exit 1; }\n`,
  };
  assert.deepEqual(fixlessMessageErrors(files).map(error => error.split(': a failure')[0]), ['tests/a.mjs:1', 'scripts/c.sh:1']);
});

caseTest('no Makefile or script fixes a TCP port of the test servers', () => {
  const makefile = ['TEST_MYSQL_PORT = 33171', '# TEST_POSTGRES_PORT = 55471', 'orm-test-servers:', '\tnode scripts/test-servers.mts start $(TEST_MYSQL_PORT)', '\tnode scripts/test-servers.mts start'].join('\n');
  assert.deepEqual(fixedPortErrors({ Makefile: makefile, 'scripts/a.sh': 'export PGPORT=5432\nport=$(node scripts/free-ports.mts 1)\n' }).map(error => error.split(' fixes ')[0]), [
    'Makefile:1', 'Makefile:4', 'scripts/a.sh:1',
  ]);
  const tracked = execFileSync('git', ['ls-files', 'Makefile', '*.sh'], { cwd: new URL('../..', import.meta.url).pathname }).toString().split('\n').filter(Boolean).filter(notVendored);
  assert.deepEqual(fixedPortErrors(Object.fromEntries(tracked.map(path => [path, readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')]))), []);
});

// The shell reader case (T137-1-4-2) checks that commands are read by the shell parser (unbash): an escaped quote outside quotes, comments, make's
// joined lines and references, workflow expressions, `&&` lists, and commands that the parser rejects.
caseTest('the checks read commands with the shell parser', () => {
  // An escaped quote opens no string, so the command after the `;` is a command of its own.
  assert.deepEqual(segments("echo it\\'s; go vet ./a", 'sh'), ["echo it\\'s", 'go vet ./a']);
  assert.deepEqual(unwrappedToolErrors([{ name: 'x', commands: ["echo it\\'s; go vet ./a"], dialect: 'sh' }]),
    ['x runs go vet outside tests/run-long.mts, so it has no RUN line or step log: go vet ./a']);
  // A comment runs nothing.
  assert.deepEqual(segments('true # see go vet && go vet ./a', 'sh'), ['true']);
  assert.deepEqual(unwrappedToolErrors([{ name: 'x', commands: ['true # see go vet && go vet ./a'], dialect: 'sh' }]), []);
  // The commands of a group, a loop and an if are commands; their keywords and word lists are not.
  assert.deepEqual(segments('for f in a b; do test -f "$f" || { echo "$f is missing"; exit 1; }; done; if [ -n "$x" ]; then go vet ./a; else exit 2; fi', 'sh'),
    ['test -f "$f"', 'echo "$f is missing"', 'exit 1', '[ -n "$x" ]', 'go vet ./a', 'exit 2']);
  // make reads a recipe line that ends in a backslash with the next line, drops the prefixes @, - and +, reads $$ as $ and
  // gives each reference one word; the segment is the text of the recipe.
  assert.deepEqual(recipeLines('x:\n\t@if true; then \\\n\t  go vet ./a; \\\n\tfi\n\techo \\\\\n'),
    [{ recipe: false, text: 'x:' }, { recipe: true, text: '@if true; then \\\n  go vet ./a; \\\nfi' }, { recipe: true, text: 'echo \\\\' }, { recipe: false, text: '' }]);
  assert.deepEqual(makeRecipes('x:\n\t@if true; then \\\n\t  go vet ./a; \\\n\tfi\n').map(unit => unit.commands), [['@if true; then \\\n  go vet ./a; \\\nfi']]);
  assert.deepEqual(unwrappedToolErrors(makeRecipes('x:\n\t@if true; then \\\n\t  go vet ./a; \\\n\tfi\n')),
    ['Makefile x runs go vet outside tests/run-long.mts, so it has no RUN line or step log: go vet ./a']);
  assert.deepEqual(segments('-files=$$(gofmt -l $(GO_DIRS)); [ -z "$$files" ] || $(if $(RECORD),echo a,echo b)', 'make'),
    ['files=$$(gofmt -l $(GO_DIRS))', '[ -z "$$files" ]', '$(if $(RECORD),echo a,echo b)']);
  assert.deepEqual(shellSegments('$(RUN_LONG) x -- cargo +$(shell sed -n p f) clippy', 'make'), ['VALUE x -- cargo +VALUE clippy']);
  assert.deepEqual(segments('make check-run GROUP=${{ matrix.group }} && echo "${{ github.ref }}"', 'workflow'),
    ['make check-run GROUP=${{ matrix.group }}', 'echo "${{ github.ref }}"']);
  assert.deepEqual(andLists('a && b || c && d; e', 'sh'), [['a', 'b'], ['c', 'd']]);
  for (const command of ['time -p ! go test ./legacy/packages/go/orm', '! time go test ./legacy/packages/go/orm', '! go test ./legacy/packages/go/orm']) {
    assert.deepEqual(segments(command, 'sh'), ['go test ./legacy/packages/go/orm'], command);
    assert.deepEqual(shellSegments(command, 'sh'), ['go test ./legacy/packages/go/orm'], command);
  }
  // A command the parser rejects is an error, never a guess.
  assert.throws(() => segments("sh -c 'cd legacy/packages/ts", 'sh'), /the shell parser rejects this sh command at \d+: .*: sh -c 'cd legacy\/packages\/ts/);
  assert.throws(() => segments('echo $(RUN_LONG', 'make'), /the make reference at 5 never closes/);
});

// The workflow reader case (T137-1-4-2) checks that workflows are read as YAML documents: flow-form steps, timeout-minutes in action inputs,
// and a workflow that is not YAML or has no jobs.
caseTest('the checks read a workflow as a YAML document', () => {
  // A step in flow style is a step.
  assert.deepEqual(readWorkflow('jobs:\n  test:\n    steps:\n      - { name: tests, run: make ci-test }\n').jobs[0]?.steps[0]?.run, 'make ci-test');
  // An input of an action named timeout-minutes is no deadline of the step.
  assert.deepEqual(stepTimeoutErrors({ 'ci.yml': 'jobs:\n  test:\n    steps:\n      - uses: some/action@v1\n        with:\n          timeout-minutes: 5\n' }), []);
  // A step's run text is its value, with the indentation of a block scalar removed.
  assert.deepEqual(readWorkflow('jobs:\n  test:\n    steps:\n      - run: |\n          make a\n          make b\n').jobs[0]?.steps[0]?.run, 'make a\nmake b\n');
  assert.throws(() => readWorkflow('jobs:\n  test:\n    steps:\n      - run: make a\n     - run: go test ./...\n'), /^Error: the workflow is no YAML document: /);
  assert.throws(() => readWorkflow('jobs:\n  a: {}\n  a: {}\n', 'x.yml'), /^Error: x\.yml is no YAML document: Map keys must be unique/);
  assert.throws(() => readWorkflow('    steps:\n      - run: make a\n', 'x.yml'), /^Error: x\.yml has no map of jobs$/);
  assert.throws(() => readWorkflow('jobs:\n  a:\n    steps:\n      - run: true\n', 'x.yml'), /^Error: x\.yml job a step 1 run is not a string$/);
});

// The Makefile rules are read by the shell reader (scripts/repo/shell.mts) and the recipe reader (makeRecipes): a command is
// a segment the text runs, never a substring of a line (T137-1-4-2-1).
caseTest('the toolchain checks read the commands that a step runs', () => {
  const go = (run: string) => `jobs:\n  test:\n    steps:\n      - run: make install-tools TOOLS=npm\n      - run: ${run}\n`;
  assert.deepEqual(goVersionErrors({ 'ci.yml': go('echo go test') }, ''), []);
  assert.deepEqual(goVersionErrors({ 'ci.yml': go('cd a; go test ./...') }, ''), ['ci.yml runs Go without the Go of mise.toml; add a step that runs make install-tools']);
  assert.deepEqual(goVersionErrors({ 'ci.yml': go('cd a; go test ./...\n      - run: echo "make install-tools"') }, ''), ['ci.yml runs Go without the Go of mise.toml; add a step that runs make install-tools']);
  assert.deepEqual(phpVersionErrors('8.5\n', '>=8.4', { 'ci.yml': go('echo "php is not used"') }, ''), []);
  const viaMake = rust.replace('run: make install-tools TOOLS=rust', 'run: make orm-install-rust-toolchain');
  for (const recipe of ['\tPATH="$(HOME)/.cargo/bin:$(PATH)" $(MAKE) --no-print-directory install-tools TOOLS=rust && rustc --version\n', "\t@$(MAKE) install-tools 'TOOLS=go rust'\n"])
    assert.deepEqual(rustToolchainErrors(toolchain, `${makefile}orm-install-rust-toolchain:\n${recipe}`, { 'ci.yml': viaMake }, '1.98.1'), [], recipe);
  for (const recipe of ['\t# $(MAKE) install-tools TOOLS=rust\n\ttrue\n', '\techo $(MAKE) install-tools TOOLS=rust\n', '\t$(MAKE) install-tools TOOLS=go\n'])
    assert.deepEqual(rustToolchainErrors(toolchain, `${makefile}orm-install-rust-toolchain:\n${recipe}`, { 'ci.yml': viaMake }, '1.98.1'),
      ['ci.yml does not install the toolchain of rust-toolchain.toml with make install-tools TOOLS=rust'], recipe);
  // The recipe that kept the bare rustup toolchain install of CI run 44038491048 fails.
  assert.deepEqual(rustToolchainErrors(toolchain, `${makefile}orm-install-rust-toolchain:\n\trustup toolchain install\n`, { 'ci.yml': viaMake }, '1.98.1'),
    ['ci.yml does not install the toolchain of rust-toolchain.toml with make install-tools TOOLS=rust', 'ci.yml installs the Rust toolchain with rustup toolchain install, which installs the exported RUSTUP_TOOLCHAIN without the components and targets of rust-toolchain.toml; run make install-tools TOOLS=rust']);
  assert.deepEqual(rustToolchainErrors(toolchain, makefile, { 'ci.yml': rust.replace('cargo test --locked', 'echo "cargo +nightly"') }, '1.98.1'), []);
});

// The error code files are build output of orm-codes-<lang> (config/generated.json): a target that reads one has the target that
// writes it among its prerequisites, directly or through a hub, so make writes the file before the recipe reads it.
caseTest('a target that reads an error code file has the target that writes it as a prerequisite', () => {
  assert.deepEqual(generatedCodesErrors(text('Makefile')), []);
  const kit = 'lint-ts: typescript-build\nlint-php test-php-ext: orm-codes-php\n';
  const makefile = [
    'orm-codes: orm-codes-typescript orm-codes-php orm-codes-python',
    'orm-codes-typescript orm-codes-php orm-codes-python: orm-codes-%:',
    '\tcd legacy/packages/go && $(PUBLISH) $(CURDIR)/$(ORM_CODES_$*) $(GO) run ./cmd/orm-gen errors --lang $* --out @OUT@',
    'typescript-build: lease-tool orm-codes-typescript',
    '\t$(HOLD_TYPESCRIPT)',
    'php-vendor-check: orm-codes-php',
    '\ttest -f vendor-php/autoload.php',
    'python-venv-check: orm-codes-python',
    '\ttest -x $(PYTHON_VENV)/bin/python',
    'ts-hub: lease-tool',
    '\t$(HOLD_TYPESCRIPT)',
    '\t$(TSC_BUILD)',
    'ts-bare: lease-tool',
    '\t$(HOLD_TYPESCRIPT)',
    '\t$(TSC_BUILD)',
    'ts-hub: orm-codes-typescript',
    'ts-later: ts-hub',
    '\tnpm run typescript:check',
    'php-unit: php-vendor-check',
    '\tenv ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- legacy/packages/php/tests/CodeCatalogTest.php',
    'php-bare:',
    '\t$(PHP) legacy/packages/php/bin/tool.php',
    'php-extension-run: lease-tool',
    '\tPOLYSPEC_ORM_EXTENSION=$(PHP_EXTENSION_LIBRARY) go test ./x',
    'python-unit: python-venv-check',
    '\t$(RUN_TESTS) python --venv $(PYTHON_VENV) --module x',
    'python-bare:',
    '\t$(PYTHON_VENV)/bin/python -m x',
    'all-codes: orm-codes',
    '\tORM_PYTHON=$(PYTHON_VENV)/bin/python POLYSPEC_ORM_EXTENSION=x node scripts/features/owners.mts',
    'docs-bare:',
    '\t$(NPM) run docs:verify-idempotent',
    'checker-bare: lease-tool',
    '\t$(NODE) scripts/features/coverage.mts --runtime go --database mysql',
    'extension-build:',
    '\tsh legacy/packages/php-ext/scripts/build.sh x.so',
    '',
  ].join('\n');
  const missing = (target: string, language: string) => `Makefile ${target} reads the ${language} error code file without the prerequisite orm-codes-${language}, which writes it; add orm-codes-${language}, or php-vendor-check or python-venv-check, which have it, to its prerequisites`;
  // A recipe that starts the interface checker, here through the coverage tests of a client, reads the files of every language.
  const bare = [
    missing('ts-bare', 'typescript'),
    missing('php-bare', 'php'),
    missing('php-extension-run', 'php'),
    missing('python-bare', 'python'),
    missing('docs-bare', 'typescript'),
    missing('checker-bare', 'typescript'),
    missing('checker-bare', 'php'),
    missing('checker-bare', 'python'),
  ];
  assert.deepEqual(generatedCodesErrors(kit + makefile), bare);
  // A kit target whose recipe kit.mk owns reads the files as well: the Makefile adds its prerequisite.
  assert.deepEqual(generatedCodesErrors(makefile), [
    ...bare,
    missing('lint-ts', 'typescript'),
    missing('lint-php', 'php'),
    missing('test-php-ext', 'php'),
  ]);
});

// build.sh reads the arginfo header and the copy of the SQLite cancel callback, build output of php-ext-sources, and refuses a stale
// or missing one: only php-ext-build, which has php-ext-sources as a prerequisite, runs it.
caseTest('only php-ext-build runs the build of the PHP extension', () => {
  assert.deepEqual(phpExtensionBuildErrors(text('Makefile')), []);
  const makefile = [
    'php-ext-build: php-ext-sources',
    '\t$(RUN_LONG) php-extension-build -- sh legacy/packages/php-ext/scripts/build.sh "$(PHP_EXT_OUT)" $(PHP_EXT_MODE)',
    'through-call: php-vendor-check',
    '\t$(call php_ext_build,"$$run_dir/polyspec_orm.so",native-test)',
    'direct: php-vendor-check php-ext-sources',
    '\t$(RUN_LONG) php-extension-build -- sh legacy/packages/php-ext/scripts/build.sh "$$run_dir/polyspec_orm.so"',
    'in-a-chain:',
    '\t@set -eu; \\',
    '\tif sh legacy/packages/php-ext/scripts/build.sh x.so; then :; fi',
    'unrelated:',
    '\tsh legacy/packages/php-ext/scripts/other.sh',
    '',
  ].join('\n');
  const direct = (target: string) => `Makefile ${target} runs legacy/packages/php-ext/scripts/build.sh itself; build the extension with $(call php_ext_build,<output>,<mode>), which runs php-ext-build after php-ext-sources`;
  assert.deepEqual(phpExtensionBuildErrors(makefile), [direct('direct'), direct('in-a-chain')]);
});

// The lease tool is built once per job (B3-7): two targets of one job that need it run one build, and the second finds the
// published file up to date. The build is the publish of the lease program (BUILD_LEASE), so a fake publish, given on the
// command line, counts its calls and writes the output file it is given.
caseTest('the lease tool is built once for two targets of one job', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orm-lease-build-'));
  try {
    const log = join(dir, 'build.log');
    const publish = join(dir, 'publish');
    writeFileSync(publish, `#!/bin/sh\necho build >> "${log}"\nmkdir -p "$(dirname "$1")"\ntouch "$1"\n`);
    chmodSync(publish, 0o755);
    const lease = join(dir, 'bin', 'lease');
    for (let run = 0; run < 2; run += 1) {
      const result = spawnSync('make', ['-s', 'lease-tool', `LEASE=${lease}`, `PUBLISH=${publish}`], { cwd: fileURLToPath(repository), encoding: 'utf8', env: isolatedEnvironment() });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    const builds = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
    assert.equal(builds, 1, `the lease tool was built ${builds} times by two targets of one job; it is built once`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The CI jobs case (CR9) checks that no CHECK_TARGETS target runs in two CI jobs: a test group, the kit gates or the docs job (make docs-ci). A target that two jobs run is run twice in one CI run.
caseTest('no target of CHECK_TARGETS runs in two CI jobs', () => {
  assert.deepEqual(jobOverlapErrors(text('Makefile')), []);
});

// The locked caches case (CR8, B3-4) checks that every CI job restores the caches of its locked installs: npm is cached by its
// package-lock.json files, and the composer, uv, Go module and mise tool installs each follow a cache keyed by their lock file.
caseTest('every CI job restores the caches of its locked installs', () => {
  assert.deepEqual(lockedCacheErrors(text('.github/workflows/ci.yml'), text('Makefile')), []);
  // A hashFiles key is evaluated again after the last step, over the workspace as the job left it (CI run 42784034583).
  // T497: the key is an output of the job plan, whose recipe ci-plan hashes the lock files, and the job needs plan.
  const plan = 'ci-plan:\n\t@$(MAKE) ci-lock-hashes\nci-test:\n\t@$(CI_JOB) setup $(CI_NAME) python -- orm-install-python\n';
  const cache = (key: string, needs = '    needs: [plan]\n') => ['jobs:', '  plan:', '    steps:', '      - run: make ci-plan', '  test:', `${needs}    steps:`, '      - uses: actions/cache@v4', '        with:', '          path: ~/.cache/uv', `          key: ${key}`, '      - run: make ci-test', ''].join('\n');
  const refused = ['ci.yml job test installs the uv packages through make ci-test with no cache before its run step, keyed by needs.plan.outputs.uv of the job plan (~/.cache/uv)'];
  assert.deepEqual(lockedCacheErrors(cache('uv-${{ needs.plan.outputs.uv }}'), plan), []);
  // A hashFiles key is evaluated again after the last step, over the workspace as the job left it (CI run 42784034583).
  assert.deepEqual(lockedCacheErrors(cache("uv-${{ hashFiles('**/uv.lock') }}"), plan), refused);
  assert.deepEqual(lockedCacheErrors(cache('uv-${{ needs.plan.outputs.uv }}', ''), plan), refused, 'a key of the job plan in a job that does not need it');
  assert.deepEqual(lockedCacheErrors(cache('uv-${{ needs.plan.outputs.uv }}'), plan.replace('ci-lock-hashes', 'other')), ['the recipe ci-plan does not write the hashes of the lock files (make ci-lock-hashes)']);
  assert.deepEqual(lockedCacheErrors('jobs:\n  test:\n    steps:\n      - run: make ci-test\n', plan), ['ci.yml has no job plan that runs make ci-plan, whose outputs key the caches of the other jobs']);
});

// The generator case (CR6, B3-2) runs go-models twice on the same inputs with a fake go on the command line. The fake logs each `run`,
// the generator call. The first make runs the generator and the second, on the same tracked inputs, runs none.
caseTest('an up-to-date Go model generator runs nothing again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orm-generate-once-'));
  try {
    const log = join(dir, 'go.log');
    const fake = join(dir, 'go');
    writeFileSync(fake, `#!/bin/sh\ncase "$1" in\n  version) echo fake ;;\n  run) echo run >> "${log}" ;;\nesac\nexit 0\n`);
    chmodSync(fake, 0o755);
    const stamp = join(dir, 'go-models.key');
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
    const make = () => {
      const result = spawnSync('make', ['-s', 'go-models', `GO=${fake}`, `GO_MODELS_STAMP=${stamp}`], { cwd: fileURLToPath(repository), encoding: 'utf8', env: isolatedEnvironment() });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    };
    make();
    const first = calls();
    assert.ok(first > 0, 'the first run generates the Go models');
    make();
    assert.equal(calls() - first, 0, `the second run on the same inputs generated ${calls() - first} times; an up-to-date generator writes nothing`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The native test case (T400-1) checks the rule of FCV-2 over a fixture of the inventory of contracts/implementations.json, of the
// features of contracts/features.json and of the spec. The check of `make repo-check` runs the same rule on the tree itself
// (scripts/repo/check.mts), which names the native tests that wait for their recipe, so this case holds the rule and not the tree.
const nativeFiles: Record<string, string> = {
  'legacy/packages/go/orm/a_test.go': 'package orm\n\nfunc TestShared(t *testing.T) {}\n\nfunc TestStated(t *testing.T) {}\n',
  'legacy/packages/php/tests/ATest.php': '<?php\nfinal class ATest extends TestCase\n{\n    use ACases;\n\n    public function testOwn(): void {}\n}\n',
  'legacy/packages/php/tests/ACases.php': '<?php\ntrait ACases\n{\n    public function testFromTrait(): void {}\n}\n',
  'legacy/packages/go/orm/recipe_a_test.go': 'package orm\n\nfunc TestRecipeANone(t *testing.T) { recipe.Run(t) }\n',
  'legacy/packages/go/orm/only_test.go': 'package orm\n\nfunc TestGoOnly(t *testing.T) {}\n',
  'packages/rust/tests/cases/a.rs': '#[tokio::main]\n// Requirements: X.\nasync fn a_trial() {}\n\npub fn trials() -> Vec<Trial> {\n    native_trials!("a": a_trial)\n}\n#[test]\n// a comment\nfn an_attributed_test() {}\n',
};
const nativeInputs = (lines: string[], files: Record<string, string> = nativeFiles) => ({
  // The internal test of Go is not in the inventory: contracts/implementations.json declares it in `internal`, which the inventory leaves out.
  tests: { go: ['legacy/packages/go/orm/a_test.go', 'legacy/packages/go/orm/recipe_a_test.go', 'legacy/packages/go/orm/only_test.go'], php: ['legacy/packages/php/tests/ATest.php'], rust: ['packages/rust/tests/cases/a.rs'] },
  features: [
    { id: 'shared', files: ['legacy/packages/go/orm/a_test.go', 'legacy/packages/go/orm/recipe_a_test.go', 'legacy/packages/php/tests/ATest.php', 'packages/rust/tests/cases/a.rs', 'legacy/packages/go/orm/internal_test.go'] },
    { id: 'go-alone', files: ['legacy/packages/go/orm/only_test.go'] },
  ],
  recipeTests: new Set(['legacy/packages/go/orm/recipe_a_test.go']),
  caseRunnerTests: new Set<string>(),
  spec: ['- **FCV-1** Each feature declares its coverage.', '- **FCV-2** One spec holds every orm test.', ...lines,
    '- **FCV-22** A recipe with a fixture is one suite unit per database.', '  - In `legacy/packages/go/orm/a_test.go`, `TestShared` stays as a native test: this line is outside FCV-2.', ''].join('\n'),
  files: Object.keys(files),
  read: (file: string) => {
    const content = files[file];
    if (content === undefined) throw new Error(`no file ${file} in this fixture`);
    return content;
  },
});
const unstated = (file: string, name: string) => `${file}: the native test ${name} of the shared feature shared runs no recipe, and no line of FCV-2 names it; make it the cases of a recipe (FCV-2 to FCV-4), or state why it stays native in FCV-2 of docs/spec/feature-coverage.md as in \`${file}\`, \`${name}\``;
const statedAll = [
  '  - In `legacy/packages/go/orm/a_test.go`, `TestShared` and `TestStated` stay as native tests: a reason.',
  '  - `a-unit` stays native in PHP and Rust, as an FCV-2 surface: a reason. Its tests: in `legacy/packages/php/tests/ATest.php`, `testOwn` and `testFromTrait`; in `packages/rust/tests/cases/a.rs`, `a_trial`, `an_attributed_test`.',
];
caseTest('a native test of a shared behaviour that FCV-2 does not name is a finding', () => {
  assert.deepEqual(nativeTestErrors(nativeInputs(statedAll.slice(1))), [unstated('legacy/packages/go/orm/a_test.go', 'TestShared'), unstated('legacy/packages/go/orm/a_test.go', 'TestStated')]);
  // A test that a PHP class takes from a trait of a support file, a Rust trial and a Rust test under a comment are native tests too.
  assert.deepEqual(nativeTestErrors(nativeInputs(statedAll.slice(0, 1))), [unstated('legacy/packages/php/tests/ATest.php', 'testOwn'), unstated('legacy/packages/php/tests/ATest.php', 'testFromTrait'),
    unstated('packages/rust/tests/cases/a.rs', 'an_attributed_test'), unstated('packages/rust/tests/cases/a.rs', 'a_trial')]);
});

// A Rust file of cases without native_trials! makes its trials in the harness function `trials`, which is its native test (T400-1).
// Requirements: FCV-2.
caseTest('the harness function trials of a Rust file of cases is its native test', () => {
  const harness = 'packages/rust/tests/cases/b.rs';
  const files = { ...nativeFiles, [harness]: 'pub fn trials() -> Vec<Trial> {\n    cases().map(|c| Trial::test(c.id, run)).collect()\n}\n' };
  const inputs = nativeInputs(statedAll, files);
  const [shared, ...others] = inputs.features;
  assert.ok(shared !== undefined, 'the fixture has the shared feature');
  const widened = { ...inputs, tests: { ...inputs.tests, rust: [...inputs.tests.rust, harness] }, features: [{ ...shared, files: [...shared.files, harness] }, ...others] };
  assert.deepEqual(nativeTestErrors(widened), [unstated(harness, 'trials')]);
  assert.deepEqual(nativeTestErrors({ ...widened, spec: widened.spec.replace('- **FCV-22**', `  - In \`${harness}\`, \`trials\` stays as a native test: a compile fixture.\n- **FCV-22**`) }), []);
});
caseTest('a native test that a line of FCV-2 names with its reason passes, and so do a recipe, an internal and a one-runtime test', () => {
  // recipe_a_test.go runs a recipe, internal_test.go is no test of the inventory, and only_test.go is a feature of Go alone.
  assert.deepEqual(nativeTestErrors(nativeInputs(statedAll)), []);
  assert.deepEqual(nativeLines(nativeInputs(statedAll).spec).map(line => line.tests.length), [2, 4]);
  // A list of paths after `in` names files and no test.
  assert.deepEqual(nativeLines(nativeInputs(['  - `a-unit` stays native: its measurement stays in `legacy/packages/go/orm/a_test.go`, `legacy/packages/php/tests/ATest.php` and `b.mjs`. In `legacy/packages/go/orm/a_test.go`, `TestShared` is one.']).spec)
    .map(line => line.tests), [[{ file: 'legacy/packages/go/orm/a_test.go', name: 'TestShared' }]]);
  // A line may name the test of one runtime, which needs no line, as long as the test is there.
  assert.deepEqual(nativeTestErrors(nativeInputs([...statedAll, '  - In `legacy/packages/go/orm/only_test.go`, `TestGoOnly` stays as a native test: only Go has it.'])), []);
});
// A test that runs every case of a case file in every runtime (CASE_RUNNERS, FCV-23) is no native test, and the other tests of its
// file still are (T400-1).
// Requirements: FCV-2, FCV-23.
caseTest('a case runner test is no native test, and the other tests of its file are', () => {
  const inputs = nativeInputs(statedAll.slice(1));
  assert.deepEqual(nativeTestErrors({ ...inputs, caseRunnerTests: new Set(['legacy/packages/go/orm/a_test.go\0TestShared']) }), [unstated('legacy/packages/go/orm/a_test.go', 'TestStated')]);
  // A line that names the case runner test names no native test of that file.
  assert.deepEqual(nativeTestErrors({ ...nativeInputs(statedAll), caseRunnerTests: new Set(['legacy/packages/go/orm/a_test.go\0TestShared']) }),
    ['docs/spec/feature-coverage.md FCV-2 keeps the native test TestShared of legacy/packages/go/orm/a_test.go, and that file holds no such test; remove the name from the line']);
});
caseTest('a line of FCV-2 that names no native test is a finding', () => {
  const spec = 'docs/spec/feature-coverage.md FCV-2';
  assert.deepEqual(nativeTestErrors(nativeInputs([...statedAll, '  - In `legacy/packages/go/orm/a_test.go`, `TestGone` stays as a native test: a reason.'])),
    [`${spec} keeps the native test TestGone of legacy/packages/go/orm/a_test.go, and that file holds no such test; remove the name from the line`]);
  for (const file of ['legacy/packages/go/orm/recipe_a_test.go', 'legacy/packages/go/orm/internal_test.go', 'legacy/packages/php/tests/ACases.php']) {
    assert.deepEqual(nativeTestErrors(nativeInputs([...statedAll, `  - In \`${file}\`, \`TestX\` stays as a native test: a reason.`])),
      [`${spec} keeps native tests of ${file}, which is no native test file (a recipe test, a support file, an internal test, a file that no feature lists or no test file); remove the name from the line`]);
  }
  const unnamed = '  - `gone-unit` (X-1) stays native in every runtime: a reason that names no test.';
  assert.deepEqual(nativeTestErrors(nativeInputs([...statedAll, unnamed])),
    [`${spec} line "${unnamed.trim()}" names no native test; name each test it keeps as in \`file\`, \`test\`, or remove the line`]);
  const reasonless = '  - In `legacy/packages/go/orm/only_test.go`, `TestGoOnly` stays as a native test.';
  assert.deepEqual(nativeTestErrors(nativeInputs([...statedAll, reasonless])), [`${spec} line "${reasonless.trim()}" states no reason after a colon; state why its tests stay native`]);
});

// The generated tests of a binding (binding G-5) are one file for each runtime, and a test of a case of
// contracts/interface/service.json fails without the address of its test server (binding GN-13j). So each of the four test
// targets has two selections by test name (scripts/repo/binding-tests.mts): <target>-offline, which a job without the
// servers runs, and <target>-service, which a job that prepares the databases runs. The runtime jobs of ci-pipeline.yml run
// the targets of targets.runtimes of config/ci.json, and the group jobs of ci.yml the targets of CI_TARGETS_<group> (T582-1).
caseTest('T582-1: a CI job runs the offline selection of the generated tests of each binding, and a job with the databases the service selection', () => {
  const makefile = text('Makefile');
  const config = parseJsonValue(text('config/ci.json'), 'config/ci.json');
  const declared = isRecord(config) && isRecord(config['targets']) && isRecord(config['targets']['runtimes']) ? config['targets']['runtimes'] : {};
  const runtimeJobs = Object.values(declared).flatMap(list => (Array.isArray(list) ? list.map(String) : []));
  const { groups, targets } = ciGroups(makefile);
  const groupJobs = groups.flatMap(group => targets[group] ?? []);
  const needs = declaredNeeds(repository.pathname);
  const defined = new Set(makeTargets(makefile).map(entry => entry.target));
  const dryRun = (target: string) => {
    const result = spawnSync('make', ['-n', '--no-print-directory', target], { cwd: repository.pathname, encoding: 'utf8', env: isolatedEnvironment() });
    assert.equal(result.status, 0, `make -n ${target}: ${result.stderr}`);
    return result.stdout;
  };
  for (const [runtime, name] of Object.entries({ go: 'test-go-bindings', node: 'test-binding-node', php: 'test-binding-php', python: 'test-binding-python' })) {
    const offline = `${name}-offline`;
    const service = `${name}-service`;
    for (const target of [name, offline, service]) assert.ok(defined.has(target), `the Makefile defines no target ${target}`);
    assert.ok([...runtimeJobs, ...groupJobs].includes(offline), `no CI job runs ${offline}: name it in targets.runtimes of config/ci.json or in a CI_TARGETS_<group> of the Makefile`);
    // The whole file fails without the servers, so no job runs it in place of the two selections.
    assert.ok(![...runtimeJobs, ...groupJobs].includes(name), `a CI job runs ${name}, every generated test of ${runtime}; it runs ${offline}, and a job with the databases ${service}`);
    const jobs = groups.filter(group => (targets[group] ?? []).includes(service));
    assert.ok(jobs.length > 0, `no CI group runs ${service}: name it in the CI_TARGETS_<group> of a group that prepares the databases`);
    assert.ok((needs[service] ?? []).includes('databases'), `${service} declares no need databases in contracts/check-inputs.json`);
    for (const group of jobs) assert.equal(groupOutputs(targets[group] ?? [], needs).databases, true, `the group ${group} of ${service} prepares no databases`);
    assert.ok(!(needs[offline] ?? []).includes('databases'), `${offline} declares the need databases, and it runs without the servers`);
    // Each selection is read from the generated file by its name, and only the service selection reads the servers of the run.
    const offlineRun = dryRun(offline);
    assert.match(offlineRun, new RegExp(`scripts/repo/binding-tests\\.mts ${runtime} offline\\b`), `${offline} does not select its tests through scripts/repo/binding-tests.mts`);
    assert.doesNotMatch(offlineRun, /ORM_TEST_SERVICE_STATE=/, `${offline} reads the test servers`);
    const serviceRun = dryRun(service);
    assert.match(serviceRun, new RegExp(`scripts/repo/binding-tests\\.mts ${runtime} service\\b`), `${service} does not select its tests through scripts/repo/binding-tests.mts`);
    assert.match(serviceRun, /ORM_TEST_SERVICE_STATE=/, `${service} gives its tests no state program of the services (WITH_TEST_ENV, SERVICE_STATE)`);
    assert.doesNotMatch(dryRun(name), /scripts\/repo\/binding-tests\.mts/, `${name} selects tests; it runs every generated test`);
  }
});

// A target whose recipe reads the test servers (WITH_TEST_ENV) runs in a CI group that prepares the databases, and declares
// the need databases in contracts/check-inputs.json. serverTargetErrors names what misses for one such target.
function serverTargetErrors(target: string): string[] {
  const makefile = text('Makefile');
  const { groups, targets } = ciGroups(makefile);
  const needs = declaredNeeds(repository.pathname);
  const errors: string[] = [];
  if (!makeTargets(makefile).some(entry => entry.target === target)) errors.push(`the Makefile defines no target ${target}`);
  const jobs = groups.filter(group => (targets[group] ?? []).includes(target));
  if (jobs.length === 0) errors.push(`no CI group runs ${target}: name it in the CI_TARGETS_<group> of a group that prepares the databases`);
  if (!checkTargets(makefile).includes(target)) errors.push(`CHECK_TARGETS does not name ${target}`);
  for (const need of ['rust', 'databases']) {
    if (!(needs[target] ?? []).includes(need)) errors.push(`${target} declares no need ${need} in contracts/check-inputs.json`);
  }
  for (const group of jobs) {
    if (groupOutputs(targets[group] ?? [], needs).databases !== true) errors.push(`the group ${group} of ${target} prepares no databases`);
  }
  return errors;
}
function makeDryRun(target: string): string {
  const result = spawnSync('make', ['-n', '--no-print-directory', target], { cwd: repository.pathname, encoding: 'utf8', env: isolatedEnvironment() });
  assert.equal(result.status, 0, `make -n ${target}: ${result.stderr}`);
  return result.stdout;
}

// interface-service-cases-rust runs the cases of contracts/interface/service.json in the core with the test servers. Its
// test is marked ignored, so no other run of the core runs it: a CI group that prepares the databases names the target (T596).
caseTest('T596: a CI group that prepares the databases runs the service cases of the core', () => {
  const target = 'interface-service-cases-rust';
  assert.deepEqual(serverTargetErrors(target), []);
  const run = makeDryRun(target);
  assert.match(run, /ORM_TEST_SERVICE_STATE=/, `${target} gives its test no state program of the services (WITH_TEST_ENV, SERVICE_STATE)`);
  assert.match(run, /-p polyspec-orm --lib interface_service_cases -- --ignored\b/, `${target} does not run the ignored test of the service cases`);
});

// The three tests of the build crate that failed in the offline make test-rust run where their inputs are (T570). The
// test of the discarded read-only connection is two tests: the SQLite one makes its own database file and runs in every
// run, and the one of MySQL and PostgreSQL is marked ignored and names the target that runs it with the test servers.
// The tests that read ORM_BUILD_TEST_ROOT name the targets that give it, and make test-rust is one of them.
caseTest('T570: the tests of the build crate that read a server or a variable of make name the target that gives it, and that target does', () => {
  const makefile = text('Makefile');
  const defined = new Set(makeTargets(makefile).map(entry => entry.target));
  const file = 'packages/rust/build/tests/unit/read_only_disposal.rs';
  const source = text(file);
  const tests = [...source.matchAll(/^((?:#\[[^\n]*\]\n|\/\/[^\n]*\n)*)async fn (\w+)\(\)/gm)].map(match => ({ attributes: match[1] ?? '', name: match[2] ?? '' })).filter(entry => entry.attributes.includes('#[tokio::test'));
  const ignored = tests.filter(entry => entry.attributes.includes('#[ignore'));
  const always = tests.filter(entry => !entry.attributes.includes('#[ignore'));
  assert.equal(always.length, 1, `${file} holds one test that every run runs, the SQLite one; found ${always.map(entry => entry.name).join(', ') || 'none'}`);
  assert.equal(ignored.length, 1, `${file} holds one ignored test, the one of the servers; found ${ignored.map(entry => entry.name).join(', ') || 'none'}`);
  const server = ignored[0];
  assert.ok(server !== undefined);
  // The test that every run runs reads no server: server_dsn is called by the ignored test alone.
  const body = (name: string) => {
    const start = source.indexOf(`async fn ${name}()`);
    const end = source.indexOf('\n}\n', start);
    return source.slice(start, end);
  };
  const [unit] = always;
  assert.ok(unit !== undefined);
  assert.doesNotMatch(body(unit.name), /server_dsn|ORM_TOOLS_/, `${unit.name} of ${file} reads the DSN of a server; it runs in make test-rust, which has none`);
  assert.match(body(server.name), /server_dsn\("ORM_TOOLS_MYSQL_DSN"\)|ORM_TOOLS_MYSQL_DSN/, `${server.name} of ${file} runs no MySQL`);
  assert.match(body(server.name), /ORM_TOOLS_POSTGRES_DSN/, `${server.name} of ${file} runs no PostgreSQL`);
  const named = /#\[ignore = "needs the database servers; make orm-test-servers ([a-z0-9-]+) runs it in one command"\]/.exec(server.attributes);
  assert.ok(named !== null, `the ignore of ${server.name} names no target: #[ignore = "needs the database servers; make orm-test-servers <target> runs it in one command"]`);
  const target = named[1] ?? '';
  assert.deepEqual(serverTargetErrors(target), []);
  const run = makeDryRun(target);
  assert.match(run, /ORM_TEST_SERVERS_LEASES/, `${target} reads no test servers (WITH_TEST_ENV)`);
  assert.ok(run.includes(`-p polyspec-orm-build --lib catalog::disposal_tests::${server.name} -- --ignored --exact`), `${target} does not run the ignored test ${server.name} alone: ${run}`);
  const inputs = readCheckInputs(repository.pathname).targets[target]?.inputs ?? [];
  assert.ok(inputs.includes(file), `${target} does not name ${file} in its inputs of contracts/check-inputs.json`);

  // make test-rust gives ORM_BUILD_TEST_ROOT as the owner targets of the two tests do, and each message names targets that give it.
  for (const [test, owner] of [['packages/rust/build/src/tests/build_environment.rs', 'rust-build-environment-check'], ['packages/rust/build/src/tests/out_dir.rs', 'rust-build-outdir-check']] as const) {
    const message = /var_os\("ORM_BUILD_TEST_ROOT"\)\s*\.expect\("([^"]*)"\)/.exec(text(test))?.[1] ?? '';
    const givers = [...message.matchAll(/\bmake ([a-z0-9-]+)/g)].map(match => match[1] ?? '');
    assert.deepEqual(givers, ['test-rust', owner], `the message of ${test} for a missing ORM_BUILD_TEST_ROOT names the targets that give it, make test-rust and make ${owner}; it is "${message}"`);
    for (const giver of givers) {
      assert.ok(defined.has(giver), `the Makefile defines no target ${giver}, which ${test} names`);
      assert.match(makeDryRun(giver), /ORM_BUILD_TEST_ROOT=\S*packages\/rust\/build /, `make ${giver} gives its tests no ORM_BUILD_TEST_ROOT, and ${test} names it`);
    }
  }
});

// binding check runs go mod download when packages/go/go.mod requires a release, so the asset jobs install Go before it (T584).
// A committed tree holds release forms only, so every run of a job, CI and release alike, runs release-binding-check, with
// no condition on the input release of the workflow, which is gone (binding CK-70, GN-19i, B2.457, T595).
caseTest('T584: the asset jobs install Go before the release check of binding, which every run runs', () => {
  const makefile = text('Makefile');
  for (const target of ['ci-assets-platform', 'ci-assets-npm']) {
    const lines = jobRecipeLines(makefile, target);
    const at = (pattern: RegExp) => lines.findIndex(line => pattern.test(line));
    const rust = at(/^@\$\(CI_JOB\) setup \$\(CI_NAME\) rust -- orm-install-rust$/);
    const go = at(/^@\$\(CI_JOB\) setup \$\(CI_NAME\) go -- install-tools TOOLS=go$/);
    const check = at(/^@\$\(CI_JOB\) setup \$\(CI_NAME\) binding-check -- release-binding-check$/);
    assert.ok(rust >= 0, `${target} has no setup rust`);
    assert.ok(go > rust, `${target} installs no Go after the setup rust: add the setup go -- install-tools TOOLS=go`);
    assert.ok(check > go, `${target} runs no release-binding-check after the setup go`);
    assert.equal(lines.filter(line => /\bRELEASE\b|bindings-check/.test(line)).length, 0, `${target} runs a check by the condition RELEASE or bindings-check`);
  }
  assert.doesNotMatch(makefile, /CI_NOT_RELEASE|\$\(RELEASE\)/, 'the Makefile reads no RELEASE');
  for (const workflow of ['.github/workflows/assets.yml', '.github/workflows/release.yml'])
    assert.doesNotMatch(text(workflow), /inputs\.release|^\s+release: (?:true|false)$|^\s+release:\n\s+description:/m, `${workflow} names the input release`);
});

// packages/release.mk, which binding release-recipes writes, reads CARGO, the cargo command of the repository, and each of
// its recipes stops with `needs CARGO` when the Makefile defines none before the include. CARGO is the cargo link, through
// which every cargo of a recipe starts (T531).
caseTest('the Makefile defines CARGO, the cargo link, before it includes packages/release.mk', () => {
  const lines = text('Makefile').split('\n');
  const include = lines.indexOf('-include packages/release.mk');
  assert.ok(include >= 0, 'the Makefile includes packages/release.mk with -include');
  const cargo = lines.indexOf('CARGO = $(CARGO_LINK)');
  assert.ok(cargo >= 0 && cargo < include, 'the Makefile defines no CARGO = $(CARGO_LINK) before -include packages/release.mk; every recipe of that file stops with `needs CARGO`');
  // A checkout that has written the file shows it: no recipe of the file tests an empty variable that it requires.
  if (existsSync(new URL('packages/release.mk', repository))) {
    for (const target of ['release-binding-check', 'release-go-static', 'release-wheel', 'release-npm-platform', 'release-npm', 'release-go-module']) {
      assert.doesNotMatch(makeDryRun(target), /^test -n "" \|\| \{ echo "[a-z-]+ needs /m, `make ${target} reads a variable of packages/release.mk that the Makefile does not define before the include`);
    }
  }
});

// The locks of the two Rust workspaces, Cargo.lock of the root and benchmarks/rust/Cargo.lock, are written by cargo update
// through the cargo link, online, and no recipe edits them by hand: cargo-lock-update updates both, the crates that
// CRATES names (each -p <crate>) or every crate without it, so a pin of a git tag in a Cargo.toml reaches both locks (T595).
caseTest('cargo-lock-update updates both Rust locks through the cargo link', () => {
  const makefile = text('Makefile');
  assert.match(makefile, /^\.PHONY: cargo-lock-update$/m, 'the Makefile declares no phony cargo-lock-update');
  assert.deepEqual(jobRecipeLines(makefile, 'cargo-lock-update'), [
    '$(ONLINE) $(CARGO_LINK) update $(addprefix -p ,$(CRATES))',
    'cd benchmarks/rust && $(ONLINE) $(CARGO_LINK) update $(addprefix -p ,$(CRATES))',
  ]);
});

// bindings-scaffold writes the binding packages that binding scaffold writes for the contract (binding L-2, CK-19) with the
// tool and the arguments with which bindings runs binding generate.
caseTest('bindings-scaffold runs binding scaffold as bindings runs binding generate', () => {
  const makefile = text('Makefile');
  assert.match(makefile, /^\.PHONY: bindings bindings-scaffold /m, 'the Makefile declares no phony bindings-scaffold beside bindings');
  assert.deepEqual(jobRecipeLines(makefile, 'bindings'), ['$(NODE) $(BINDING) generate --root $(CURDIR) --cargo "$(CARGO_LINK)"']);
  assert.deepEqual(jobRecipeLines(makefile, 'bindings-scaffold'), ['$(NODE) $(BINDING) scaffold --root $(CURDIR) --cargo "$(CARGO_LINK)"']);
});

// The release of TAG carries the Go module as binding writes its recipes since 0.0.21 (GN-19f): rehearse-go-module
// rehearses release-go-module on HEAD before release-go-module makes the tag of the Go module (B2.479), release-go-module
// only adds the reference of that tag to the release, and release-go-module-push pushes it after release-go-module and
// before the publish (B2.488). All three are recipes of packages/release.mk, so they run after release-recipes writes it.
caseTest('ci-release rehearses the Go module before its tag and pushes the tag after release-go-module', () => {
  const lines = jobRecipeLines(text('Makefile'), 'ci-release');
  const step = (target: string) => lines.findIndex(line => new RegExp(`^@\\$\\(CI_JOB\\) setup \\$\\(CI_NAME\\) [a-z-]+ -- ${target}(?: |$)`).test(line));
  const recipes = step('release-recipes');
  const rehearse = step('rehearse-go-module');
  const carry = step('release-go-module');
  const push = step('release-go-module-push');
  const publish = step('release-publish');
  assert.ok(recipes >= 0, 'ci-release does not write packages/release.mk with release-recipes');
  assert.ok(rehearse > recipes, 'ci-release does not run rehearse-go-module after release-recipes');
  assert.ok(carry > rehearse, 'ci-release does not run release-go-module after rehearse-go-module');
  assert.ok(push > carry, 'ci-release does not run release-go-module-push after release-go-module');
  assert.ok(publish > push, 'ci-release publishes before release-go-module-push pushes the tag of the Go module');
});

// packages/go is a module outside go.work, so go mod download of the workspace leaves its modules out, and binding check
// reads them offline (go mod download -json all under GOPROXY=off). orm-install-go-binding downloads them: orm-install-go
// runs it, and each asset job runs it after it installs Go and before its binding check.
caseTest('the modules of the Go binding are downloaded by orm-install-go and by the asset jobs before their binding check', () => {
  const makefile = text('Makefile');
  assert.doesNotMatch(text('go.work'), /^\s*\.\/packages\/go\s*$/m, 'go.work names packages/go, so go mod download of the workspace downloads its modules, and orm-install-go-binding is not needed');
  assert.deepEqual(jobRecipeLines(makefile, 'orm-install-go-binding'), ['$(MAKE) --no-print-directory install-tools TOOLS=go', 'cd packages/go && $(ONLINE) GOWORK=off $(GO) mod download']);
  assert.match(makefile, /^orm-install-go: orm-install-go-binding$/m, 'orm-install-go does not download the modules of packages/go: name orm-install-go-binding as its prerequisite');
  for (const target of ['ci-assets-platform', 'ci-assets-npm']) {
    const lines = jobRecipeLines(makefile, target);
    const go = lines.indexOf('@$(CI_JOB) setup $(CI_NAME) go -- install-tools TOOLS=go');
    const modules = lines.indexOf('@$(CI_JOB) setup $(CI_NAME) go-modules -- orm-install-go-binding');
    const check = lines.findIndex(line => /-- (?:release-binding-check|bindings-check)\b/.test(line));
    assert.ok(go >= 0 && modules > go, `${target} does not download the modules of packages/go after it installs Go: add the setup go-modules -- orm-install-go-binding`);
    assert.ok(check > modules, `${target} runs a binding check before the setup go-modules, which downloads what the check reads`);
  }
});

// The binding crates hold no Rust test: binding generate writes the tests of a binding in the language of its target
// (generated/tests), which the test-binding targets run, and binding scaffold writes `test = false` for the PHP extension
// crate (T624). So no target runs cargo test on them, which would select no test, and lint-bindings is the build of the five
// binding crates with their test features in CI. The PHP extension crate among them builds against the PHP of the checkout
// (BINDING_ENV); a runtime job has only the tools of what it runs, so the job that runs lint-bindings is one for which
// ci-pipeline.yml sets PHP up, and it installs the Rust toolchain.
caseTest('the runtime job that runs lint-bindings has PHP and Rust, and no target runs cargo test on the binding crates', () => {
  const config = parseJsonValue(text('config/ci.json'), 'config/ci.json');
  const section = (name: string, part: string): Record<string, unknown> => (isRecord(config) && isRecord(config[name]) && isRecord(config[name][part]) ? config[name][part] : {});
  const names = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
  const jobs = Object.entries(section('targets', 'runtimes')).filter(([, targets]) => names(targets).includes('lint-bindings')).map(([runtime]) => runtime);
  assert.equal(jobs.length, 1, `one runtime job of config/ci.json runs lint-bindings; found ${jobs.join(', ') || 'none'}`);
  // The step of the runtime jobs is the setup-php step whose condition reads the runtime of the matrix.
  const conditions = [...text('.github/workflows/ci-pipeline.yml').matchAll(/uses: shivammathur\/setup-php@[0-9a-f]+\n\s+if: \$\{\{ ([^}]*) \}\}/g)].map(match => match[1] ?? '');
  const withPhp = conditions.flatMap(condition => [...condition.matchAll(/matrix\.runtime == '([a-z-]+)'/g)].map(match => match[1] ?? ''));
  assert.ok(withPhp.length > 0, 'ci-pipeline.yml sets PHP up for the runtimes that its setup-php step names');
  const setup = section('setup', 'runtimes');
  for (const job of jobs) {
    assert.ok(withPhp.includes(job), `the runtime job ${job} runs lint-bindings, which builds the PHP extension crate, and ci-pipeline.yml sets PHP up for ${withPhp.join(', ')} alone`);
    assert.ok(names(setup[job]).includes('orm-install-rust'), `the runtime job ${job} runs lint-bindings and installs no Rust (orm-install-rust in setup.runtimes of config/ci.json)`);
  }
  const testedBindings = text('Makefile').split('\n').filter(line => /cargo test\b/.test(line) && line.includes('$(BINDING_CRATES)'));
  assert.deepEqual(testedBindings, [], 'a recipe runs cargo test on the binding crates, which hold no Rust test');
});

// The bindgen of ext-php-rs takes the libclang of the highest LLVM of the machine and the clang of PATH, which differ on a
// runner with several LLVM releases. Every build of the PHP extension crate of the binding takes both from the LLVM that
// config/toolchain.json pins, as make release-php-ext of packages/release.mk does, by the same two definitions.
caseTest('a build of the PHP extension crate of the binding takes the libclang and the clang of the pinned LLVM', () => {
  const makefile = text('Makefile');
  const definition = (source: string, name: string) => new RegExp(`^${name} \\?= (.*)$`, 'm').exec(source)?.[1];
  const major = definition(makefile, 'LLVM_MAJOR');
  const root = definition(makefile, 'LLVM_ROOT');
  assert.ok(major !== undefined && root !== undefined, 'the Makefile defines LLVM_MAJOR and LLVM_ROOT (?=) for BINDING_ENV');
  const environment = /^BINDING_ENV := (.*)$/m.exec(makefile)?.[1] ?? '';
  assert.match(environment, /(?:^| )LIBCLANG_PATH=\$\(LLVM_ROOT\)\/lib(?: |$)/, 'BINDING_ENV sets no LIBCLANG_PATH=$(LLVM_ROOT)/lib');
  assert.match(environment, /(?:^| )CLANG_PATH=\$\(LLVM_ROOT\)\/bin\/clang(?: |$)/, 'BINDING_ENV sets no CLANG_PATH=$(LLVM_ROOT)/bin/clang');
  const lines = makefile.split('\n');
  assert.ok(lines.findIndex(line => line.startsWith('LLVM_ROOT ?= ')) < lines.findIndex(line => line.startsWith('BINDING_ENV := ')), 'BINDING_ENV is assigned at once (:=), so LLVM_ROOT is defined above it');
  const toolchain = parseJsonValue(text('config/toolchain.json'), 'config/toolchain.json');
  const version = isRecord(toolchain) && isRecord(toolchain['llvm']) ? toolchain['llvm']['version'] : undefined;
  const pinned = typeof version === 'string' ? version : '';
  assert.match(pinned, /^[0-9]+$/, 'config/toolchain.json pins the major release of LLVM (llvm.version)');
  for (const target of ['test-binding-php-offline', 'test-binding-php-service', 'lint-bindings']) {
    const run = makeDryRun(target);
    assert.match(run, new RegExp(` LIBCLANG_PATH=\\S*llvm[@-]${pinned}/lib CLANG_PATH=\\S*llvm[@-]${pinned}/bin/clang `), `make ${target} builds the PHP extension crate without the libclang and the clang of LLVM ${pinned}`);
  }
  // The recipes of the release read the same LLVM: a checkout that has written packages/release.mk shows its definitions.
  if (existsSync(new URL('packages/release.mk', repository))) {
    const release = text('packages/release.mk');
    assert.equal(major, definition(release, 'LLVM_MAJOR'), 'LLVM_MAJOR of the Makefile is not the definition of packages/release.mk');
    assert.equal(root, definition(release, 'LLVM_ROOT'), 'LLVM_ROOT of the Makefile is not the definition of packages/release.mk');
    assert.match(release, /LIBCLANG_PATH=\$\(LLVM_ROOT\)\/lib CLANG_PATH=\$\(LLVM_ROOT\)\/bin\/clang /, 'make release-php-ext of packages/release.mk sets LIBCLANG_PATH and CLANG_PATH from LLVM_ROOT');
  }
});

// make test-rust and make test-python are offline: their help says so, and they run in the runtime jobs, which start no
// server. A test that reads a database server fails without it, so each recipe selects by name the tests that
// read none (scripts/repo/offline-tests.mts) and reads no environment of the servers; a selection of no test is an
// error. The tests that it leaves run in a target of a CI group that prepares the databases: the Rust ones in
// client-db-rust-check, which runs the workspace, and the Python ones in suite-python-check, which runs every test file
// (T570, T580).
caseTest('T570, T580: the offline test targets of Rust and Python select their tests by name, and a group with the databases runs the tests they leave', () => {
  const makefile = text('Makefile');
  const { groups, targets } = ciGroups(makefile);
  const needs = declaredNeeds(repository.pathname);
  for (const [runtime, target, servers] of [['rust', 'test-rust', 'client-db-rust-check'], ['python', 'test-python', 'suite-python-check']] as const) {
    assert.match(makefile, new RegExp(`^${target}: [^#\\n]*## [^\\n]*; offline$`, 'm'), `the help of ${target} calls it offline`);
    const run = makeDryRun(target);
    assert.match(run, new RegExp(`scripts/repo/offline-tests\\.mts ${runtime} \\S+\\n`), `${target} does not select its tests through scripts/repo/offline-tests.mts ${runtime}`);
    // The selection is the argument of the run of the tests, which follows it.
    const selected = /publish-output\.mts (\S+\/offline-tests) /.exec(run)?.[1] ?? '';
    assert.ok(selected !== '', `${target} writes its selection into no file (PUBLISH)`);
    const tests = run.split('\n').filter(line => line.includes(`$(cat ${selected})`));
    assert.equal(tests.length, 1, `one line of ${target} runs the tests of the selection ${selected}`);
    assert.doesNotMatch(run, /\$\{ORM_TEST_SERVERS_LEASES:\?|ORM_TEST_\w*DSN=/, `${target} reads the test servers, and it is offline`);
    // make exports the variables of the file TEST_ENV of a checkout whose servers run, and the run of the tests starts without them.
    const [line = ''] = tests;
    assert.match(line, /^(?:cd \S+ && )?env (?:-u [A-Z0-9_]+ )+/, `${target} starts its tests with the variables that make exports from TEST_ENV; start them through WITHOUT_SERVERS`);
    const environment = join(mkdtempSync(join(tmpdir(), 'orm-offline-env-')), 'env');
    try {
      writeFileSync(environment, "export ORM_TEST_MYSQL_DSN='mysql://u@127.0.0.1:1/d'\nexport ORM_TOOLS_POSTGRES_DSN='postgres://u@127.0.0.1:1/d'\n");
      const withServers = spawnSync('make', ['-n', '--no-print-directory', target, `TEST_ENV=${environment}`], { cwd: repository.pathname, encoding: 'utf8', env: isolatedEnvironment() });
      assert.equal(withServers.status, 0, `make -n ${target} TEST_ENV=${environment}: ${withServers.stderr}`);
      const started = withServers.stdout.split('\n').find(entry => entry.includes('/offline-tests)')) ?? '';
      for (const name of ['ORM_TEST_MYSQL_DSN', 'ORM_TOOLS_POSTGRES_DSN', 'DECIMAL_MYSQL_DSN']) {
        assert.ok(started.split(' ').includes(name) && started.includes(` -u ${name} `), `${target} starts its tests with ${name} of a checkout whose servers run: ${started.slice(0, 200)}`);
      }
    } finally {
      rmSync(join(environment, '..'), { recursive: true, force: true });
    }
    assert.doesNotMatch(run, / discover /, `${target} runs every test of its tree; it runs the tests of its selection`);
    assert.ok(!(needs[target] ?? []).includes('databases'), `${target} declares the need databases, and it runs without the servers`);
    // The tests that the selection leaves run where the servers are.
    assert.ok(makeTargets(makefile).some(entry => entry.target === servers), `the Makefile defines no target ${servers}`);
    assert.ok((needs[servers] ?? []).includes('databases'), `${servers} declares no need databases in contracts/check-inputs.json`);
    const jobs = groups.filter(group => (targets[group] ?? []).includes(servers));
    assert.ok(jobs.length > 0, `no CI group runs ${servers}, which runs the tests that ${target} leaves`);
    for (const group of jobs) {
      const outputs = groupOutputs(targets[group] ?? [], needs);
      assert.equal(outputs.databases, true, `the group ${group} of ${servers} prepares no databases`);
    }
    assert.match(makeDryRun(servers), /ORM_TEST_SERVERS_LEASES/, `${servers} reads no test servers (WITH_TEST_ENV)`);
  }
  // The listing of the Rust tests is what cargo prints for the workspace of the run, under the lease of its target directory.
  assert.match(makeDryRun('test-rust'), /lease run \S+ exclusive --wait -- node \S+publish-output\.mts (\S+)\/listing \S+ \S+cargo-link\.mts \. test --locked --workspace [^\n]* -- --list\n[^\n]*offline-tests\.mts rust \1\/listing\n/, 'test-rust lists no tests of its workspace for its selection');
  // A selection of no test fails the recipe before a test runs.
  const work = mkdtempSync(join(tmpdir(), 'orm-offline-tests-'));
  try {
    const listing = join(work, 'listing');
    writeFileSync(listing, '0 tests, 0 benchmarks\n');
    const empty = spawnSync(process.execPath, [fileURLToPath(new URL('scripts/repo/offline-tests.mts', repository)), 'rust', listing], { encoding: 'utf8', env: isolatedEnvironment() });
    assert.equal(empty.status, 1, `offline-tests.mts rust passes on a listing of no test: ${empty.stderr}`);
    assert.match(empty.stderr, /holds no test \(0 tests listed\)/);
    assert.equal(empty.stdout, '');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  // The unit test of the selection runs in repo-check.
  assert.ok(jobRecipeLines(makefile, 'repo-check/unit').some(line => line.includes(' scripts/repo/offline-tests.test.mts ')), 'repo-check/unit does not run scripts/repo/offline-tests.test.mts');
});

// A setup target of config/ci.json that runs a tool through its mise shim selects that tool in its own install-tools, and the CI
// job that runs it names the tool in its tools of config/ci.json (T614).
caseTest('T614: every setup target installs the tools it runs through their mise shims, and its CI job declares them', () => {
  const mise = '[tools]\ngo = "1"\n"github:PyO3/maturin" = "1"\npython = "3"\n[env]\nX = "y"\n';
  const makefile = [
    'GO := $(KIT_TOOLS)/mise/shims/go', 'MATURIN := $(KIT_TOOLS)/mise/shims/maturin', 'PYTHON3 := $(KIT_TOOLS)/mise/shims/python3', 'GOFMT := $(KIT_TOOLS)/mise/shims/gofmt',
    'a: b', '\t$(MAKE) --no-print-directory install-tools TOOLS="python go"', 'b:', '\t$(MATURIN) build', '\t$(PYTHON3) x.py',
    'c:', '\t$(MAKE) d', 'd:', '\t$(MAKE) install-tools TOOLS=go', '\t$(GO) mod download', 'e:', '\t$(GOFMT) -l .',
  ].join('\n') + '\n';
  assert.deepEqual(shimToolErrors(makefile, { setup: { shared: ['c'], runtimes: { python: ['a'], go: [] } }, tools: { shared: ['go'], python: ['python'] } }, mise), [
    'a runs maturin through $(MATURIN) in b and runs no make install-tools TOOLS="… maturin …"; select maturin in the install-tools of a',
    'the python job of config/ci.json runs a, which runs maturin through $(MATURIN), and tools.python does not name maturin',
  ]);
  assert.deepEqual(shimToolErrors(makefile, { setup: { runtimes: { go: ['e'] } }, tools: {} }, mise), ['e of the setup e runs gofmt through $(GOFMT), which no tool of mise.toml provides']);
  const json = parseJsonValue(text('config/ci.json'), 'config/ci.json');
  const strings = (value: unknown, where: string): string[] => {
    assert.ok(Array.isArray(value) && value.every(item => typeof item === 'string'), `config/ci.json ${where} is a list of strings`);
    return value;
  };
  const lists = (value: unknown, where: string): Record<string, string[]> => {
    assert.ok(isRecord(value), `config/ci.json ${where} is an object`);
    return Object.fromEntries(Object.entries(value).map(([key, list]) => [key, strings(list, `${where}.${key}`)]));
  };
  assert.ok(isRecord(json) && isRecord(json['setup']), 'config/ci.json has an object setup');
  const setup = json['setup'];
  const config = {
    setup: { shared: strings(setup['shared'] ?? [], 'setup.shared'), runtimes: lists(setup['runtimes'] ?? {}, 'setup.runtimes') },
    tools: lists(json['tools'] ?? {}, 'tools'),
  };
  assert.deepEqual(shimToolErrors(text('Makefile'), config, text('mise.toml')), []);
});

// Each CI job installs the tools that its setup and its targets run: tools.<runtime> names them, or a setup target of the job
// installs them with make install-tools (T631).
caseTest('T631: every CI job installs the tools of mise.toml that the recipes of its setup and its targets run', () => {
  const mise = '[tools]\nnode = "1"\ngo = "1"\nuv = "1"\n"github:PyO3/maturin" = "1"\n"github:wasm-bindgen/wasm-bindgen" = "1"\n';
  const makefile = [
    'GO := $(KIT_TOOLS)/mise/shims/go', 'BUILD = $(PUBLISH) out go build ./x',
    'a: b', 'b:', '\t$(BUILD)', 'c:', '\t$(MAKE) install-tools TOOLS="uv"', '\tuv sync', 'd:', '\t$(GO) vet ./...', '\tnode x.mjs',
    'e:', '\tmaturin build', 'f:', '\twasm-bindgen --version',
  ].join('\n') + '\n';
  assert.deepEqual(jobToolErrors(makefile, { setup: { runtimes: { rust: [], python: ['c'] } }, targets: { runtimes: { rust: ['a'], python: ['d', 'e', 'f'] } }, tools: { python: ['go', 'wasmBindgen'] } }, mise), [
    'the rust job of config/ci.json runs go in b, and neither tools.rust nor a make install-tools of its setup names go',
    'the python job of config/ci.json runs maturin in e, and neither tools.python nor a make install-tools of its setup names maturin',
  ]);
  const json = parseJsonValue(text('config/ci.json'), 'config/ci.json');
  assert.ok(isRecord(json), 'config/ci.json is an object');
  assert.deepEqual(jobToolErrors(text('Makefile'), json as Parameters<typeof jobToolErrors>[1], text('mise.toml')), []);
});

// CI runs the targets with GOPROXY=off, so a job that runs go in a folder downloads the Go modules of that folder in its setup
// (T631): run 44236602323 failed the rust job with `filippo.io/edwards25519@v1.2.0: module lookup disabled by GOPROXY=off`.
caseTest('T631: every CI job that runs go downloads the Go modules of the folder in its setup', () => {
  const makefile = [
    'GO := $(KIT_TOOLS)/mise/shims/go', 'BUILD = $(PUBLISH) out go build ./tests/lease',
    'a: b', 'b:', '\t$(BUILD)', 'c:', '\tcd mod && $(GO) mod download x', 'd:', '\tnode binding check x.json --go "$(GO)"',
    'e:', '\t$(MAKE) install-tools TOOLS=go',
  ].join('\n') + '\n';
  const work = 'go 1\n\nuse (\n\t./mod\n)\n';
  assert.deepEqual(goModuleErrors(makefile, { setup: { runtimes: { rust: ['e'], go: ['c'] } }, targets: { runtimes: { rust: ['a', 'd'], go: ['a', 'd'] } } }, work), [
    'the rust job of config/ci.json runs go in packages/go in d, and no setup of the job runs go mod download there',
    'the rust job of config/ci.json runs go in . in b, and no setup of the job runs go mod download there',
    'the go job of config/ci.json runs go in packages/go in d, and no setup of the job runs go mod download there',
  ]);
  const json = parseJsonValue(text('config/ci.json'), 'config/ci.json');
  assert.ok(isRecord(json), 'config/ci.json is an object');
  assert.deepEqual(goModuleErrors(text('Makefile'), json as Parameters<typeof goModuleErrors>[1], text('go.work')), []);
});

// CI builds offline with the crates that the setup of a job fetched, so a job that runs cargo fetches them in its setup
// (T669): run 44309325651 failed the rust job with `can't checkout from ...: you are in the offline mode (--offline)`.
caseTest('T669: every CI job that runs cargo fetches the crates in its setup', () => {
  const makefile = [
    'CARGO_LINK = $(NODE) $(abspath scripts/cargo-link.mts) .', 'a: b', 'b:', '\t$(CARGO_LINK) clippy --locked', 'c:', '\t$(CARGO_LINK) fetch --locked',
    'd:', '\t$(MAKE) install-tools TOOLS=rust', 'e:', '\tgo build ./x',
  ].join('\n') + '\n';
  assert.deepEqual(crateFetchErrors(makefile, { setup: { runtimes: { rust: ['d'], go: ['c'], php: ['d'] } }, targets: { runtimes: { rust: ['a'], go: ['a'], php: ['e'] } } }), [
    'the rust job of config/ci.json runs cargo in b, and no setup of the job runs cargo fetch',
  ]);
  const json = parseJsonValue(text('config/ci.json'), 'config/ci.json');
  assert.ok(isRecord(json), 'config/ci.json is an object');
  assert.deepEqual(crateFetchErrors(text('Makefile'), json as Parameters<typeof crateFetchErrors>[1]), []);
});

// T648: package-check takes the verbosity of its cargo from the make variable PACKAGE_CHECK_CARGO_FLAGS (default --quiet), so a run
// can show the Compiling lines of the crates it builds.
caseTest('package-check runs its cargo with the flags of PACKAGE_CHECK_CARGO_FLAGS', () => {
  const cargo = (variables: string[]) => {
    // The probe target is read from stdin after the Makefile, so it runs with the variables that the Makefile exports.
    const probe = 'package-check-flags-probe:\n\t@$(NODE) -e "import(\'./scripts/package-check.mts\').then(m => console.log(m.COMMANDS.find(c => c.includes(\' check --manifest-path \'))))"\n';
    const result = spawnSync('make', ['-s', '--no-print-directory', '-f', 'Makefile', '-f', '-', ...variables, 'package-check-flags-probe'], { cwd: repository.pathname, encoding: 'utf8', env: isolatedEnvironment(), input: probe });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
  };
  assert.match(cargo([]), / --quiet$/);
  assert.match(cargo(['PACKAGE_CHECK_CARGO_FLAGS=--verbose']), / --verbose$/);
  assert.match(cargo(['PACKAGE_CHECK_CARGO_FLAGS=']), /\/Cargo\.toml$/);
});

// The unicode test names ORM_PYTHON when it is unset and runs no python3 from PATH: HR-81 names the tools by their absolute path (T684).
caseTest('T684: the unicode test names ORM_PYTHON when it is unset and runs no python3 from PATH', () => {
  const source = text('tests/dbspec/unicode/main_test.go');
  assert.doesNotMatch(source, /"python3"/, 'tests/dbspec/unicode/main_test.go runs python3 from PATH when ORM_PYTHON is unset');
  assert.match(source, /t\.Fatal[^\n]*ORM_PYTHON/, 'tests/dbspec/unicode/main_test.go does not fail naming ORM_PYTHON when it is unset');
});
