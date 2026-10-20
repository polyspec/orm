// Generator scan test: `orm-gen gen --scan` declares the chain methods that
// the sources call on models, each on the model the receiver resolves to, and
// nothing for a call whose receiver is not a model.
// Usage: node packages/ts/tests/generate-scan.mjs [case ...] (after npm run typescript:build)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest } from '../../../tests/testcase.mts';

const root = new URL('../../..', import.meta.url).pathname;
const bin = join(root, 'packages/ts/dist/bin/orm-gen.js');
// CASE_DEADLINE_MS is the deadline of one case. A case creates and reads the models with one orm-gen process.
const CASE_DEADLINE_MS = 30_000;
let failures = 0;
let current = '';
function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL ${current}: ${message}`); }
}

/** Generates models.ts from one source file and returns the declared chain methods of each model class. */
async function generate(source) {
  const work = await mkdtemp(join(tmpdir(), 'orm-ts-scan-'));
  try {
    const usage = join(work, 'usage.ts');
    await writeFile(usage, source);
    const out = join(work, 'models');
    const result = spawnSync(process.execPath, [bin, 'gen', '--set', join(root, 'contracts/fixtures/bench/dbspec-set.json'), '--out', out, '--scan', usage], { encoding: 'utf8', timeout: CASE_DEADLINE_MS });
    if (result.status !== 0) throw new Error(`orm-gen exit ${result.status}: ${result.stderr}`);
    const text = await readFile(join(out, 'models.ts'), 'utf8');
    const members = new Map();
    for (const match of text.matchAll(/export class (\w+) extends Model \{\n([\s\S]*?)\n\}\n/g)) {
      members.set(match[1], [...match[2].matchAll(/^  declare (\w+):/gm)].map(declared => declared[1]));
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
// The test of DSL-40 (docs/spec).
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

/**
 * Calls through new, bindings, typed parameters, functions, callbacks (and, or, not, andNot, orNot), rows and collections
 * add methods to their own model.
 */
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
new Author().connect(db).not(a => a.gtServiceSeq(1)).andNot(a => a.lbName('n')).orNot(a => a.neIsDisplay(true));
new models.Service().ltSeq(5);
const rows = await new Author().connect(db).getsByUserSeq(1);
for (const row of rows) row.neUuid('u');
rows.map(row => row.lkPhotoUrl('c'));
(await new Author().connect(db).get())?.betweenStartDt(['a', 'b']);
const withWriter = await new Author().connect(db).relation(new Person().matchUserSeqWithSeq().aliasWriter()).get();
withWriter.getWriter();
export { typed };
`);
  for (const name of ['geReadCount', 'gtReadCount', 'ltReadCount', 'leReadCount', 'getsByUserSeq', 'neUuid', 'lkPhotoUrl', 'betweenStartDt', 'neIsClose', 'gtServiceSeq', 'lbName', 'neIsDisplay']) {
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
      const result = spawnSync(process.execPath, [bin, 'gen', '--set', join(root, 'contracts/fixtures/bench/dbspec-set.json'), '--out', out, '--scan', src, '--scan', tests], { cwd: work, encoding: 'utf8', timeout: CASE_DEADLINE_MS });
      if (result.status !== 0) throw new Error(`orm-gen ${name} exit ${result.status}: ${result.stderr}`);
      texts[name] = await readFile(join(work, 'models/models.ts'), 'utf8');
    }
    const declares = (model, method) => new RegExp(`export class ${model} extends Model \\{\\n(?:(?!\\n\\}\\n)[\\s\\S])*\\n  declare ${method}:`).test(texts.relative);
    check(declares('Author', 'gtReadCount'), 'Author lacks gtReadCount of src');
    check(declares('User', 'neName'), 'User lacks neName of tests');
    for (const name of Object.keys(spellings)) check(texts[name] === texts.relative, `models.ts of the ${name} paths differs from the relative paths`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Runs orm-gen on one source file that must stop generation; returns its exit status and standard error. */
async function generateRefused(source) {
  const work = await mkdtemp(join(tmpdir(), 'orm-ts-scan-'));
  try {
    const usage = join(work, 'usage.ts');
    await writeFile(usage, source);
    const result = spawnSync(process.execPath, [bin, 'gen', '--set', join(root, 'contracts/fixtures/bench/dbspec-set.json'), '--out', join(work, 'models'), '--scan', usage], { encoding: 'utf8', timeout: CASE_DEADLINE_MS });
    return { status: result.status, stderr: result.stderr };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** A relation alias that starts with a chain prefix (Match, Join, Possible, New) still declares its getter on the parent. */
async function aliasMatchGetter() {
  const { members } = await generate(`
import { Author, User } from './models/models.js';
declare const db: unknown;
const a = await new Author().connect(db).relation(new User().matchUserSeqWithSeq().aliasMatch()).relation(new User().matchUserSeqWithSeq().aliasWriter()).get();
a.getMatch();
a.getWriter();
const child = new User().matchUserSeqWithSeq().aliasMatchup();
const rows = await new Author().connect(db).relations(child).gets();
for (const row of rows) row.getMatchup();
rows.map(r => r.getJoin());
class Repo { list(): Promise<Author | null> { return new Author().connect(db).relation(new User().matchUserSeqWithSeq().aliasJoin()).get(); } }
const r2 = await new Repo().list(); r2?.getMatch();
export {};
`);
  check(members('User').includes('aliasMatch'), 'User lacks aliasMatch');
  check(members('Author').includes('getWriter'), 'Author lacks getWriter');
  for (const n of ['getMatch', 'getMatchup', 'getJoin']) check(members('Author').includes(n), `Author lacks ${n}`);
}

/**
 * The alias of a relation nested in a relation attaches its getter to the model it aliases on, and a receiver typed through
 * a getter's generic argument resolves to that model (consumer: OrdersheetStore.getMatch).
 */
async function nestedAliasGetter() {
  const { members } = await generate(`
import { Author, User } from './models/models.js';
declare const db: unknown;
await new Author().connect(db).relation(new User().matchUserSeqWithSeq().aliasWriter().relation(new Author().matchSeqWithUserSeq().aliasMatch())).gets();
export function read(rows: Iterable<Author>): void {
  for (const row of rows) {
    const writer = row.getWriter<User | null>();
    writer?.getMatch<Author | null>();
  }
}
`);
  check(members('Author').includes('getWriter'), 'Author lacks getWriter');
  check(members('User').includes('getMatch'), 'User lacks getMatch of the nested alias');
}

/** A scanned getter call that no alias, new or addColumn call attaches stops generation, naming the model and the method. */
async function unattachedGetter() {
  const { status, stderr } = await generateRefused(`
import { Author, User } from './models/models.js';
declare const db: unknown;
const rows = await new Author().connect(db).relation(new User().matchUserSeqWithSeq().aliasWriter()).gets();
for (const row of rows) row.getWriter<User | null>()?.getGhost();
export {};
`);
  check(status !== 0, 'orm-gen accepted an unattached getter');
  check(stderr.includes('User.getGhost()'), `the refusal does not name User.getGhost(): ${stderr}`);
}

/**
 * Generates models.ts of member.dbs, which uses core.dbs as an external document, with --scan of one source; returns the
 * declared chain methods of each model class, as generate does.
 */
async function generateExternal(source) {
  const work = await mkdtemp(join(tmpdir(), 'orm-ts-scan-external-'));
  try {
    const external = join(root, 'contracts/fixtures/external');
    await mkdir(join(work, 'external/app'), { recursive: true });
    await mkdir(join(work, 'external/core'), { recursive: true });
    await writeFile(join(work, 'external/app/member.dbs'), await readFile(join(external, 'member.dbs'), 'utf8'));
    await writeFile(join(work, 'external/core/core.dbs'), await readFile(join(external, 'core.dbs'), 'utf8'));
    const set = join(work, 'external/app/dbspec-set.json');
    await writeFile(set, JSON.stringify({ schema: 1, documents: ['member.dbs'], external: ['../core/core.dbs'] }) + '\n');
    const usage = join(work, 'usage.ts');
    await writeFile(usage, source);
    const out = join(work, 'models');
    const result = spawnSync(process.execPath, [bin, 'gen', '--set', set, '--out', out, '--scan', usage], { encoding: 'utf8', timeout: CASE_DEADLINE_MS });
    if (result.status !== 0) throw new Error(`orm-gen exit ${result.status}: ${result.stderr}`);
    const text = await readFile(join(out, 'models.ts'), 'utf8');
    const members = new Map();
    for (const match of text.matchAll(/export class (\w+) extends Model \{\n([\s\S]*?)\n\}\n/g)) {
      members.set(match[1], [...match[2].matchAll(/^  declare (\w+):/gm)].map(declared => declared[1]));
    }
    return { text, members: name => members.get(name) ?? [] };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** A relation to an entity of a used external document attaches its getter, as a relation to an entity of the set does. */
async function externalGetter() {
  await generateExternal(`
import { ExtPost } from './models/models.js';
declare const db: unknown;
const rows = await new ExtPost().relation(new ExtAudit().connect(db).matchAuditSeqWithSeq()).gets();
for (const row of rows) row.getExtAuditModel();
export {};
`);
}

/**
 * A name is typed by its latest assignment in its own scope: a nested function that reassigns row to a value the scan
 * cannot type does not leave the outer ServiceMember on the call, and a call on an Author row is attributed to Author.
 */
async function scopeBinding() {
  const { members } = await generate(`
import { Author, ServiceMember } from './models/models.js';
declare const db: unknown;
declare function loadRow(db: unknown): unknown;
export function read(): void {
  let row = new ServiceMember().connect(db);
  const write = (): void => { row = loadRow(db); };
  write();
  row.getIsClose();
}
export function author(): void {
  const row = new Author().connect(db);
  row.getIsClose();
}
`);
  check(!members('ServiceMember').includes('getIsClose'), 'ServiceMember declares getIsClose');
}

/**
 * A name that may hold two models gets the call on each of them: an if with two branches, a switch, a try and a loop each
 * bind row to a ServiceMember on one path, and getIsClose, which only Author has as a column getter, is refused for it.
 */
/** A name that may hold two models gets the call on each of them: an if, a switch, a try and a loop each bind row to a ServiceMember on one path. */
async function mayHoldTwoModels() {
  const sources = {
    branches: `
import { Author, ServiceMember } from './models/models.js';
declare const db: unknown;
export function read(flag: boolean): void {
  let row;
  if (flag) row = new ServiceMember().connect(db); else row = new Author().connect(db);
  row.gtSeq(1);
}
`,
    switch: `
import { Author, ServiceMember } from './models/models.js';
declare const db: unknown;
export function read(k: number): void {
  let row;
  switch (k) { case 1: row = new ServiceMember().connect(db); break; default: row = new Author().connect(db); }
  row.gtSeq(1);
}
`,
    try: `
import { Author, ServiceMember } from './models/models.js';
declare const db: unknown;
export function read(): void {
  let row;
  try { row = new ServiceMember().connect(db); } catch (error) { row = new Author().connect(db); }
  row.gtSeq(1);
}
`,
    loop: `
import { Author, ServiceMember } from './models/models.js';
declare const db: unknown;
export function read(more: boolean): void {
  let row = new Author().connect(db);
  while (more) { row.gtSeq(1); row = new ServiceMember().connect(db); }
}
`,
  };
  for (const [construct, source] of Object.entries(sources)) {
    // Each class of the name declares the chain method, so the call is recorded for each of them.
    const { members } = await generate(source);
    for (const model of ['Author', 'ServiceMember']) check(members(model).includes('gtSeq'), `${construct}: ${model} lacks gtSeq`);
  }
}

/**
 * A getter on a name that may hold two models is refused only when no possible class has it, and the branches, the try
 * finalizer, the loop entry and the unbound declaration contribute the models they can hold. Author has is_close and User does not.
 */
async function possibleClasses() {
  const head = "import { Author, User } from './models/models.js';\ndeclare const db: unknown;\ndeclare const flag: boolean;\ndeclare const xs: number[];\n";
  const cases = {
    group_if: ['let row = new Author().connect(db); if (flag) row = new User().connect(db); row.getIsClose();', 'accepted'],
    branch_returns: ['export function read(): void { let row = new Author().connect(db); if (flag) { row = new User().connect(db); return; } row.getIsClose(); }', 'accepted'],
    finally_outcomes: ['export function read(): void { let row = new Author().connect(db); try { row = new User().connect(db); } finally { row.getIsClose(); } }', 'accepted'],
    zero_iterations: ['export function read(): void { let row = new Author().connect(db); for (const x of xs) { row = new User().connect(db); } row.getIsClose(); }', 'accepted'],
    unbound_declaration: ['export function read(): void { let row; if (flag) row = new User().connect(db); row.getIsClose(); }', 'refused'],
  };
  for (const [construct, [body, expected]] of Object.entries(cases)) {
    const result = await generateRefused(head + body + '\nexport {};\n');
    if (expected === 'accepted') check(result.status === 0, `${construct}: the call is refused: ${result.stderr}`);
    else check(result.status !== 0 && result.stderr.includes('User.getIsClose()'), `${construct}: User.getIsClose() is not refused: status ${result.status}: ${result.stderr}`);
  }
}

/**
 * A callback parameter annotated with another class is not the receiver: the untyped first parameter of a model callback gets the
 * model, a typed one gets the class it names.
 */
async function callbackParameters() {
  const head = "import { Author } from './models/models.js';\ndeclare const db: unknown;\ninterface Holder { getOwner(): void }\n";
  const other = await generateRefused(head + 'new Author().connect(db).and((module: Holder) => module.getOwner());\nexport {};\n');
  check(other.status === 0, `a parameter annotated with another class is recorded against the receiver: ${other.stderr}`);
  const own = await generateRefused(head + 'new Author().connect(db).and((module: Author) => module.getOwner());\nexport {};\n');
  check(own.status !== 0 && own.stderr.includes('Author.getOwner()'), `a parameter annotated with Author is not recorded against Author: status ${own.status}: ${own.stderr}`);
}

/**
 * A call belongs to the set whose generated module the class is imported from: a class of the same name imported from another
 * set's output, by name or through a namespace, is not this set's model, so its calls declare and refuse nothing here.
 */
// Requirements: DSL-151.
async function importedSet() {
  const work = await mkdtemp(join(tmpdir(), 'orm-ts-scan-import-'));
  try {
    await mkdir(join(work, 'src'));
    await mkdir(join(work, 'main'));
    // The output of another set: orm-gen wrote it from another manifest, whose hash it names.
    await writeFile(join(work, 'main/models.ts'), `// Code generated by orm-gen; DO NOT EDIT.\nexport const MANIFEST_HASH = 'sha256:${'0'.repeat(64)}';\nexport class Author { [name: string]: (...args: unknown[]) => Author }\n`);
    await writeFile(join(work, 'src/other.ts'), `import { Author } from '../main/models.js';\nimport * as main from '../main/models';\ndeclare const db: unknown;\nnew Author().connect(db).gtReadCount(1);\nnew Author().getGhost();\nnew main.Author().ltSeq(1);\n`);
    await writeFile(join(work, 'src/own.ts'), `import { User } from '../out/models.js';\ndeclare const db: unknown;\nnew User().connect(db).neName('x');\n`);
    const result = spawnSync(process.execPath, [bin, 'gen', '--set', join(root, 'contracts/fixtures/bench/dbspec-set.json'), '--out', 'out', '--scan', 'src'], { cwd: work, encoding: 'utf8', timeout: CASE_DEADLINE_MS });
    check(result.status === 0, `a call on another set's Author is taken as this set's: status ${result.status}: ${result.stderr}`);
    if (result.status !== 0) return;
    const text = await readFile(join(work, 'out/models.ts'), 'utf8');
    const declares = (model, method) => new RegExp(`export class ${model} extends Model \\{\\n(?:(?!\\n\\}\\n)[\\s\\S])*\\n  declare ${method}:`).test(text);
    check(!declares('Author', 'gtReadCount') && !declares('Author', 'ltSeq'), "Author declares a method that only another set's Author is called with");
    check(declares('User', 'neName'), 'User lacks neName of its own import');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * A receiver held in a variable resolves through the variable's initializer and its reassignments to its class, as the checker
 * types the variable: a `let` initialized from a chain on an imported class and reassigned from its own chain in a conditional
 * expression still holds that class, so the calls on it after each reassignment are its calls.
 */
// Requirements: DSL-151.
async function reassignedVariable() {
  const { members } = await generate(`
import { Author } from './models/models.js';
declare const db: unknown;
declare const limit: number | null;
let page = new Author().connect(db).addAllColumns();
let conditions = 0;
if (limit !== null) {
  page = conditions === 0 ? page.gtReadCount(limit) : page.andGtReadCount(limit);
  conditions += 1;
}
if (limit !== null) page = conditions === 0 ? page.ltSeq(limit) : page.andLtSeq(limit);
page.orderBySeqDesc();
`);
  for (const name of ['gtReadCount', 'andGtReadCount', 'ltSeq', 'andLtSeq']) check(members('Author').includes(name), `Author lacks ${name} called on a reassigned variable`);
}

/** The base method names of the generator are the public methods of the runtime Model, which every generated model inherits. */
async function baseMethodsMatchModel() {
  const { baseMethods } = await import('../dist/generate/typescript.js');
  const { Model } = await import('../dist/model.js');
  const runtime = Object.getOwnPropertyNames(Model.prototype).filter(name => !name.startsWith('_')).sort();
  const listed = [...baseMethods].sort();
  const missing = runtime.filter(name => !listed.includes(name));
  const extra = listed.filter(name => !runtime.includes(name));
  check(missing.length === 0 && extra.length === 0, `baseMethods differs from the Model methods: missing ${JSON.stringify(missing)}, extra ${JSON.stringify(extra)}`);
}

/** A file of a scanned directory that does not parse stops the generation, writes nothing, and names the file and position. */
// Requirements: DSL-152.
async function unparsableFile() {
  const work = await mkdtemp(join(tmpdir(), 'orm-ts-scan-parse-'));
  try {
    await mkdir(join(work, 'src'));
    await writeFile(join(work, 'src/usage.ts'), 'export const x = 1;\n');
    await writeFile(join(work, 'src/broken.ts'), 'export const x = 1;\nfunction (\n');
    const result = spawnSync(process.execPath, [bin, 'gen', '--set', join(root, 'contracts/fixtures/bench/dbspec-set.json'), '--out', 'out', '--scan', 'src'], { cwd: work, encoding: 'utf8', timeout: CASE_DEADLINE_MS });
    check(result.status !== 0, `an unparsable file is skipped: status ${result.status}`);
    check(result.stderr.includes('broken.ts:2:10: does not parse'), `the error does not name the file and position: ${result.stderr}`);
    check(!existsSync(join(work, 'out')), 'the failed generation wrote its output');
    // A parse error on the first line, which no line break precedes, is at its own column of line 1.
    await writeFile(join(work, 'src/broken.ts'), 'const = 1;\n');
    const first = spawnSync(process.execPath, [bin, 'gen', '--set', join(root, 'contracts/fixtures/bench/dbspec-set.json'), '--out', 'out', '--scan', 'src'], { cwd: work, encoding: 'utf8', timeout: CASE_DEADLINE_MS });
    check(first.stderr.includes('broken.ts:1:7: does not parse'), `the error does not name line 1 and its column: ${first.stderr}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const cases = { non_model_call: nonModelCall, base_methods_match_model: baseMethodsMatchModel, model_calls: modelCalls, scan_path_spelling: scanPathSpelling, alias_match_getter: aliasMatchGetter, nested_alias_getter: nestedAliasGetter, unattached_getter: unattachedGetter, external_getter: externalGetter, scope_binding: scopeBinding, may_hold_two_models: mayHoldTwoModels, possible_classes: possibleClasses, callback_parameters: callbackParameters, imported_set: importedSet, reassigned_variable: reassignedVariable, unparsable_file: unparsableFile };
const selected = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(cases);
for (const name of selected) {
  const run = cases[name];
  if (run === undefined) throw new Error(`unknown case ${name}`);
  caseTest(`generate-scan/${name}`, CASE_DEADLINE_MS, async () => {
    const before = failures;
    current = name;
    await run();
    if (failures > before) throw new Error(`${failures - before} check(s) failed; each FAIL line above names one`);
  });
}
if (failures > 0) process.exitCode = 1;
