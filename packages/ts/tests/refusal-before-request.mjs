// The refusal of the errors vector of tests/conformance/vectors.json before any request (DSL-10, DSL-19, DSL-47, DSL-67,
// DSL-96, DSL-98, DSL-123, PRT-14): each chain runs on a SQLite file that has no table with a statement subscriber, and
// tsc accepts the chain with its promise and refuses a use that reads the promise as rows. The spec makes each refusal a
// returned error, so tsc does not refuse the chain itself. Each use of tsc is a file of its own.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DATABASE, PROCESS, caseTest } from '../../../tests/testcase.mts';
import { Author, User, connect } from '../dist/index.js';

const source = fileURLToPath(new URL('../src/index.js', import.meta.url));
const tsc = fileURLToPath(new URL('../../../node_modules/.bin/tsc', import.meta.url));
const vectors = new URL('../../../tests/conformance/vectors.sqlite.json', import.meta.url);

const chains = [
  { name: 'missing connector', source: `author().name('a').isClose(true).gets()`, run: author => author().name('a').isClose(true).gets() },
  { name: 'dangling connector', source: `author().name('a').and().gets()`, run: author => author().name('a').and().gets() },
  { name: 'empty list', source: `author().seq([]).gets()`, run: author => author().seq([]).gets() },
  { name: 'no connection', source: `new Author().name('a').gets()`, run: () => new Author().name('a').gets() },
  { name: 'lock outside a transaction', source: `author().forUpdate().gets()`, run: author => author().forUpdate().gets() },
  { name: 'join child with connection', source: `author().joinUserSeqWithSeq(new User().connect(db)).gets()`, run: (author, db) => author().joinUserSeqWithSeq(new User().connect(db)).gets() },
  { name: 'page with limit', source: `author().limit(0, 1).getsPage(1, 10)`, run: author => author().limit(0, 1).getsPage(1, 10) },
  { name: 'relation with limit', source: `author().relation(new User().matchUserSeqWithSeq().limit(0, 1)).getsBySeq(42)`, run: author => author().relation(new User().matchUserSeqWithSeq().limit(0, 1)).getsBySeq(42) },
  { name: 'unjoined model placement', source: `author().name('a').or(new User()).gets()`, run: author => author().name('a').or(new User()).gets() },
];

// Requirements: DSL-10, DSL-19, DSL-47, DSL-67, DSL-96, DSL-98, DSL-123, PRT-14.
caseTest('each chain of the errors vector is refused before any request', DATABASE, async () => {
  const vector = JSON.parse(await readFile(vectors, 'utf8')).vectors.find(v => v.name === 'errors');
  assert.equal(vector.chain, chains.map(chain => chain.name).join(', '));
  assert.deepEqual(vector.expect.statements, []);
  const dir = await mkdtemp(path.join(tmpdir(), 'orm-refusal-'));
  const db = await connect(`sqlite://${path.join(dir, 'refusal.sqlite')}`, { aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key' });
  try {
    const statements = [];
    db.subscribe(event => { statements.push(event.sql); });
    const author = () => new Author().connect(db);
    // A chain that the spec does not refuse reaches the database, so an empty statement list means no request.
    await assert.rejects(author().seq(42).gets());
    assert.notDeepEqual(statements, []);
    for (const [i, chain] of chains.entries()) {
      statements.length = 0;
      await assert.rejects(chain.run(author, db), error => {
        assert.equal(error.code, vector.expect.result[i], `${chain.name}: ${error}`);
        return true;
      }, chain.name);
      assert.deepEqual(statements, [], `${chain.name} sent a statement before its refusal`);
    }
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/** The tsc diagnostics of each use file, by the index of its use; tsc runs once for all of them. */
async function diagnostics(uses) {
  const dir = await mkdtemp(path.join(tmpdir(), 'orm-refusal-types-'));
  try {
    const files = uses.map((_, i) => `use${i}.ts`);
    for (const [i, use] of uses.entries()) {
      await writeFile(path.join(dir, files[i]), `import { Author, User, Db } from ${JSON.stringify(source)};\ndeclare const db: Db;\nconst author = () => new Author().connect(db);\nexport const refs = [author, User];\n${use}\n`);
    }
    await writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: true, types: [] },
      files,
    }));
    let output = '';
    try {
      await promisify(execFile)(tsc, ['-p', path.join(dir, 'tsconfig.json'), '--pretty', 'false']);
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    }
    const byUse = uses.map(() => []);
    for (const line of output.split('\n')) {
      const m = /use(\d+)\.ts\(\d+,\d+\): (error .*)$/.exec(line);
      if (m !== null) byUse[Number(m[1])].push(m[2]);
      else if (line.includes('error TS')) throw new Error(`tsc reported an error outside the use files: ${line}`);
    }
    return byUse;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Requirements: DSL-10, DSL-19, DSL-47, DSL-67, DSL-96, DSL-98, DSL-123, PRT-14.
caseTest('tsc accepts each chain of the errors vector as a promise and refuses it as rows', PROCESS, async () => {
  const uses = chains.flatMap(chain => [
    `export const rows: Promise<unknown> = ${chain.source};`,
    `export const rows: Author[] = ${chain.source};`,
  ]);
  const byUse = await diagnostics(uses);
  const wrong = [];
  for (const [i, chain] of chains.entries()) {
    const accepted = byUse[2 * i];
    const refused = byUse[2 * i + 1];
    if (accepted.length > 0) wrong.push(`${chain.source} does not compile as a promise: ${accepted.join('; ')}`);
    if (refused.length !== 1 || !refused[0].includes('TS2')) wrong.push(`${chain.source} read as rows must be one type error, got: ${refused.join('; ')}`);
  }
  assert.deepEqual(wrong, []);
});
