import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Measurement records captured from the successful native children of performance_gate coverage. */
export const PERFORMANCE_RUNTIMES = ['go', 'php', 'php-extension', 'typescript', 'python', 'rust'] as const;
export const PERFORMANCE_DATABASES = ['mysql', 'postgres', 'sqlite'] as const;
export const PERFORMANCE_WORKLOADS = ['pk', 'list100'] as const;
const rustPerformanceTest = '/packages/rust/tests/tests/coverage_performance_gate.rs';

export type PerformanceRuntime = typeof PERFORMANCE_RUNTIMES[number];
export type PerformanceDatabase = typeof PERFORMANCE_DATABASES[number];
export type PerformanceWorkload = typeof PERFORMANCE_WORKLOADS[number];

/** The member of `values` that equals `value`; another value throws, naming what it is. */
function memberOf<T extends string>(values: readonly T[], value: string | undefined, what: string): T {
  const member = values.find(entry => entry === value);
  if (member === undefined) throw new Error(`${what} ${JSON.stringify(value)} is none of ${values.join(', ')}`);
  return member;
}

/** The performance runtime named `value`; another name throws. */
export function performanceRuntimeOf(value: string | undefined): PerformanceRuntime {
  return memberOf(PERFORMANCE_RUNTIMES, value, 'performance runtime');
}

/** The performance database named `value`; another name throws. */
export function performanceDatabaseOf(value: string | undefined): PerformanceDatabase {
  return memberOf(PERFORMANCE_DATABASES, value, 'performance database');
}

/** The attempt `value` of a performance measurement, 1 or 2; another number throws. */
export function performanceAttemptOf(value: number): 1 | 2 {
  if (value === 1 || value === 2) return value;
  throw new Error(`performance attempt ${value} is neither 1 nor 2`);
}

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

export type PerformanceReference = {
  runtime: PerformanceRuntime;
  database: PerformanceDatabase;
  workload: PerformanceWorkload;
  ratio: number;
  machine: string;
};

export type PerformanceReferenceDeclaration =
  | { schema: 1; kind: 'fixed-performance-references'; status: 'pending'; references: [] }
  | { schema: 1; kind: 'fixed-performance-references'; status: 'recorded'; evidence: { file: string; sha256: string; recordedAt: string }; references: PerformanceReference[] };

export type PerformanceReferenceReport =
  | { status: 'pending'; missing: string[] }
  | { status: 'recorded'; measurements: string[]; warnings: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

/** Validate the tracked reference declaration without converting raw observations into references. */
export function validatePerformanceReferenceDeclaration(value: unknown): PerformanceReferenceDeclaration {
  if (!isRecord(value) || value.schema !== 1 || value.kind !== 'fixed-performance-references')
    throw new Error('performance reference declaration has an invalid schema or kind');
  if (value.status === 'pending') {
    if (!exactKeys(value, ['schema', 'kind', 'status', 'references']) || !Array.isArray(value.references) || value.references.length !== 0)
      throw new Error('pending performance references must have exactly an empty references array');
    return { schema: 1, kind: 'fixed-performance-references', status: 'pending', references: [] };
  }
  if (value.status !== 'recorded' || !exactKeys(value, ['schema', 'kind', 'status', 'evidence', 'references']))
    throw new Error('performance reference declaration has unknown fields or status');
  const evidence = value.evidence;
  if (!isRecord(evidence) || !exactKeys(evidence, ['file', 'sha256', 'recordedAt']) ||
      typeof evidence.file !== 'string' || !/^var\/evidence\/performance_gate\/observations-[^/]+\.json$/.test(evidence.file) ||
      typeof evidence.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.sha256) ||
      typeof evidence.recordedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(evidence.recordedAt))
    throw new Error('recorded performance references require file, SHA-256, and UTC evidence provenance');
  if (!Array.isArray(value.references)) throw new Error('performance references must be an array');
  const expected = new Set<string>();
  const machines = new Map<PerformanceRuntime, string>();
  const validated: PerformanceReference[] = [];
  for (const runtime of PERFORMANCE_RUNTIMES) for (const database of PERFORMANCE_DATABASES)
    for (const workload of PERFORMANCE_WORKLOADS) expected.add(`${runtime}/${database}/${workload}`);
  for (const entry of value.references) {
    if (!isRecord(entry) || !exactKeys(entry, ['runtime', 'database', 'workload', 'ratio', 'machine']))
      throw new Error('performance reference entry has unknown fields or is not an object');
    const runtime = performanceRuntimeOf(typeof entry.runtime === 'string' ? entry.runtime : undefined);
    const database = performanceDatabaseOf(typeof entry.database === 'string' ? entry.database : undefined);
    const workload = memberOf(PERFORMANCE_WORKLOADS, typeof entry.workload === 'string' ? entry.workload : undefined, 'performance workload');
    const key = `${runtime}/${database}/${workload}`;
    if (!expected.delete(key)) throw new Error(`performance reference is missing or duplicated: ${key}`);
    if (typeof entry.ratio !== 'number' || !Number.isFinite(entry.ratio) || entry.ratio <= 0)
      throw new Error(`${key} reference ratio is not a positive finite number`);
    if (typeof entry.machine !== 'string' || !entry.machine.trim()) throw new Error(`${key} reference has no machine identity`);
    const machine = machines.get(runtime);
    if (machine !== undefined && machine !== entry.machine)
      throw new Error(`${key} machine identity differs within ${runtime} references`);
    machines.set(runtime, entry.machine);
    validated.push({ runtime, database, workload, ratio: entry.ratio, machine: entry.machine });
  }
  if (expected.size) throw new Error(`performance references are missing: ${[...expected].join(', ')}`);
  return {
    schema: 1, kind: 'fixed-performance-references', status: 'recorded',
    evidence: { file: evidence.file, sha256: evidence.sha256, recordedAt: evidence.recordedAt },
    references: validated,
  };
}

/** Read the canonical tracked declaration; raw runner evidence is never a fallback source. */
export async function readPerformanceReferenceDeclaration(root: string): Promise<PerformanceReferenceDeclaration> {
  const text = await readFile(join(root, 'contracts/performance-references.json'), 'utf8');
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch (error) { throw new Error(`contracts/performance-references.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  return validatePerformanceReferenceDeclaration(value);
}

/** Compare observations to fixed references as warnings; missing references remain explicit and non-failing. */
export function performanceReferenceReport(
  measurements: PerformanceMeasurement[], declaration: PerformanceReferenceDeclaration,
): PerformanceReferenceReport {
  if (declaration.status === 'pending') {
    const missing: string[] = [];
    for (const runtime of PERFORMANCE_RUNTIMES) for (const database of PERFORMANCE_DATABASES)
      for (const workload of PERFORMANCE_WORKLOADS) missing.push(`${runtime}/${database}/${workload}`);
    return { status: 'pending', missing };
  }
  const references = new Map(declaration.references.map(reference =>
    [`${reference.runtime}/${reference.database}/${reference.workload}`, reference]));
  const reported = measurements.map(measurement => {
    const key = `${measurement.runtime}/${measurement.database}/${measurement.workload}`;
    const reference = references.get(key);
    if (!reference) throw new Error(`performance reference is missing: ${key}`);
    return `PERF performance_gate ${key} attempt=${measurement.attempt}: ratio=${measurement.ratio.toFixed(2)} reference=${reference.ratio.toFixed(2)} cpu=${measurement.cpuMs}ms wall=${measurement.wallMs}ms machine=${measurement.machine} reference-machine=${reference.machine}`;
  });
  const warnings = measurements.flatMap(measurement => {
    const key = `${measurement.runtime}/${measurement.database}/${measurement.workload}`;
    const reference = references.get(key);
    if (!reference || measurement.ratio <= reference.ratio) return [];
    return [`WARNING performance_gate ${key}: ratio ${measurement.ratio.toFixed(2)} exceeds reference ${reference.ratio.toFixed(2)} (reference machine ${reference.machine}; measured on ${measurement.machine})`];
  });
  return { status: 'recorded', measurements: reported, warnings };
}

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
    runtime: performanceRuntimeOf(runtime),
    database: performanceDatabaseOf(database),
    workload: memberOf(PERFORMANCE_WORKLOADS, workload, 'performance workload'),
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
