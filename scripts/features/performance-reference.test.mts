import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import {
  PERFORMANCE_DATABASES, PERFORMANCE_RUNTIMES, PERFORMANCE_WORKLOADS,
  performanceDiagnosticArguments, performanceMeasurementRecord, performanceMeasurementsFromOutput, performanceReferenceReport,
  readPerformanceReferenceDeclaration, validatePerformanceMeasurements, validatePerformanceReferenceDeclaration,
  writePerformanceMeasurementRecord,
  type PerformanceMeasurement,
} from './performance-reference.mts';

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
  assert.throws(() => validatePerformanceReferenceDeclaration({ ...declaration, evidence: { ...declaration.evidence, sha256: 'not-a-hash' } }), /require file, SHA-256, and UTC evidence provenance/);
  assert.throws(() => validatePerformanceReferenceDeclaration({ ...declaration, evidence: { ...declaration.evidence, file: '/tmp/observations.json' } }), /require file, SHA-256, and UTC evidence provenance/);
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
