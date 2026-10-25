import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import {
  PERFORMANCE_DATABASES, PERFORMANCE_RUNTIMES, PERFORMANCE_WORKLOADS,
  performanceDiagnosticArguments, performanceMeasurementRecord, performanceMeasurementsFromOutput, validatePerformanceMeasurements,
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
  assert.throws(() => validatePerformanceMeasurements([...measurements, measurements[0]!]), /missing or duplicated:/);
  assert.throws(() => validatePerformanceMeasurements(measurements.map((entry, index) => index === 0 ? { ...entry, samples: 999 } : entry),), /has 999 samples; expected 1000 paired samples/);
  assert.throws(() => validatePerformanceMeasurements(measurements.map((entry, index) => index === 0 ? { ...entry, cpuMs: Number.NaN } : entry)), /cpuMs is not a positive finite measurement/);
  assert.throws(() => validatePerformanceMeasurements(measurements.map((entry, index) => index === 0 ? { ...entry, wallMs: 0 } : entry)), /wallMs is not a positive finite measurement/);
  assert.throws(() => validatePerformanceMeasurements(measurements.map((entry, index) => index === 0 ? { ...entry, machine: 'another runner' } : entry)), /machine identity differs within go observations/);
});
