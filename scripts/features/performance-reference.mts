import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
  | { schema: 1; kind: 'fixed-performance-references'; status: 'recorded'; evidence: { file: string; sha256: string; recordedAt: string; ciRunId: string; ciRunAttempt: number; sourceCommit: string }; references: PerformanceReference[] };

export type PerformanceReferenceReport =
  | { status: 'pending'; missing: string[] }
  | { status: 'recorded'; measurements: string[]; warnings: string[] };

type PerformanceCheckRecord = {
  id: string;
  commit: string;
  result: string;
  targets: { name: string; status: string; started: string | null; ended: string | null; log?: string }[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function parsePerformanceMeasurementRecord(value: unknown): PerformanceMeasurement[] {
  if (!isRecord(value) || !exactKeys(value, ['schema', 'kind', 'referencePolicy', 'measurements']) ||
      value.schema !== 1 || value.kind !== 'raw-runner-observations' || value.referencePolicy !== 'not-promoted' ||
      !Array.isArray(value.measurements))
    throw new Error('performance artifact is not a raw-runner-observations record');
  const measurements = value.measurements.map((entry): PerformanceMeasurement => {
    if (!isRecord(entry) || !exactKeys(entry, ['runtime', 'database', 'workload', 'attempt', 'nativeP50Us', 'clientP50Us', 'ratio', 'samples', 'cpuMs', 'wallMs', 'machine']))
      throw new Error('performance artifact has a malformed measurement');
    const runtime = performanceRuntimeOf(typeof entry.runtime === 'string' ? entry.runtime : undefined);
    const database = performanceDatabaseOf(typeof entry.database === 'string' ? entry.database : undefined);
    const workload = memberOf(PERFORMANCE_WORKLOADS, typeof entry.workload === 'string' ? entry.workload : undefined, 'performance workload');
    const attempt = performanceAttemptOf(typeof entry.attempt === 'number' ? entry.attempt : Number.NaN);
    const positiveNumber = (name: 'nativeP50Us' | 'clientP50Us' | 'ratio' | 'cpuMs' | 'wallMs'): number => {
      const number = entry[name];
      if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0)
        throw new Error(`performance artifact ${runtime}/${database}/${workload}/${attempt} has invalid ${name}`);
      return number;
    };
    const samples = entry.samples;
    const machine = entry.machine;
    if (typeof samples !== 'number' || !Number.isInteger(samples) || typeof machine !== 'string')
      throw new Error(`performance artifact ${runtime}/${database}/${workload}/${attempt} has invalid samples or machine`);
    return {
      runtime, database, workload, attempt,
      nativeP50Us: positiveNumber('nativeP50Us'), clientP50Us: positiveNumber('clientP50Us'), ratio: positiveNumber('ratio'),
      samples, cpuMs: positiveNumber('cpuMs'), wallMs: positiveNumber('wallMs'), machine,
    };
  });
  validatePerformanceMeasurements(measurements);
  return measurements;
}

function performanceCheckRecord(value: unknown): PerformanceCheckRecord {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.commit !== 'string' ||
      typeof value.result !== 'string' || !Array.isArray(value.targets))
    throw new Error('performance artifact has no valid check record');
  const targets: PerformanceCheckRecord['targets'] = value.targets.map((target) => {
    if (!isRecord(target) || typeof target.name !== 'string' || typeof target.status !== 'string' ||
        (target.started !== null && typeof target.started !== 'string') ||
        (target.ended !== null && typeof target.ended !== 'string') ||
        (target.log !== undefined && typeof target.log !== 'string'))
      throw new Error('performance artifact has a malformed target record');
    return {
      name: target.name, status: target.status,
      started: typeof target.started === 'string' ? target.started : null,
      ended: typeof target.ended === 'string' ? target.ended : null,
      ...(typeof target.log === 'string' ? { log: target.log } : {}),
    };
  });
  return { id: value.id, commit: value.commit, result: value.result, targets };
}

/** Derive fixed references only from the first attempt of a successful, matching CI feature-performance report. */
export function performanceReferenceDeclarationFromCiReport(
  observationsValue: unknown,
  checkRecordValue: unknown,
  runValue: unknown,
  observationsFile: string,
  observationsSha256: string,
  recordedAt: string,
  previous: PerformanceReferenceDeclaration,
): PerformanceReferenceDeclaration {
  if (!isRecord(runValue) || typeof runValue.databaseId !== 'number' || !Number.isInteger(runValue.databaseId) ||
      typeof runValue.attempt !== 'number' || !Number.isInteger(runValue.attempt) || runValue.attempt < 1 ||
      typeof runValue.headSha !== 'string' || !/^[a-f0-9]{40}$/.test(runValue.headSha) || !Array.isArray(runValue.jobs))
    throw new Error('GitHub CI proof must identify a run, attempt, source commit, and job results');
  const jobs = runValue.jobs as unknown[];
  const performanceJobs = jobs.filter(job => isRecord(job) && job.name === 'test (feature_performance)');
  if (performanceJobs.length !== 1 || !isRecord(performanceJobs[0]) || performanceJobs[0].conclusion !== 'success')
    throw new Error('the feature_performance CI job did not pass');
  if (!/^var\/evidence\/performance_gate\/observations-\d{4}-\d{2}-\d{2}T\d{9}Z-\d+\.json$/.test(observationsFile) ||
      !/^[a-f0-9]{64}$/.test(observationsSha256) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(recordedAt))
    throw new Error('performance observation evidence needs its canonical path, SHA-256, and UTC recording time');

  const checkRecord = performanceCheckRecord(checkRecordValue);
  const expectedId = `ci_${runValue.databaseId}_${runValue.attempt}_feature_performance`;
  if (checkRecord.id !== expectedId || checkRecord.result !== 'passed' || checkRecord.commit !== runValue.headSha)
    throw new Error('performance check record does not belong to the successful CI run and source commit');
  const featureTarget = checkRecord.targets.find(target => target.name === 'feature-performance-check');
  if (featureTarget?.status !== 'passed' || !featureTarget.log || !featureTarget.started || !featureTarget.ended)
    throw new Error('the feature-performance-check target of the performance CI run did not pass');
  const observationLines = featureTarget.log.match(/^performance_gate raw observations: (.+)$/gm) ?? [];
  if (observationLines.length !== 1 || basename(observationLines[0]?.slice('performance_gate raw observations: '.length) ?? '') !== basename(observationsFile))
    throw new Error('the feature-performance-check target did not report this exact performance observation file');
  const stamp = /^observations-(\d{4}-\d{2}-\d{2}T)(\d{2})(\d{2})(\d{2})(\d{3})Z-/.exec(basename(observationsFile));
  const observationCreated = stamp ? Date.parse(`${stamp[1]}${stamp[2]}:${stamp[3]}:${stamp[4]}.${stamp[5]}Z`) : Number.NaN;
  const targetStarted = Date.parse(featureTarget.started);
  const targetEnded = Date.parse(featureTarget.ended);
  if (!Number.isFinite(observationCreated) || !Number.isFinite(targetStarted) || !Number.isFinite(targetEnded) ||
      observationCreated < targetStarted || observationCreated > targetEnded)
    throw new Error('performance observations were not created during the passed feature-performance-check target');

  const measurements = parsePerformanceMeasurementRecord(observationsValue);
  const references: PerformanceReference[] = measurements.filter(entry => entry.attempt === 1).map(entry => ({
    runtime: entry.runtime, database: entry.database, workload: entry.workload, ratio: entry.ratio, machine: entry.machine,
  }));
  if (references.length !== 6 * 3 * 2)
    throw new Error(`attempt 1 produced ${references.length} references; expected 36`);
  if (previous.status === 'recorded') {
    const previousByKey = new Map(previous.references.map(reference =>
      [`${reference.runtime}/${reference.database}/${reference.workload}`, reference]));
    for (const reference of references) {
      const key = `${reference.runtime}/${reference.database}/${reference.workload}`;
      const old = previousByKey.get(key);
      if (!old || reference.ratio > old.ratio)
        throw new Error(`${key} cannot raise its existing performance reference`);
    }
  }
  const declaration: PerformanceReferenceDeclaration = {
    schema: 1, kind: 'fixed-performance-references', status: 'recorded',
    evidence: {
      file: observationsFile, sha256: observationsSha256, recordedAt,
      ciRunId: String(runValue.databaseId), ciRunAttempt: runValue.attempt, sourceCommit: runValue.headSha,
    },
    references,
  };
  return validatePerformanceReferenceDeclaration(declaration);
}

/** Consume one downloaded CI report and atomically update references, retaining its raw bytes as ignored evidence. */
export async function recordPerformanceReferencesFromCiReport(
  root: string, reportDirectory: string, runValue: unknown, recordedAt = new Date().toISOString(),
): Promise<PerformanceReferenceDeclaration> {
  const canonicalRoot = await realpath(root);
  const evidenceRoot = resolve(canonicalRoot, 'var/evidence/performance_gate');
  const report = resolve(canonicalRoot, reportDirectory);
  const reportRelative = relative(evidenceRoot, report);
  if (!reportRelative || reportRelative === '..' || reportRelative.startsWith(`..${sep}`) || isAbsolute(reportRelative))
    throw new Error(`CI performance report must be downloaded under ${relative(canonicalRoot, evidenceRoot)}`);
  const [recordText, targetLog, runDirectory] = await Promise.all([
    readFile(join(report, 'record.json'), 'utf8'),
    readFile(join(report, 'targets/feature-performance-check.log'), 'utf8'),
    realpath(report),
  ]);
  if (runDirectory !== report) throw new Error('CI performance report path must not contain a symlink');
  let recordValue: unknown;
  try { recordValue = JSON.parse(recordText) as unknown; }
  catch (error) { throw new Error(`CI performance record is invalid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  const checkRecord = performanceCheckRecord(recordValue);
  const featureTarget = checkRecord.targets.find(target => target.name === 'feature-performance-check');
  if (!featureTarget || featureTarget.log !== '.runtime/check/' + checkRecord.id + '/report/targets/feature-performance-check.log')
    throw new Error('CI performance record does not name its report feature-performance-check log');
  const observationLines = targetLog.match(/^performance_gate raw observations: (.+)$/gm) ?? [];
  if (observationLines.length !== 1) throw new Error(`CI performance-check log reported ${observationLines.length} raw observation files; expected one`);
  const sourceName = basename(observationLines[0]?.slice('performance_gate raw observations: '.length) ?? '');
  if (!/^observations-\d{4}-\d{2}-\d{2}T\d{9}Z-\d+\.json$/.test(sourceName))
    throw new Error('CI performance log reported an invalid observation filename');
  const source = resolve(report, 'performance_gate', sourceName);
  const sourceRelative = relative(report, source);
  if (sourceRelative.split(sep).length !== 2 || sourceRelative.split(sep)[0] !== 'performance_gate')
    throw new Error('CI performance observation must be a direct file in the report performance_gate directory');
  const sourceStat = await lstat(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || await realpath(source) !== source)
    throw new Error('CI performance observation is not a regular file');
  const observationText = await readFile(source, 'utf8');
  let observationsValue: unknown;
  try { observationsValue = JSON.parse(observationText) as unknown; }
  catch (error) { throw new Error(`CI performance observations are invalid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  const sha256 = createHash('sha256').update(observationText).digest('hex');
  const previous = await readPerformanceReferenceDeclaration(canonicalRoot);
  const declaration = performanceReferenceDeclarationFromCiReport(
    observationsValue, { ...checkRecord, targets: checkRecord.targets.map(target => target.name === 'feature-performance-check'
      ? { ...target, log: targetLog } : target) }, runValue,
    `var/evidence/performance_gate/${sourceName}`, sha256, recordedAt, previous,
  );
  await mkdir(evidenceRoot, { recursive: true });
  const retained = join(evidenceRoot, sourceName);
  try { await writeFile(retained, observationText, { flag: 'wx' }); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    if (await readFile(retained, 'utf8') !== observationText)
      throw new Error(`existing evidence differs from CI observation ${sourceName}`, { cause: error });
  }
  const declarationPath = join(canonicalRoot, 'contracts/performance-references.json');
  const temporary = `${declarationPath}.${process.pid}.next`;
  try {
    await writeFile(temporary, `${JSON.stringify(declaration, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, declarationPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return declaration;
}

async function recordPerformanceReferencesCli(arguments_: string[]): Promise<void> {
  if (arguments_.length !== 3 || arguments_[0] !== 'record')
    throw new Error('usage: from the ORM checkout root, run node scripts/features/performance-reference.mts record <downloaded-report-directory> <gh-run-proof.json>');
  const root = process.cwd();
  const proofText = await readFile(resolve(root, arguments_[2] ?? ''), 'utf8');
  let proof: unknown;
  try { proof = JSON.parse(proofText) as unknown; }
  catch (error) { throw new Error(`GitHub CI run proof is invalid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  const declaration = await recordPerformanceReferencesFromCiReport(root, arguments_[1] ?? '', proof);
  if (declaration.status !== 'recorded') throw new Error('performance reference recording did not produce a recorded declaration');
  process.stdout.write(`recorded 36 performance references from CI run ${declaration.evidence.ciRunId}, attempt ${declaration.evidence.ciRunAttempt}, commit ${declaration.evidence.sourceCommit}\n`);
}

if (import.meta.main) {
  recordPerformanceReferencesCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
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
  if (!isRecord(evidence) || !exactKeys(evidence, ['file', 'sha256', 'recordedAt', 'ciRunId', 'ciRunAttempt', 'sourceCommit']) ||
      typeof evidence.file !== 'string' || !/^var\/evidence\/performance_gate\/observations-[^/]+\.json$/.test(evidence.file) ||
      typeof evidence.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.sha256) ||
      typeof evidence.recordedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(evidence.recordedAt) ||
      typeof evidence.ciRunId !== 'string' || !/^\d+$/.test(evidence.ciRunId) ||
      typeof evidence.ciRunAttempt !== 'number' || !Number.isInteger(evidence.ciRunAttempt) || evidence.ciRunAttempt < 1 ||
      typeof evidence.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(evidence.sourceCommit))
    throw new Error('recorded performance references require CI run, attempt, source commit, file, SHA-256, and UTC evidence provenance');
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
    evidence: { file: evidence.file, sha256: evidence.sha256, recordedAt: evidence.recordedAt,
      ciRunId: evidence.ciRunId, ciRunAttempt: evidence.ciRunAttempt, sourceCommit: evidence.sourceCommit },
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
  rustTestSymbol?: string,
): PerformanceMeasurement[] {
  const measurements: PerformanceMeasurement[] = [];
  const visit = (text: string): void => {
    for (const line of text.split(/\r?\n/)) {
      const direct = parseMeasurement(line, attempt) ??
        (runtime === 'rust' && rustTestSymbol && line.startsWith(`test ${rustTestSymbol} ... `)
          ? parseMeasurement(line.slice(`test ${rustTestSymbol} ... `.length), attempt)
          : null);
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
