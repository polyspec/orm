import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Measurement records captured from the successful native children of performance_gate coverage. */
export const PERFORMANCE_RUNTIMES = ['go', 'php', 'php-extension', 'typescript', 'python', 'rust'] as const;
export const PERFORMANCE_DATABASES = ['mysql', 'postgres', 'sqlite'] as const;
export const PERFORMANCE_WORKLOADS = ['pk', 'list100'] as const;
const rustPerformanceTest = '/packages/rust/tests/tests/coverage_performance_gate.rs';

export type PerformanceRuntime = typeof PERFORMANCE_RUNTIMES[number];
export type PerformanceDatabase = typeof PERFORMANCE_DATABASES[number];
export type PerformanceWorkload = typeof PERFORMANCE_WORKLOADS[number];

export type PerformanceMeasurement = {
  runtime: PerformanceRuntime;
  database: PerformanceDatabase;
  workload: PerformanceWorkload;
  attempt: 1 | 2;
  nativeP50Us: number;
  clientP50Us: number;
  ratio: number;
  samples: number;
  cpuMs: number;
  wallMs: number;
  machine: string;
};

const linePattern = /^PERF hot_path_gate (go|php|php-extension|typescript|python|rust) (mysql|postgres|sqlite) (pk|list100): native p50=(\d+\.\d)µs client p50=(\d+\.\d)µs ratio=(\d+\.\d{2}) samples=(\d+) cpu=(\d+\.\d)ms wall=(\d+\.\d)ms machine=(.+) reference=not-recorded$/;

/** Rust's test harness captures successful eprintln diagnostics unless this exact owner requests --nocapture. */
export function performanceDiagnosticArguments(testPath: string): string[] {
  return testPath.endsWith(rustPerformanceTest) ? ['--nocapture'] : [];
}

function parseMeasurement(line: string, attempt: 1 | 2): PerformanceMeasurement | null {
  const match = linePattern.exec(line);
  if (!match) return null;
  const [, runtime, database, workload, nativeP50Us, clientP50Us, ratio, samples, cpuMs, wallMs, machine] = match;
  return {
    runtime: runtime as PerformanceRuntime,
    database: database as PerformanceDatabase,
    workload: workload as PerformanceWorkload,
    attempt,
    nativeP50Us: Number(nativeP50Us),
    clientP50Us: Number(clientP50Us),
    ratio: Number(ratio),
    samples: Number(samples),
    cpuMs: Number(cpuMs),
    wallMs: Number(wallMs),
    machine: machine ?? '',
  };
}

/** Extract actual diagnostic lines from a completed official native child result. */
export function performanceMeasurementsFromOutput(
  runtime: PerformanceRuntime,
  database: PerformanceDatabase | undefined,
  attempt: 1 | 2,
  output: string,
): PerformanceMeasurement[] {
  const measurements: PerformanceMeasurement[] = [];
  const visit = (text: string): void => {
    for (const line of text.split(/\r?\n/)) {
      const direct = parseMeasurement(line, attempt);
      if (direct) {
        if (direct.runtime !== runtime || (database !== undefined && direct.database !== database))
          throw new Error(`performance measurement identity ${direct.runtime}/${direct.database} differs from child ${runtime}/${database ?? 'all databases'}`);
        measurements.push(direct);
        continue;
      }
      // Go's test2json wraps stderr diagnostics in output events on stdout.
      if (runtime === 'go' && line.startsWith('{')) {
        let event: unknown;
        try { event = JSON.parse(line) as unknown; }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; continue; }
        if (typeof event === 'object' && event !== null && 'Action' in event &&
            event.Action === 'output' && 'Output' in event && typeof event.Output === 'string') visit(event.Output);
      }
    }
  };
  visit(output);
  return measurements;
}

/** Require the complete two-attempt native matrix before persisting a runner measurement record. */
export function validatePerformanceMeasurements(measurements: PerformanceMeasurement[]): void {
  const expected = new Set<string>();
  for (const runtime of PERFORMANCE_RUNTIMES) for (const database of PERFORMANCE_DATABASES)
    for (const workload of PERFORMANCE_WORKLOADS) for (const attempt of [1, 2])
      expected.add(`${runtime}/${database}/${workload}/${attempt}`);
  const machines = new Map<PerformanceRuntime, string>();
  for (const measurement of measurements) {
    const key = `${measurement.runtime}/${measurement.database}/${measurement.workload}/${measurement.attempt}`;
    if (!expected.delete(key)) throw new Error(`performance measurement is missing or duplicated: ${key}`);
    if (measurement.samples !== 1000) throw new Error(`${key} has ${measurement.samples} samples; expected 1000 paired samples`);
    for (const [name, value] of Object.entries({ nativeP50Us: measurement.nativeP50Us, clientP50Us: measurement.clientP50Us,
      ratio: measurement.ratio, cpuMs: measurement.cpuMs, wallMs: measurement.wallMs })) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} ${name} is not a positive finite measurement`);
    }
    if (!measurement.machine.trim()) throw new Error(`${key} has no machine identity`);
    const machine = machines.get(measurement.runtime);
    if (machine !== undefined && measurement.machine !== machine)
      throw new Error(`${key} machine identity differs within ${measurement.runtime} observations`);
    machines.set(measurement.runtime, measurement.machine);
  }
  if (expected.size) throw new Error(`performance measurements are missing: ${[...expected].join(', ')}`);
}

/** Raw runner observations are not fixed references and never change a performance threshold. */
export function performanceMeasurementRecord(measurements: PerformanceMeasurement[]): {
  schema: 1;
  kind: 'raw-runner-observations';
  referencePolicy: 'not-promoted';
  measurements: PerformanceMeasurement[];
} {
  validatePerformanceMeasurements(measurements);
  return { schema: 1, kind: 'raw-runner-observations', referencePolicy: 'not-promoted', measurements };
}

/** Atomically retain the official child's raw measurements under the checkout's ignored evidence directory. */
export async function writePerformanceMeasurementRecord(root: string, measurements: PerformanceMeasurement[]): Promise<string> {
  const directory = join(root, 'var/evidence/performance_gate');
  await mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const path = join(directory, `observations-${stamp}-${process.pid}.json`);
  const temporary = `${path}.next`;
  const text = `${JSON.stringify(performanceMeasurementRecord(measurements), null, 2)}\n`;
  try {
    await writeFile(temporary, text, { flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return path;
}
