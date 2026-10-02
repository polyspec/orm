// Generator test: the npm bin declares only valid chain names and imports the
// published package outside this repository.
// Usage: node clients/typescript/tests/generate.mjs (after npm run typescript:build)
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../../..', import.meta.url).pathname;
const bin = join(root, 'clients/typescript/dist/bin/orm-gen.js');
const work = await mkdtemp(join(tmpdir(), 'orm-ts-gen-'));
let failures = 0;
function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL: ${message}`); }
}
function run(...args) { return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' }); }

try {
  const usage = join(work, 'usage.ts');
  // The names are interpolated so that scans of this file do not see them.
  const calls = ['getsByNotAColumn(1)', 'orderByNotAColumnAsc()', 'gtIsClose(1)', 'lkReadCount(1)', 'getsByServiceSeqAndLtStartDt(1, 2)', 'andNeUuid(null)', 'joinServiceSeqWithSeq(s)'];
  await writeFile(usage, `import { Author } from './models/models.js';\ndeclare const x: Author;\n${calls.map(c => `x.${c};`).join('\n')}\n// comment.${'notCalled'}(1)\n`);
  const out = join(work, 'models');
  const bench = join(root, 'schema/bench.dbs');
  const result = run('gen', '--schema', bench, '--out', out, '--scan', usage);
  check(result.status === 0, `orm-gen exit ${result.status}: ${result.stderr}`);
  const text = await readFile(join(out, 'models.ts'), 'utf8');
  for (const invalid of ['NotAColumn', 'gtIsClose', 'lkReadCount', 'notCalled']) check(!text.includes(invalid), `declared invalid name ${invalid}`);
  check(text.includes('getsByServiceSeqAndLtStartDt(v0: number | readonly (number)[] | ValueFunction | Model, v1: string | Date | ValueFunction): Promise<Collection<this>>;'), 'chain declaration');
  check(text.includes('andNeUuid(v0: string | readonly (string)[] | ValueFunction | Model | null): this;'), 'nullable condition declaration');
  check(text.includes('joinServiceSeqWithSeq(child: '), 'join declaration');
  check(text.includes("from '@polyspec/orm-typescript'"), 'generated output outside the repository imports the package');
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
  const types = join(work, 'types.dbs');
  await writeFile(types, 'dbspec 1 types\n\ntable typed {\n  seq i64\n  small i16\n  day date null\n  clock time(3)\n  stamp datetime(0)\n  id uuid\n  body text\n  blob bytes\n  ratio f64\n  primary key (seq)\n}\n');
  const typed = join(work, 'typed');
  check(run('gen', '--schema', types, '--out', typed).status === 0, 'generation of the type document');
  const typedText = await readFile(join(typed, 'models.ts'), 'utf8');
  for (const declaration of [
    'getSmall(): number', 'setSmall(value: number): this', 'getDay(): string | null', 'setDay(value: string | Date | null): this',
    'getClock(): string', 'setClock(value: string): this', 'getStamp(): string', 'getId(): string', 'getBody(): string',
    'getBlob(): Uint8Array', 'getRatio(): number', 'plusSmall(n: number): this',
  ]) check(typedText.includes(`public ${declaration} {`), `declaration ${declaration}`);
  const nested = await mkdtemp(join(root, 'clients/typescript/src/models/decimal-test-'));
  try {
    const nestedResult = run('gen', '--schema', join(root, 'contracts/fixtures/decimal_schema.dbs'), '--out', nested, '--scan', usage);
    check(nestedResult.status === 0, `nested generated model exit ${nestedResult.status}: ${nestedResult.stderr}`);
    const nestedText = await readFile(join(nested, 'models.ts'), 'utf8');
    check(nestedText.includes("from '../../index.js'"), 'nested model imports its client runtime');
    check(nestedText.includes('  amount decimal(13,4)\n'), 'nested model keeps decimal metadata');
  } finally {
    await rm(nested, { recursive: true, force: true });
  }
  check(run('gen', '--out', out).status === 2, 'missing --schema is a usage error');
  check(run('--schema', bench, '--out', out).status === 2, 'a missing command is a usage error');
  check(run('gen', '--schema', join(work, 'missing.dbs'), '--out', out).status === 1, 'missing schema fails');
  const invalid = join(work, 'invalid.dbs');
  await writeFile(invalid, 'dbspec 1 invalid\n\ntable t {\n  seq i64\n}\n');
  const rejected = run('gen', '--schema', invalid, '--out', out);
  check(rejected.status === 1 && rejected.stderr.includes('SCHEMA_INVALID'), `an invalid document fails: ${rejected.stderr}`);

  // readDbspecFile rejects a file without the dbspec signature before parsing it.
  for (const name of ['dbschema.dbs', 'empty.dbs']) {
    const file = join(root, 'tests/dbspec/files', name);
    const unsigned = run('gen', '--schema', file, '--out', join(work, `signature-${name}`));
    check(unsigned.status === 1 && unsigned.stderr === `orm-gen: SCHEMA_INVALID: 1:1 signature: ${file} is not a dbspec document\n`, `${name} without the signature: ${unsigned.status} ${unsigned.stderr}`);
  }

  // --check compares models.ts and the dbspec documents without writing.
  const genCheck = ['gen', '--schema', bench, '--out', out, '--scan', usage, '--check'];
  let checked = run(...genCheck);
  check(checked.status === 0 && checked.stdout === '' && checked.stderr === '', `gen --check on current models: ${checked.status} ${checked.stdout}${checked.stderr}`);
  await writeFile(join(out, 'models.ts'), '// changed\n');
  checked = run(...genCheck);
  check(checked.status === 1 && checked.stdout === `differs: ${out}/models.ts\n`, `gen --check on changed models: ${checked.status} ${checked.stdout}${checked.stderr}`);
  check(await readFile(join(out, 'models.ts'), 'utf8') === '// changed\n', 'gen --check wrote models.ts');
  await rm(join(out, 'models.ts'));
  checked = run(...genCheck);
  check(checked.status === 1 && checked.stdout === `missing: ${out}/models.ts\n`, `gen --check on missing models: ${checked.status} ${checked.stdout}${checked.stderr}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
if (failures > 0) {
  console.error(`typescript generator test: ${failures} failure(s)`);
  process.exit(1);
}
console.log('typescript generator test passed');
