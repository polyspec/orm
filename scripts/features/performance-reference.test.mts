import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import {
  PERFORMANCE_DATABASES, PERFORMANCE_RUNTIMES, PERFORMANCE_WORKLOADS,
  performanceDiagnosticArguments, performanceMeasurementRecord, performanceMeasurementsFromOutput, performanceReferenceReport,
  performanceReferenceDeclarationFromCheckRun, readPerformanceReferenceDeclaration, recordPerformanceReferencesFromCheckRun, validatePerformanceMeasurements,
  validatePerformanceReferenceDeclaration, writePerformanceMeasurementRecord,
  type PerformanceMeasurement,
} from './performance-reference.mts';
import type { CheckRecord } from '../check/record.mts';

function line(runtime: string, database: string, workload: string, ratio = '1.23', machine = 'Linux arm64 CPU model'): string {
  return `PERF hot_path_gate ${runtime} ${database} ${workload}: native p50=10.0µs client p50=12.3µs ratio=${ratio} samples=1000 cpu=14.0ms wall=25.0ms machine=${machine} reference=not-recorded`;
}

function matrix(): PerformanceMeasurement[] {
  const result: PerformanceMeasurement[] = [];
  for (const runtime of PERFORMANCE_RUNTIMES) for (const database of PERFORMANCE_DATABASES)
    for (const workload of PERFORMANCE_WORKLOADS) for (const attempt of [1, 2] as const)
      result.push({ runtime, database, workload, attempt, nativeP50Us: 10, clientP50Us: 12.3, ratio: 1.23,
        samples: 1000, cpuMs: 14, wallMs: 25, machine: 'Linux arm64 CPU model' });
  return result;
}

function referenceDeclaration() {
  return {
    schema: 1,
    kind: 'fixed-performance-references',
    status: 'recorded',
    evidence: {
      file: 'var/evidence/performance_gate/observations-approved.json',
      sha256: 'a'.repeat(64),
      recordedAt: '2026-10-27T00:00:00Z',
      checkRunId: 'orm_check_1_00000000',
      sourceCommit: 'b'.repeat(40),
    },
    references: PERFORMANCE_RUNTIMES.flatMap(runtime => PERFORMANCE_DATABASES.flatMap(database =>
      PERFORMANCE_WORKLOADS.map(workload => ({ runtime, database, workload, ratio: 1.25, machine: 'Linux arm64 CPU model' })))),
  };
}

caseTest('official child output yields an identified paired measurement for every runtime', COMPUTE, () => {
  for (const runtime of PERFORMANCE_RUNTIMES) {
    const output = runtime === 'go'
      ? `${JSON.stringify({ Action: 'output', Output: `${line(runtime, 'sqlite', 'pk')}\n`})}\n`
      : `${line(runtime, 'sqlite', 'pk')}\n`;
    const measurements = performanceMeasurementsFromOutput(runtime, 'sqlite', 1, output);
    assert.equal(measurements.length, 1, runtime);
    assert.deepEqual(measurements[0], {
      runtime, database: 'sqlite', workload: 'pk', attempt: 1, nativeP50Us: 10, clientP50Us: 12.3,
      ratio: 1.23, samples: 1000, cpuMs: 14, wallMs: 25, machine: 'Linux arm64 CPU model',
    });
  }
  assert.throws(() => performanceMeasurementsFromOutput('php', 'sqlite', 1, line('php', 'mysql', 'pk')), /identity php\/mysql differs from child php\/sqlite/);
});

caseTest('Rust libtest diagnostic prefixes retain the exact saved PK observation and case identity', COMPUTE, () => {
  const saved = 'PERF hot_path_gate rust mysql pk: native p50=217.1µs client p50=316.0µs ratio=1.46 samples=1000 cpu=451.4ms wall=532.3ms machine=macos aarch64 reference=not-recorded';
  assert.deepEqual(performanceMeasurementsFromOutput('rust', 'mysql', 1,
    `test coverage_hot_path_gate_mysql ... ${saved}\n`, 'coverage_hot_path_gate_mysql'), [{
    runtime: 'rust', database: 'mysql', workload: 'pk', attempt: 1, nativeP50Us: 217.1,
    clientP50Us: 316, ratio: 1.46, samples: 1000, cpuMs: 451.4, wallMs: 532.3, machine: 'macos aarch64',
  }]);
  assert.deepEqual(performanceMeasurementsFromOutput('rust', 'mysql', 1,
    `test coverage_hot_path_gate_postgres ... ${saved}\n`, 'coverage_hot_path_gate_mysql'), []);
  assert.throws(() => performanceMeasurementsFromOutput('rust', 'postgres', 1,
    `test coverage_hot_path_gate_mysql ... ${saved}\n`, 'coverage_hot_path_gate_mysql'), /identity rust\/mysql differs from child rust\/postgres/);
});

caseTest('only the Rust performance owner disables libtest output capture', COMPUTE, () => {
  assert.deepEqual(performanceDiagnosticArguments('/checkout/packages/rust/tests/tests/coverage_performance_gate.rs'), ['--nocapture']);
  assert.deepEqual(performanceDiagnosticArguments('/checkout/packages/rust/tests/tests/coverage_model_writes.rs'), []);
});

caseTest('reference recording requires the exact 72 observations and never promotes a threshold', COMPUTE, () => {
  const measurements = matrix();
  const record = performanceMeasurementRecord(measurements);
  assert.equal(record.schema, 1);
  assert.equal(record.kind, 'raw-runner-observations');
  assert.equal(record.referencePolicy, 'not-promoted');
  assert.equal(record.measurements.length, 6 * 3 * 2 * 2);

  const missing = measurements.slice(1);
  assert.throws(() => validatePerformanceMeasurements(missing), /performance measurements are missing:/);
  const first = measurements[0];
  assert.ok(first, 'the measurements hold a first entry');
  assert.throws(() => validatePerformanceMeasurements([...measurements, first]), /missing or duplicated:/);
  assert.throws(() => validatePerformanceMeasurements(measurements.map((entry, index) => index === 0 ? { ...entry, samples: 999 } : entry),), /has 999 samples; expected 1000 paired samples/);
  assert.throws(() => validatePerformanceMeasurements(measurements.map((entry, index) => index === 0 ? { ...entry, cpuMs: Number.NaN } : entry)), /cpuMs is not a positive finite measurement/);
  assert.throws(() => validatePerformanceMeasurements(measurements.map((entry, index) => index === 0 ? { ...entry, wallMs: 0 } : entry)), /wallMs is not a positive finite measurement/);
  assert.throws(() => validatePerformanceMeasurements(measurements.map((entry, index) => index === 0 ? { ...entry, machine: 'another runner' } : entry)), /machine identity differs within go observations/);
});

caseTest('fixed references require provenance and the exact 36 runtime database workload keys', COMPUTE, () => {
  const declaration = referenceDeclaration();
  assert.equal(validatePerformanceReferenceDeclaration(declaration).status, 'recorded');
  assert.equal(declaration.references.length, 6 * 3 * 2);
  assert.throws(() => validatePerformanceReferenceDeclaration({ ...declaration, references: declaration.references.slice(1) }), /performance references are missing:/);
  const first = declaration.references[0];
  assert.ok(first, 'the fixed references contain a first entry');
  assert.throws(() => validatePerformanceReferenceDeclaration({ ...declaration, references: [...declaration.references, first] }), /missing or duplicated:/);
  assert.throws(() => validatePerformanceReferenceDeclaration({ ...declaration, references: declaration.references.map((entry, index) => index === 0 ? { ...entry, ratio: 0 } : entry) }), /reference ratio is not a positive finite number/);
  assert.throws(() => validatePerformanceReferenceDeclaration({ ...declaration, references: declaration.references.map((entry, index) => index === 0 ? { ...entry, ratio: Number.NaN } : entry) }), /reference ratio is not a positive finite number/);
  assert.throws(() => validatePerformanceReferenceDeclaration({ ...declaration, references: declaration.references.map((entry, index) => index === 0 ? { ...entry, ratio: Number.POSITIVE_INFINITY } : entry) }), /reference ratio is not a positive finite number/);
  assert.throws(() => validatePerformanceReferenceDeclaration({ ...declaration, references: declaration.references.map((entry, index) => index === 0 ? { ...entry, runtime: 'unknown' } : entry) }), /performance runtime "unknown" is none of/);
  assert.throws(() => validatePerformanceReferenceDeclaration({ ...declaration, references: declaration.references.map((entry, index) => index === 0 ? { ...entry, extra: 1 } : entry) }), /unknown fields or is not an object/);
  assert.throws(() => validatePerformanceReferenceDeclaration({ ...declaration, evidence: { ...declaration.evidence, sha256: 'not-a-hash' } }), /require check run, source commit, file, SHA-256, and UTC evidence provenance/);
  assert.throws(() => validatePerformanceReferenceDeclaration({ ...declaration, evidence: { ...declaration.evidence, file: '/tmp/observations.json' } }), /require check run, source commit, file, SHA-256, and UTC evidence provenance/);
  assert.throws(() => validatePerformanceReferenceDeclaration({ ...declaration, evidence: { ...declaration.evidence, checkRunId: undefined } }), /require check run, source commit, file, SHA-256, and UTC evidence provenance/);
  assert.throws(() => validatePerformanceReferenceDeclaration({ ...declaration, evidence: { ...declaration.evidence, checkRunId: '../run' } }), /require check run, source commit, file, SHA-256, and UTC evidence provenance/);
  assert.throws(() => validatePerformanceReferenceDeclaration({ ...declaration, evidence: { ...declaration.evidence, sourceCommit: 'not-a-commit' } }), /require check run, source commit, file, SHA-256, and UTC evidence provenance/);
  assert.throws(() => validatePerformanceReferenceDeclaration({ ...declaration, references: declaration.references.map((entry, index) => index === 1 ? { ...entry, machine: 'another machine' } : entry) }), /machine identity differs within go references/);
  assert.throws(() => validatePerformanceReferenceDeclaration({ ...declaration, unexpected: true }), /unknown fields or status/);
});

caseTest('performance references warn above the bound without changing correctness results', COMPUTE, () => {
  const declaration = validatePerformanceReferenceDeclaration(referenceDeclaration());
  const measurements = matrix();
  const report = performanceReferenceReport(measurements, declaration);
  assert.equal(report.status, 'recorded');
  if (report.status !== 'recorded') throw new Error('recorded references produce a recorded report');
  assert.equal(report.measurements.length, 72);
  assert.match(report.measurements[0] ?? '', /ratio=.* reference=1\.25 cpu=.* wall=.* machine=.* reference-machine=/);
  assert.equal(report.warnings.length, 0);
  const over = measurements.map((measurement, index) => index === 0 ? { ...measurement, ratio: 1.26 } : measurement);
  const warned = performanceReferenceReport(over, declaration);
  assert.equal(warned.status, 'recorded');
  if (warned.status !== 'recorded') throw new Error('a slow measurement remains a recorded report');
  assert.deepEqual(warned.warnings, [
    'WARNING performance_gate go/mysql/pk: ratio 1.26 exceeds reference 1.25 (reference machine Linux arm64 CPU model; measured on Linux arm64 CPU model)',
  ]);
});

caseTest('pending references remain explicit and never use raw observations as thresholds', COMPUTE, () => {
  const pending = validatePerformanceReferenceDeclaration({
    schema: 1, kind: 'fixed-performance-references', status: 'pending', references: [],
  });
  const report = performanceReferenceReport(matrix(), pending);
  assert.equal(report.status, 'pending');
  if (report.status !== 'pending') throw new Error('missing fixed references remain pending');
  assert.equal(report.missing.length, 6 * 3 * 2);
  assert.throws(() => validatePerformanceReferenceDeclaration({
    schema: 1, kind: 'fixed-performance-references', status: 'pending', references: referenceDeclaration().references,
  }), /pending performance references must have exactly an empty references array/);
});

caseTest('the tracked performance reference declaration satisfies its declared status and matrix shape', COMPUTE, async () => {
  const declaration = await readPerformanceReferenceDeclaration(new URL('../..', import.meta.url).pathname);
  assert.equal(declaration.schema, 1);
  assert.equal(declaration.kind, 'fixed-performance-references');
  if (declaration.status === 'pending') assert.deepEqual(declaration.references, []);
  else assert.equal(declaration.references.length, 6 * 3 * 2);
});

caseTest('raw observations publish atomically under ignored evidence without promoting references', COMPUTE, async () => {
  const root = await mkdtemp(join(tmpdir(), 'performance-reference-'));
  try {
    const path = await writePerformanceMeasurementRecord(root, matrix());
    const text = await readFile(path, 'utf8');
    const entries = await readdir(join(root, 'var/evidence/performance_gate'));
    assert.match(path, /var\/evidence\/performance_gate\/observations-.*\.json$/);
    assert.match(text, /"kind": "raw-runner-observations"/);
    assert.match(text, /"referencePolicy": "not-promoted"/);
    assert.equal((text.match(/"samples": 1000/g) ?? []).length, 72);
    assert.equal(entries.length, 1);
    assert.match(entries[0] ?? '', /\.json$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function gitIn(root: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function checkRunRecord(id: string, commit: string, tree: string, log: string): CheckRecord {
  return {
    id, tree, commit, clean: true, started: '2026-01-01T00:00:00.000Z', ended: '2026-01-01T00:05:00.000Z', result: 'passed',
    failed: [], incomplete: [], setup: [],
    targets: [{ name: 'feature-performance-check', status: 'passed', started: '2026-01-01T00:00:00.000Z', ended: '2026-01-01T00:05:00.000Z', log }],
  };
}

caseTest('the check run recorder promotes attempt one of a passed run on a clean checkout of HEAD', COMPUTE, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'performance-reference-run-')));
  const id = 'orm_check_17_0a1b2c3d';
  const name = 'observations-2026-01-01T000200000Z-17.json';
  const evidence = join(root, 'var/evidence/performance_gate');
  const log = `.runtime/check/${id}/targets/feature-performance-check.log`;
  const observation = performanceMeasurementRecord(matrix().map(entry => ({ ...entry, ratio: entry.attempt === 1 ? 1.17 : 9.99 })));
  try {
    await mkdir(join(root, 'contracts'), { recursive: true });
    await writeFile(join(root, 'contracts/performance-references.json'), `${JSON.stringify({
      schema: 1, kind: 'fixed-performance-references', status: 'pending', references: [],
    }, null, 2)}\n`);
    gitIn(root, 'init', '--quiet');
    gitIn(root, 'add', '-A');
    gitIn(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'fixture');
    const head = gitIn(root, 'rev-parse', 'HEAD');
    const tree = gitIn(root, 'rev-parse', 'HEAD^{tree}');
    await mkdir(evidence, { recursive: true });
    await mkdir(join(root, `.runtime/check/${id}/targets`), { recursive: true });
    await writeFile(join(evidence, name), `${JSON.stringify(observation, null, 2)}\n`);
    await writeFile(join(root, log), `performance_gate raw observations: ${join(evidence, name)}\n`);
    await writeFile(join(root, `.runtime/check/${id}/record.json`), `${JSON.stringify(checkRunRecord(id, head, tree, log))}\n`);

    await writeFile(join(root, 'contracts/performance-references.json'), '{"dirty": true}\n');
    await assert.rejects(recordPerformanceReferencesFromCheckRun(root, id, '2026-01-01T01:00:00Z'), /only from a clean checkout/);
    gitIn(root, 'checkout', '--', 'contracts/performance-references.json');
    await assert.rejects(recordPerformanceReferencesFromCheckRun(root, '../x', '2026-01-01T01:00:00Z'), /is not a .runtime\/check directory name/);

    const declaration = await recordPerformanceReferencesFromCheckRun(root, id, '2026-01-01T01:00:00Z');
    assert.equal(declaration.status, 'recorded');
    if (declaration.status !== 'recorded') throw new Error('a passed clean check run creates fixed references');
    assert.equal(declaration.references.length, 36);
    assert.ok(declaration.references.every(reference => reference.ratio === 1.17));
    assert.deepEqual(declaration.evidence, {
      file: `var/evidence/performance_gate/${name}`, sha256: declaration.evidence.sha256, recordedAt: '2026-01-01T01:00:00Z',
      checkRunId: id, sourceCommit: head,
    });
    assert.match(declaration.evidence.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(await readPerformanceReferenceDeclaration(root), declaration);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

caseTest('the check run recorder rejects a failed, dirty or other-commit run and cannot raise a fixed reference', COMPUTE, () => {
  const base = performanceMeasurementRecord(matrix());
  const prior = validatePerformanceReferenceDeclaration(referenceDeclaration());
  if (prior.status !== 'recorded') throw new Error('the prior-reference fixture is recorded');
  const pending = validatePerformanceReferenceDeclaration({ schema: 1, kind: 'fixed-performance-references', status: 'pending', references: [] });
  const head = { commit: 'd'.repeat(40), tree: 'e'.repeat(40) };
  const record = checkRunRecord('orm_check_1_00000000', head.commit, head.tree, '.runtime/check/orm_check_1_00000000/targets/feature-performance-check.log');
  const file = 'var/evidence/performance_gate/observations-2026-01-01T000200000Z-17.json';
  const log = `performance_gate raw observations: /checkout/${file}\n`;
  const declare = (checkRecord: CheckRecord, previous = pending, targetLog = log) =>
    performanceReferenceDeclarationFromCheckRun(base, checkRecord, targetLog, head, file, 'a'.repeat(64), '2026-01-01T01:00:00Z', previous);
  assert.equal(declare(record).status, 'recorded');
  assert.throws(() => declare(record, { ...prior, references: prior.references.map(reference => ({ ...reference, ratio: 1.0 })) }),
    /cannot raise its existing performance reference/);
  assert.throws(() => declare({ ...record, result: 'failed' }), /did not pass on a clean checkout of HEAD/);
  assert.throws(() => declare({ ...record, clean: false }), /did not pass on a clean checkout of HEAD/);
  assert.throws(() => declare({ ...record, commit: 'f'.repeat(40) }), /did not pass on a clean checkout of HEAD/);
  assert.throws(() => declare({ ...record, tree: 'f'.repeat(40) }), /did not pass on a clean checkout of HEAD/);
  assert.throws(() => declare({ ...record, targets: record.targets.map(target => ({ ...target, status: 'failed' })) }),
    /feature-performance-check target.*did not pass/);
  assert.throws(() => declare(record, pending, `${log}${log}`), /did not report this exact performance observation file/);
  assert.throws(() => declare({ ...record, targets: record.targets.map(target => ({ ...target, started: '2026-01-01T00:03:00.000Z' })) }),
    /were not created during the passed feature-performance-check target/);
});
