// Generator scan test: `orm-gen gen --scan` declares the chain methods that
// the sources call on models, each on the model the receiver resolves to, and
// nothing for a call whose receiver is not a model.
// Usage: node packages/orm-npm/tests/generate-scan.mjs [case ...] (after npm run typescript:build)
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCase } from '../../../tests/testcase.mjs';

const root = new URL('../../..', import.meta.url).pathname;
const bin = join(root, 'packages/orm-npm/dist/bin/orm-gen.js');
// CASE_DEADLINE_MS는 case 하나의 기한이다. case는 orm-gen process 하나로 models를 만들고 읽는다.
const CASE_DEADLINE_MS = 30_000;
let failures = 0;
let current = '';
function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL ${current}: ${message}`); }
}

/** Generates models.ts from one source file and returns the member lines of each model interface. */
async function generate(source) {
  const work = await mkdtemp(join(tmpdir(), 'orm-ts-scan-'));
  try {
    const usage = join(work, 'usage.ts');
    await writeFile(usage, source);
    const out = join(work, 'models');
    const result = spawnSync(process.execPath, [bin, 'gen', '--schema', join(root, 'schema/bench.dbs'), '--out', out, '--scan', usage], { encoding: 'utf8', timeout: CASE_DEADLINE_MS });
    if (result.status !== 0) throw new Error(`orm-gen exit ${result.status}: ${result.stderr}`);
    const text = await readFile(join(out, 'models.ts'), 'utf8');
    const members = new Map();
    for (const match of text.matchAll(/export interface (\w+) \{\n([\s\S]*?)\n\}/g)) {
      members.set(match[1], match[2].split('\n').map(line => line.trim()).filter(line => !line.startsWith('/**')).map(line => line.replace(/[<(].*$/, '')));
    }
    return { text, members: name => members.get(name) ?? [] };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// The method names are written in the sources below only; the scan of the
// repository tests reads this file without types, and none of these calls
// has a model receiver here.

/** A method call of a class or object that is not a model adds no model method. */
async function nonModelCall() {
  const { members } = await generate(`
class Settings {
  name(value: string): string { return value; }
  isClose(): boolean { return false; }
  check(): boolean { return this.isClose() && this.name('x') !== ''; }
}
const other = { readCount: (n: number) => n, aliasGhost: () => 0, getGhost: () => 0 };
other.readCount(1);
other.aliasGhost();
other.getGhost();
export { Settings };
`);
  for (const model of ['Author', 'User', 'Service']) {
    for (const name of ['name', 'isClose', 'readCount', 'aliasGhost', 'getGhost']) check(!members(model).includes(name), `${model} declares ${name}`);
  }
}

/** Calls through new, bindings, typed parameters, functions, callbacks, rows and collections add methods to their own model. */
async function modelCalls() {
  const { members } = await generate(`
import { Author, User as Person } from './models/models.js';
import * as models from './models/models.js';
declare const db: unknown;
function load(): Author { return new Author().connect(db).seq(1); }
function typed(b: Author): void { b.geReadCount(3); }
const q = new Author().connect(db).gtReadCount(1);
q.ltReadCount(2);
load().leReadCount(4);
const author = () => new Author().connect(db);
author().neIsClose(true);
function user() { return new Person(); }
user().lkName('n');
new Person().connect(db).and(u => u.neName('x'));
new models.Service().ltSeq(5);
const rows = await new Author().connect(db).getsByUserSeq(1);
for (const row of rows) row.neUuid('u');
rows.map(row => row.lkPhotoUrl('c'));
(await new Author().connect(db).get())?.betweenStartDt(['a', 'b']);
const withWriter = await new Author().connect(db).relation(new Person().matchUserSeqWithSeq().aliasWriter()).get();
withWriter.getWriter();
export { typed };
`);
  for (const name of ['geReadCount', 'gtReadCount', 'ltReadCount', 'leReadCount', 'getsByUserSeq', 'neUuid', 'lkPhotoUrl', 'betweenStartDt', 'neIsClose']) {
    check(members('Author').includes(name), `Author lacks ${name}`);
  }
  for (const name of ['neName', 'lkName', 'matchUserSeqWithSeq', 'aliasWriter']) check(members('User').includes(name), `User lacks ${name}`);
  check(members('Author').includes('getWriter'), 'Author lacks getWriter');
  check(members('Service').includes('ltSeq'), 'Service lacks ltSeq');
  check(!members('Author').includes('ltSeq') && !members('User').includes('ltSeq'), 'ltSeq is declared beyond Service');
  check(!members('Author').includes('neName') && !members('Service').includes('neName'), 'neName is declared beyond User');
}

/**
 * The same sources and schema give the same models.ts however the scan and
 * output paths are written: relative, absolute, with `./` or with a trailing
 * slash.
 */
async function scanPathSpelling() {
  const work = await mkdtemp(join(tmpdir(), 'orm-ts-scan-paths-'));
  try {
    await mkdir(join(work, 'src'));
    await mkdir(join(work, 'tests'));
    await writeFile(join(work, 'src/example.ts'), `import { Author } from '../models/models.js';\ndeclare const db: unknown;\nnew Author().connect(db).gtReadCount(1);\n`);
    await writeFile(join(work, 'tests/example.ts'), `import { User } from '../models/models.js';\ndeclare const db: unknown;\nnew User().connect(db).neName('x');\n`);
    const spellings = {
      relative: ['src', 'tests', 'models'],
      absolute: [join(work, 'src'), join(work, 'tests'), join(work, 'models')],
      dot: ['./src', './tests', './models'],
      trailing_slash: ['src/', 'tests/', 'models/'],
    };
    const texts = {};
    for (const [name, [src, tests, out]] of Object.entries(spellings)) {
      await rm(join(work, 'models'), { recursive: true, force: true });
      const result = spawnSync(process.execPath, [bin, 'gen', '--schema', join(root, 'schema/bench.dbs'), '--out', out, '--scan', src, '--scan', tests], { cwd: work, encoding: 'utf8', timeout: CASE_DEADLINE_MS });
      if (result.status !== 0) throw new Error(`orm-gen ${name} exit ${result.status}: ${result.stderr}`);
      texts[name] = await readFile(join(work, 'models/models.ts'), 'utf8');
    }
    check(/export interface Author \{[^}]*\bgtReadCount\(/.test(texts.relative), 'Author lacks gtReadCount of src');
    check(/export interface User \{[^}]*\bneName\(/.test(texts.relative), 'User lacks neName of tests');
    for (const name of Object.keys(spellings)) check(texts[name] === texts.relative, `models.ts of the ${name} paths differs from the relative paths`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const cases = { non_model_call: nonModelCall, model_calls: modelCalls, scan_path_spelling: scanPathSpelling };
const selected = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(cases);
for (const name of selected) {
  const run = cases[name];
  if (run === undefined) throw new Error(`unknown case ${name}`);
  current = name;
  const before = failures;
  const passed = await runCase(`generate-scan/${name}`, CASE_DEADLINE_MS, async () => {
    await run();
    if (failures > before) throw new Error(`${failures - before} check(s) failed; each FAIL line above names one`);
  });
  if (!passed && failures === before) failures++;
}
if (failures > 0) process.exitCode = 1;
