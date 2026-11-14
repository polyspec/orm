// Generator test: the npm bin declares only valid chain names and imports the
// published package outside this repository.
// Usage: node packages/ts/tests/generate.mjs (after npm run typescript:build)
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { caseTest, runLong, stepLines } from '../../../../tests/testcase.mts';
import { isolatedEnvironment } from '../../../../tests/environment.mts';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { writeTextIfChanged } from '../dist/generate/typescript.js';

const root = new URL('../../..', import.meta.url).pathname;
const bin = join(root, 'packages/ts/dist/bin/orm-gen.js');
let failures = 0;
function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL: ${message}`); }
}
/** The non-null assertions and the type assertions of a call's result in generated code, one line each. */
function uncheckedReads(text) {
  return text.split('\n').filter(line => /\)!|\]!|\)\s+as\s+[A-Za-z]/.test(line)).map(line => line.trim());
}
function run(...args) { return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', cwd: root, env: isolatedEnvironment() }); }

/** Runs a tool without a deadline and streams every output line to its step record. */
async function runLogged(name, args, cwd) {
  let code;
  let output = '';
  const passed = await runLong(name, async ({ step }) => {
    const child = spawn(process.execPath, args, { cwd, env: isolatedEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = stepLines(step);
    const stderr = stepLines(step);
    child.stdout.on('data', chunk => { const text = String(chunk); output += text; stdout.write(text); });
    child.stderr.on('data', chunk => { const text = String(chunk); output += text; stderr.write(text); });
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', result => { code = result; stdout.flush(); stderr.flush(); resolve(); });
    });
  });
  return { passed, code, output };
}
/**
 * Writes the documents, each a name and its text, and a set file that owns them into a new directory under the work
 * directory, and returns the path of the set file.
 */
async function setOf(dir, documents, external = []) {
  await mkdir(dir, { recursive: true });
  for (const [name, text] of documents) await writeFile(join(dir, name), text);
  const set = join(dir, 'dbspec-set.json');
  await writeFile(set, JSON.stringify({ schema: 1, documents: documents.map(([name]) => name), external }) + '\n');
  return set;
}

// The generator check is one case that runs the orm-gen and tsc processes.
// Requirements: DBS-121, DSL-37, DSL-130, PLN-22, ORES-21, DBS-5, DBS-98, DBS-4, DBS-27, DBS-110, DBS-155, DBS-175, DSL-127.
// Requirements: DSL-154.
caseTest('generate', async () => {
  const work = await mkdtemp(join(tmpdir(), 'orm-ts-gen-'));
  try {
    const usage = join(work, 'usage.ts');
    // The names are interpolated so that scans of this file do not see them.
    const calls = ['getsByServiceSeqAndLtStartDt(1, 2)', 'andNeUuid(null)', 'joinServiceSeqWithSeq(s)'];
    await writeFile(usage, `import { Author } from './models/models.js';\ndeclare const x: Author;\n${calls.map(c => `x.${c};`).join('\n')}\n// comment.${'notCalled'}(1)\n`);
    const out = join(work, 'models');
    const bench = join(root, 'contracts/fixtures/bench/dbspec-set.json');
    const result = run('gen', '--set', bench, '--out', out, '--scan', usage);
    check(result.status === 0, `orm-gen exit ${result.status}: ${result.stderr}`);
    const text = await readFile(join(out, 'models.ts'), 'utf8');
    check(!text.includes('notCalled'), 'declared a name of a comment');
    // The generated code passes the lint of its consumers (kit 0.0.47, T179): it reads an entity and a column value with
    // a check that throws, never with a non-null assertion or a type assertion of the read.
    for (const read of uncheckedReads(text)) check(false, `unchecked read in the generated models: ${read}`);
    check(text.includes('declare getsByServiceSeqAndLtStartDt: (v0: number | readonly (number)[] | ValueFunction | Model, v1: string | Date | ValueFunction) => Promise<Collection<this>>;'), 'chain declaration');
    check(text.includes('declare andNeUuid: (v0: string | readonly (string)[] | ValueFunction | Model | null) => this;'), 'nullable condition declaration');
    check(text.includes('declare joinServiceSeqWithSeq: (child: '), 'join declaration');
    check(text.includes("from '@polyspec/orm'"), 'generated output outside the repository imports the package');
    // A setter of a date, time or datetime column takes the text form.
    check(text.includes('public setCreatedTs(value: string): this {') && text.includes('public setDisplayStartDt(value: string | null): this {'), 'a time setter takes a native value');
    check(text.includes('export const MANIFEST_TEXT = `dbspec 1 bench\n') && /export const MANIFEST_HASH = 'sha256:[0-9a-f]{64}';/.test(text), 'the manifest text and hash are embedded');
    // The value type of each codec: a styled value for ordered_json and gz, a string for aes hex and ip.
    for (const declaration of [
      'getJsonSetting(): StyledValue<JsonValue>',
      'setJsonSetting(value: StyledValue<JsonValue | CodecValue>): this',
      'getGzExtend(): StyledValue<CodecValue>',
      'getBase64Extra(): StyledValue<CodecValue>',
      'getAesHexEmail(): string | null',
      'setAesHexEmail(value: string | null): this',
      'getIp(): string | null',
      'getDescription(): string | null',
    ]) check(text.includes(`public ${declaration} {`), `declaration ${declaration}`);
    // The value type of each dbspec type.
    const types = await setOf(join(work, 'types'), [['types.dbs', 'dbspec 1 types\n\ntable typed {\n  seq i64\n  small i16\n  day date null\n  clock time(3)\n  stamp datetime(0)\n  id uuid\n  body text\n  blob bytes\n  ratio f64\n  primary key (seq)\n}\n']]);
    const typed = join(work, 'typed');
    check(run('gen', '--set', types, '--out', typed).status === 0, 'generation of the type document');
    const typedText = await readFile(join(typed, 'models.ts'), 'utf8');
    for (const read of uncheckedReads(typedText)) check(false, `unchecked read in the generated type models: ${read}`);
    for (const declaration of [
      'getSmall(): number', 'setSmall(value: number): this', 'getDay(): string | null', 'setDay(value: string | null): this',
      'getClock(): string', 'setClock(value: string): this', 'getStamp(): string', 'getId(): string', 'getBody(): string',
      'getBlob(): Uint8Array', 'getRatio(): number', 'plusSmall(n: number): this',
    ]) check(typedText.includes(`public ${declaration} {`), `declaration ${declaration}`);

    const nested = await mkdtemp(join(root, 'packages/ts/src/models/decimal-test-'));
    try {
      const nestedResult = run('gen', '--set', join(root, 'contracts/fixtures/dbspec-set.json'), '--out', nested, '--scan', usage);
      check(nestedResult.status === 0, `nested generated model exit ${nestedResult.status}: ${nestedResult.stderr}`);
      const nestedText = await readFile(join(nested, 'models.ts'), 'utf8');
      check(nestedText.includes("from '../../../../packages/index.js'"), 'nested model imports its client runtime');
      check(nestedText.includes('  amount decimal(13,4)\n'), 'nested model keeps decimal metadata');
    } finally {
      await rm(nested, { recursive: true, force: true });
    }
    check(run('gen', '--out', out).status === 2, 'missing --set is a usage error');
    check(run('--set', bench, '--out', out).status === 2, 'a missing command is a usage error');
    // The removed forms are usage errors.
    check(run('gen', '--schema', join(root, 'contracts/fixtures/bench/bench.dbs'), '--out', out).status === 2, '--schema is a usage error');
    check(run('gen', '--set', bench, '--use', join(root, 'contracts/fixtures/bench/bench.dbs'), '--out', out).status === 2, '--use is a usage error');
    const missing = join(work, 'missing', 'dbspec-set.json');
    const missingRun = run('gen', '--set', missing, '--out', join(work, 'missing-out'));
    check(missingRun.status === 1 && missingRun.stderr.startsWith(`orm-gen: set.file: ${missing}`), `a missing set file fails: ${missingRun.stderr}`);
    const invalid = await setOf(join(work, 'invalid'), [['invalid.dbs', 'dbspec 1 invalid\n\ntable t {\n  seq i64\n}\n']]);
    const rejected = run('gen', '--set', invalid, '--out', out);
    check(rejected.status === 1 && rejected.stderr.includes('SCHEMA_INVALID'), `an invalid document fails: ${rejected.stderr}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  if (failures > 0) throw new Error(`${failures} check(s) failed; each FAIL line above names one`);
});

// The positive consumer compiles and runs without diagnostic suppression. Its separate negative fixture must fail only
// at the raw typed-field assignment, with TypeScript's exact code and source location.
// Requirements: DBS-112, DBS-114, INT-66.
caseTest('generated typed getter consumer compiler fixture', async () => {
  const runDir = join(root, '.runtime/run');
  await mkdir(runDir, { recursive: true });
  const consumerDir = await mkdtemp(join(runDir, 'ts-generated-getter-'));
  try {
    const getterSet = await setOf(join(consumerDir, 'set'), [['getter.dbs',
      'dbspec 1 getter\n\ntable item {\n  price i32\n  primary key (price)\n}\n']]);
    const generated = join(consumerDir, 'generated');
    const emptyScan = join(consumerDir, 'empty-scan.ts');
    await writeFile(emptyScan, 'export {};\n');
    const generatedRun = await runLogged('typescript-generated-getter-generate', [bin, 'gen', '--set', getterSet, '--out', generated, '--scan', emptyScan], root);
    assert.equal(generatedRun.passed, true, generatedRun.output);
    assert.equal(generatedRun.code, 0, generatedRun.output);

    const consumer = join(consumerDir, 'consumer.ts');
    await writeFile(consumer, `import assert from 'node:assert/strict';
import { Item } from './generated/models.js';

const item = new Item();
let errorCode = '';
try { item.getPrice(); } catch (error) {
  if (typeof error === 'object' && error !== null && 'code' in error) errorCode = String(error.code);
}
assert.equal(errorCode, 'COLUMN_UNSELECTED');
const price: number = item.setPrice(17).getPrice();
assert.equal(price, 17);
assert.equal(Object.hasOwn(item, 'price'), false);
assert.equal('price' in item, false);
`);
    const tsc = join(root, 'node_modules/typescript/bin/tsc');
    const compiled = join(consumerDir, 'compiled');
    const positive = await runLogged('typescript-generated-getter-positive-compile', [
      tsc, '--ignoreConfig', '--strict', '--types', 'node', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
      '--rootDir', consumerDir, '--outDir', compiled, consumer,
    ], root);
    assert.equal(positive.passed, true, positive.output);
    assert.equal(positive.code, 0, positive.output);
    const executed = await runLogged('typescript-generated-getter-positive-runtime', [join(compiled, 'consumer.js')], root);
    assert.equal(executed.passed, true, executed.output);
    assert.equal(executed.code, 0, executed.output);

    const negative = join(consumerDir, 'negative.ts');
    await writeFile(negative, `import { Item } from './generated/models.js';

const item = new Item();
const rawPrice: number = item.price;
void rawPrice;
`);
    const rejected = await runLogged('typescript-generated-getter-negative-compile', [
      tsc, '--ignoreConfig', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
      '--noEmit', '--rootDir', consumerDir, negative,
    ], root);
    const diagnostics = rejected.output.trim().split('\n').filter(Boolean);
    assert.equal(rejected.passed, true, rejected.output);
    assert.equal(rejected.code, 1, rejected.output);
    assert.equal(diagnostics.length, 1, rejected.output);
    assert.match(diagnostics[0], /^\.runtime\/run\/ts-generated-getter-[A-Za-z0-9_-]+\/negative\.ts\(4,7\): error TS2322: Type '\(v0: number \| Model \| readonly number\[\] \| ValueFunction\) => Item' is not assignable to type 'number'\.$/);
  } finally {
    await rm(consumerDir, { recursive: true, force: true });
  }
});

// Requirements: DBS-112, DBS-116, DBS-121, INT-2, INT-3, INT-4, INT-5, INT-6, INT-7, INT-8, COD-2.
caseTest('generated field types follow the runtime model', async () => {
  const runDir = join(root, '.runtime/run');
  await mkdir(runDir, { recursive: true });
  const dir = await mkdtemp(join(runDir, 'ts-generated-field-types-'));
  try {
    const document = 'dbspec 1 typed\n\ntable item {\n  seq i64 identity\n  amount decimal(10,2) null\n  ratio f64\n  enabled bool\n  body text\n  payload bytes null\n  day date\n  clock time(3)\n  moment datetime(3) null\n  json_value text null\n  primary key (seq)\n  settings {\n    codec json_value ordered_json\n  }\n}\n';
    const set = await setOf(join(dir, 'set'), [['typed.dbs', document]]);
    const output = join(dir, 'model');
    const result = run('gen', '--set', set, '--out', output);
    assert.equal(result.status, 0, result.stderr);
    const generated = await readFile(join(output, 'models.ts'), 'utf8');
    for (const declaration of [
      'public getAmount(): string | null', 'public setAmount(value: string | null): this',
      'public getRatio(): number', 'public setRatio(value: number): this',
      'public getEnabled(): boolean', 'public setEnabled(value: boolean): this',
      'public getBody(): string', 'public setBody(value: string): this',
      'public getPayload(): Uint8Array | null', 'public setPayload(value: Uint8Array | null): this',
      'public getDay(): string', 'public setDay(value: string): this',
      'public getClock(): string', 'public setClock(value: string): this',
      'public getMoment(): string | null', 'public setMoment(value: string | null): this',
      'public getJsonValue(): StyledValue<JsonValue>',
      'public setJsonValue(value: StyledValue<JsonValue | CodecValue>): this',
    ]) assert.ok(generated.includes(declaration), `missing generated type: ${declaration}`);
    const consumer = join(dir, 'consumer.ts');
    await writeFile(consumer, `import { Item } from './model/models.js';
const item = new Item().setMoment('2026-01-02 03:04:05.006');
const canonical: string | null = item.getMoment();
function rejectsNativeDateAtCompileTime(): void {
  // @ts-expect-error a native Date is not the canonical dbspec text accepted by a generated setter
  item.setMoment(new Date());
}
void canonical;
void rejectsNativeDateAtCompileTime;
const row = new Item().setMoment('2026-01-02 03:04:05.006').setDay('2026-01-02').setClock('03:04:05.006');
if (row.getMoment() !== '2026-01-02 03:04:05.006' || row.getDay() !== '2026-01-02' || row.getClock() !== '03:04:05.006') {
  throw new Error('generated temporal getters did not preserve canonical dbspec text');
}
`);
    const tsc = join(root, 'node_modules/typescript/bin/tsc');
    const compiled = join(dir, 'compiled');
    const checked = await runLogged('typescript-generated-field-types-consumer', [
      tsc, '--ignoreConfig', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--rootDir', dir, '--outDir', compiled, consumer,
    ], root);
    assert.equal(checked.passed, true, checked.output);
    assert.equal(checked.code, 0, checked.output);
    const executed = spawnSync(process.execPath, [join(compiled, 'consumer.js')], { encoding: 'utf8', cwd: root, env: isolatedEnvironment() });
    assert.equal(executed.status, 0, `${executed.stdout}${executed.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Requirements: DBS-104.
// Requirements: DBS-104, DBS-111, DBS-120.
caseTest('generated manifest text and hash match', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orm-ts-manifest-'));
  try {
    const manifestText = 'dbspec 1 manifest\n\ntable first_item {\n  id i64 identity\n  primary key (id)\n}\n\ntable second_item {\n  id i64 identity\n  primary key (id)\n}\n';
    const set = await setOf(join(dir, 'set'), [['manifest.dbs', manifestText]]);
    const output = join(dir, 'generated');
    const generated = run('gen', '--set', set, '--out', output);
    assert.equal(generated.status, 0, generated.stderr);
    const source = await readFile(join(output, 'models.ts'), 'utf8');
    const hash = `sha256:${createHash('sha256').update(manifestText).digest('hex')}`;
    assert.ok(source.includes(`export const MANIFEST_TEXT = \`${manifestText}\`;`));
    assert.ok(source.includes(`export const MANIFEST_HASH = '${hash}';`));
    assert.ok(source.includes('export class FirstItem extends Model'), 'generated first entity comes from the manifest');
    assert.ok(source.includes('export class SecondItem extends Model'), 'generated second entity comes from the manifest');
    assert.ok(source.indexOf('export class FirstItem') < source.indexOf('export class SecondItem'), 'generated entities follow document order');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The generated schema value carries the external text at run time: the generated connect registers a set that uses an
// external document, and the model of a used external table, compiled by tsc, reads a row of that table.
// Requirements: DBS-110, DBS-173.
caseTest('generated external model reads its table', async () => {
  const runDir = join(root, '.runtime/run');
  await mkdir(runDir, { recursive: true });
  const consumerDir = await mkdtemp(join(runDir, 'ts-generated-external-'));
  try {
    const fixtures = join(root, 'contracts/fixtures/external');
    await mkdir(join(consumerDir, 'set/core'), { recursive: true });
    await writeFile(join(consumerDir, 'set/member.dbs'), await readFile(join(fixtures, 'member.dbs'), 'utf8'));
    await writeFile(join(consumerDir, 'set/core/core.dbs'), await readFile(join(fixtures, 'core.dbs'), 'utf8'));
    const set = join(consumerDir, 'set/dbspec-set.json');
    await writeFile(set, JSON.stringify({ schema: 1, documents: ['member.dbs'], external: ['core/core.dbs'] }));
    const consumer = join(consumerDir, 'consumer.ts');
    const path = join(consumerDir, 'external.sqlite');
    await writeFile(consumer, `import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { connect, ExtAccount } from './generated/models.js';

const raw = new DatabaseSync(${JSON.stringify(path)});
raw.exec("CREATE TABLE ext_account (seq INTEGER PRIMARY KEY, name TEXT NOT NULL)");
raw.exec("INSERT INTO ext_account (seq, name) VALUES (1, 'kim')");
raw.close();
const db = await connect(${JSON.stringify(`sqlite://${path}`)});
try {
  const row = await new ExtAccount().connect(db).getBySeq(1);
  assert.equal(row?.getName(), 'kim');
} finally {
  await db.close();
}
`);
    const generated = join(consumerDir, 'generated');
    const generatedRun = await runLogged('typescript-generated-external-generate', [bin, 'gen', '--set', set, '--out', generated, '--scan', consumer], root);
    assert.equal(generatedRun.passed, true, generatedRun.output);
    assert.equal(generatedRun.code, 0, generatedRun.output);
    const compiled = join(consumerDir, 'compiled');
    const tsc = join(root, 'node_modules/typescript/bin/tsc');
    const checked = await runLogged('typescript-generated-external-compile', [
      tsc, '--ignoreConfig', '--strict', '--types', 'node', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
      '--rootDir', consumerDir, '--outDir', compiled, consumer,
    ], root);
    assert.equal(checked.passed, true, checked.output);
    assert.equal(checked.code, 0, checked.output);
    const executed = await runLogged('typescript-generated-external-runtime', [join(compiled, 'consumer.js')], root);
    assert.equal(executed.passed, true, executed.output);
    assert.equal(executed.code, 0, executed.output);
  } finally {
    await rm(consumerDir, { recursive: true, force: true });
  }
});

// writeTextIfChanged (T341-2): a file that already holds the text is left as it is, and a changed file is written to a temporary file of its
// directory and renamed over the old one, so a reader never sees a partial file.
function writeIfChangedDirectory() {
  return mkdtempSync(join(tmpdir(), 'write-if-changed-'));
}

caseTest('writeTextIfChanged leaves a file that holds the text as it is', () => {
  const dir = writeIfChangedDirectory();
  try {
    const file = join(dir, 'models.ts');
    writeTextIfChanged(file, 'export const a = 1;\n');
    const before = statSync(file);
    writeTextIfChanged(file, 'export const a = 1;\n');
    const after = statSync(file);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.deepEqual(readdirSync(dir), ['models.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

caseTest('writeTextIfChanged renames a changed text over the old file from its directory', () => {
  const dir = writeIfChangedDirectory();
  try {
    const file = join(dir, 'models.ts');
    writeFileSync(file, 'export const a = 1;\n');
    const before = statSync(file);
    writeTextIfChanged(file, 'export const a = 2;\n');
    assert.notEqual(statSync(file).ino, before.ino);
    assert.equal(readFileSync(file, 'utf8'), 'export const a = 2;\n');
    assert.deepEqual(readdirSync(dir), ['models.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

caseTest('writeTextIfChanged creates a missing file', () => {
  const dir = writeIfChangedDirectory();
  try {
    const file = join(dir, 'models.ts');
    writeTextIfChanged(file, 'export const b = 1;\n');
    assert.equal(readFileSync(file, 'utf8'), 'export const b = 1;\n');
    assert.deepEqual(readdirSync(dir), ['models.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
