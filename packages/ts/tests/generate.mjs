// Generator test: the npm bin declares only valid chain names and imports the
// published package outside this repository.
// Usage: node packages/ts/tests/generate.mjs (after npm run typescript:build)
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest, PROCESS } from '../../../tests/testcase.mts';

const root = new URL('../../..', import.meta.url).pathname;
const bin = join(root, 'packages/ts/dist/bin/orm-gen.js');
const work = await mkdtemp(join(tmpdir(), 'orm-ts-gen-'));
let failures = 0;
function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL: ${message}`); }
}
/** The non-null assertions and the type assertions of a call's result in generated code, one line each. */
function uncheckedReads(text) {
  return text.split('\n').filter(line => /\)!|\]!|\)\s+as\s+[A-Za-z]/.test(line)).map(line => line.trim());
}
function run(...args) { return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' }); }
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

// generator check는 orm-gen과 tsc process를 실행하는 case 하나다.
caseTest('generate', PROCESS, async () => {
  try {
    const usage = join(work, 'usage.ts');
    // The names are interpolated so that scans of this file do not see them.
    const calls = ['getsByNotAColumn(1)', 'orderByNotAColumnAsc()', 'gtIsClose(1)', 'lkReadCount(1)', 'getsByServiceSeqAndLtStartDt(1, 2)', 'andNeUuid(null)', 'joinServiceSeqWithSeq(s)'];
    await writeFile(usage, `import { Author } from './models/models.js';\ndeclare const x: Author;\n${calls.map(c => `x.${c};`).join('\n')}\n// comment.${'notCalled'}(1)\n`);
    const out = join(work, 'models');
    const bench = join(root, 'contracts/fixtures/bench/dbspec-set.json');
    const result = run('gen', '--set', bench, '--out', out, '--scan', usage);
    check(result.status === 0, `orm-gen exit ${result.status}: ${result.stderr}`);
    const text = await readFile(join(out, 'models.ts'), 'utf8');
    for (const invalid of ['NotAColumn', 'gtIsClose', 'lkReadCount', 'notCalled']) check(!text.includes(invalid), `declared invalid name ${invalid}`);
    // The generated code passes the lint of its consumers (kit 0.0.47, T179): it reads an entity and a column value with
    // a check that throws, never with a non-null assertion or a type assertion of the read.
    for (const read of uncheckedReads(text)) check(false, `unchecked read in the generated models: ${read}`);
    check(text.includes('declare getsByServiceSeqAndLtStartDt: (v0: number | readonly (number)[] | ValueFunction | Model, v1: string | Date | ValueFunction) => Promise<Collection<this>>;'), 'chain declaration');
    check(text.includes('declare andNeUuid: (v0: string | readonly (string)[] | ValueFunction | Model | null) => this;'), 'nullable condition declaration');
    check(text.includes('declare joinServiceSeqWithSeq: (child: '), 'join declaration');
    check(text.includes("from '@polyspec/orm'"), 'generated output outside the repository imports the package');
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
      'getSmall(): number', 'setSmall(value: number): this', 'getDay(): string | null', 'setDay(value: string | Date | null): this',
      'getClock(): string', 'setClock(value: string): this', 'getStamp(): string', 'getId(): string', 'getBody(): string',
      'getBlob(): Uint8Array', 'getRatio(): number', 'plusSmall(n: number): this',
    ]) check(typedText.includes(`public ${declaration} {`), `declaration ${declaration}`);
    const nested = await mkdtemp(join(root, 'packages/ts/src/models/decimal-test-'));
    try {
      const nestedResult = run('gen', '--set', join(root, 'contracts/fixtures/dbspec-set.json'), '--out', nested, '--scan', usage);
      check(nestedResult.status === 0, `nested generated model exit ${nestedResult.status}: ${nestedResult.stderr}`);
      const nestedText = await readFile(join(nested, 'models.ts'), 'utf8');
      check(nestedText.includes("from '../../index.js'"), 'nested model imports its client runtime');
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
    // Every error of the set file is printed, and nothing is written.
    const broken = await setOf(join(work, 'broken'), [['a.dbs', 'dbspec 1 a\n']]);
    await writeFile(broken, JSON.stringify({ schema: 1, documents: ['gone.dbs', 'a.dbs', 'a.dbs', 'bad\\x.dbs'] }));
    const brokenOut = join(work, 'broken-out');
    const brokenRun = run('gen', '--set', broken, '--out', brokenOut);
    const brokenDir = join(work, 'broken');
    check(brokenRun.status === 1 && brokenRun.stdout === '' && brokenRun.stderr.split('\n').filter(Boolean).map(line => line.split(':').slice(0, 2).join(':')).join(' ')
      === 'orm-gen: set.file orm-gen: set.path orm-gen: set.duplicate orm-gen: ' + broken, `every set error is printed: ${brokenRun.stderr}`);
    check(brokenRun.stderr.includes(`${brokenDir}/gone.dbs`) && brokenRun.stderr.includes(`${brokenDir}/a.dbs`), `the errors name their paths: ${brokenRun.stderr}`);
    check(!existsSync(brokenOut), 'nothing is written on a set error');

    // The byte check rejects every listed file without the dbspec signature before parsing, and each is printed.
    const unsignedDir = join(work, 'unsigned');
    await mkdir(unsignedDir);
    const unsignedSet = join(unsignedDir, 'dbspec-set.json');
    const unsignedNames = ['dbschema.dbs', 'empty.dbs'];
    for (const name of unsignedNames) await copyFile(join(root, 'tests/dbspec/files', name), join(unsignedDir, name));
    await writeFile(unsignedSet, JSON.stringify({ schema: 1, documents: unsignedNames }));
    const unsignedOut = join(work, 'unsigned-out');
    const unsigned = run('gen', '--set', unsignedSet, '--out', unsignedOut);
    const unsignedWant = unsignedNames.map(name => `orm-gen: ${unsignedDir}/${name}:1:1 signature: ${unsignedDir}/${name} is not a dbspec document\n`).join('')
      + `orm-gen: ${unsignedSet}: 2 document diagnostic(s); nothing was written\n`;
    check(unsigned.status === 1 && unsigned.stderr === unsignedWant, `files without the signature: ${unsigned.status} ${unsigned.stderr}`);
    check(!existsSync(unsignedOut), 'nothing is written on a document diagnostic');

    // --check compares models.ts and the dbspec documents without writing.
    const genCheck = ['gen', '--set', bench, '--out', out, '--scan', usage, '--check'];
    let checked = run(...genCheck);
    check(checked.status === 0 && checked.stdout === '' && checked.stderr === '', `gen --check on current models: ${checked.status} ${checked.stdout}${checked.stderr}`);
    await writeFile(join(out, 'models.ts'), '// changed\n');
    checked = run(...genCheck);
    check(checked.status === 1 && checked.stdout === `differs: ${out}/models.ts\n`, `gen --check on changed models: ${checked.status} ${checked.stdout}${checked.stderr}`);
    check(await readFile(join(out, 'models.ts'), 'utf8') === '// changed\n', 'gen --check wrote models.ts');
    await rm(join(out, 'models.ts'));
    checked = run(...genCheck);
    check(checked.status === 1 && checked.stdout === `missing: ${out}/models.ts\n`, `gen --check on missing models: ${checked.status} ${checked.stdout}${checked.stderr}`);
    // 외부 문서(external)를 쓰는 set은 소유한 table의 model만 만들고, 외부 문서에서 쓰는 table의 text를 schema 값에 싣는다.
    const external = join(root, 'contracts/fixtures/external');
    const memberOut = join(work, 'member');
    // The set owns member.dbs and names core.dbs in a sibling directory, through a `..` path.
    await mkdir(join(work, 'external/core'), { recursive: true });
    await copyFile(join(external, 'core.dbs'), join(work, 'external/core/core.dbs'));
    const memberSet = await setOf(join(work, 'external/app'), [['member.dbs', await readFile(join(external, 'member.dbs'), 'utf8')]], ['../core/core.dbs']);
    const member = run('gen', '--set', memberSet, '--out', memberOut);
    check(member.status === 0, `orm-gen of a set with an external document: ${member.status} ${member.stderr}`);
    if (member.status === 0) {
      const generated = await readFile(join(memberOut, 'models.ts'), 'utf8');
      const classes = [...generated.matchAll(/^export class (\w+) extends Model/gm)].map(m => m[1]);
      check(JSON.stringify(classes) === JSON.stringify(['ExtPost', 'ExtPostHistory']), `classes of the member set ${JSON.stringify(classes)}, want the owned tables`);
      check(generated.includes('export const EXTERNAL_TEXT = `dbspec 1 ext_core\n'), 'the generated models carry the external text');
      check(generated.includes('externalText: EXTERNAL_TEXT') && generated.includes('registerModel(MANIFEST_TEXT, MANIFEST_HASH, EXTERNAL_TEXT)'), 'the schema value and the registered model carry the external text');
      check(!generated.includes('ext_session'), 'the generated models carry ext_session, which the set does not use');
    }
    // The typed query methods follow the schema: each prefix of a key of a model is a method of that model, whether or not a
    // scanned source calls it, so a model of a generated package declares the same methods in every checkout.
    const indexed = await setOf(join(work, 'index-methods'), [['audit_columns.dbs', await readFile(join(root, 'contracts/fixtures/audit_columns.dbs'), 'utf8')]]);
    const emptyScan = join(work, 'index-methods-scan.mjs');
    await writeFile(emptyScan, 'export {};\n');
    const indexedOut = join(work, 'index-methods-out');
    const indexedRun = run('gen', '--set', indexed, '--out', indexedOut, '--scan', emptyScan);
    check(indexedRun.status === 0, `orm-gen of the indexed set without a call: ${indexedRun.status} ${indexedRun.stderr}`);
    if (indexedRun.status === 0) {
      const generated = await readFile(join(indexedOut, 'models.ts'), 'utf8');
      const declares = (model, method) => new RegExp(`export class ${model} extends Model \\{\\n(?:(?!\\n\\}\\n)[\\s\\S])*\\n  declare ${method}:`).test(generated);
      check(declares('Card', 'auditSeq'), 'Card declares auditSeq, the prefix of ix_card_audit, without a scanned call');
      check(declares('CardHistory', 'seq'), 'CardHistory declares seq, the prefix of ix_card_history_row, without a scanned call');
    }
    // 모델 method 이름은 column 이름이 될 수 없다: restore() 가 있으므로 restore column 도 거부한다.
    const reservedSchema = await setOf(join(work, 'reserved-set'), [['reserved.dbs', 'dbspec 1 reserved\n\ntable thing {\n  id i64 identity\n  restore i32\n  primary key (id)\n}\n']]);
    const reserved = run('gen', '--set', reservedSchema, '--out', join(work, 'reserved'));
    check(reserved.status !== 0 && reserved.stderr.includes('column name is a reserved method name: restore'), `a column named restore: ${reserved.status} ${reserved.stderr}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  if (failures > 0) throw new Error(`${failures} check(s) failed; each FAIL line above names one`);
});
