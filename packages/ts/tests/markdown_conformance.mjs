// Runs the markdown IR executor conformance (tests/markdown/README.md) with the TypeScript client.
// Runs every case of tests/markdown/cases.json in order, on one server of the flowmark build that FLOWMARK points to,
// and compares each result with expect. That build must be the build pinned by tests/markdown/flowmark.version,
// and it fails if the build is missing or different (it does not skip). Later cases read the corpus state created by earlier cases,
// so cases after the first failure fail because of that failure.
//
// Usage: FLOWMARK=<flowmark> node --conditions=orm-test packages/ts/tests/markdown_conformance.mjs
// (after npm run typescript:build; make markdown-conformance-check supplies FLOWMARK)
//
// The IR answer cases of contracts/fixtures/ir_answers.json run through ir_answers.mjs without flowmark. The two files
// share the case functions of markdown_cases.mjs.
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { after, before } from 'node:test';
import { DATABASE, caseTest } from '../../../tests/testcase.mts';
import { OrmError } from '../dist/index.js';
import { connect } from '../dist/models/markdown_fixture/models.js';
import { conformanceCases, normalize } from './markdown_cases.mjs';

const run = promisify(execFile);
const conformanceDir = fileURLToPath(new URL('../../../tests/markdown/', import.meta.url));
// The module path, which must be the main module of the build that FLOWMARK points to.
const flowmarkModule = 'github.com/polyspec/flowmark/packages/go';

/** A case of cases.json: an id that is non-empty and unique, and expect. */
async function loadCases() {
  const doc = JSON.parse(await readFile(path.join(conformanceDir, 'cases.json'), 'utf8'));
  const seen = new Set();
  for (const c of doc.cases) {
    if (typeof c.id !== 'string' || c.id === '' || seen.has(c.id)) throw new Error(`cases.json: case id ${JSON.stringify(c.id)} is empty or repeated`);
    seen.add(c.id);
  }
  return doc.cases;
}

/**
 * The flowmark binary that FLOWMARK points to. The main module of the build information read by `go version -m` must be the flowmark module
 * at the flowmark.version pin, or it fails.
 */
async function pinnedFlowmark() {
  const pin = (await readFile(path.join(conformanceDir, 'flowmark.version'), 'utf8')).trim();
  const bin = process.env.FLOWMARK ?? '';
  if (bin === '') throw new Error(`FLOWMARK is not set; run make markdown-conformance-check, which passes the path of the flowmark ${pin} pinned in tests/markdown/flowmark.version`);
  let info;
  try {
    info = (await run('go', ['version', '-m', bin])).stdout;
  } catch (error) {
    throw new Error(`FLOWMARK ${bin} is no Go build (${String(error.stderr ?? error.message).trim()}); run make orm-install-flowmark, which installs the flowmark ${pin} pinned in tests/markdown/flowmark.version`, { cause: error });
  }
  const main = /^\tmod\t(\S+)\t(\S+)/m.exec(info);
  const revision = pin.slice(pin.lastIndexOf('-') + 1);
  const checkout = main?.[2] === '(devel)' && revision.length === 12
    && new RegExp(`^\\tbuild\\tvcs\\.revision=${revision}`, 'm').test(info)
    && /^\tbuild\tvcs\.modified=false$/m.test(info);
  if (main === null || main[1] !== flowmarkModule || (main[2] !== pin && !checkout)) {
    throw new Error(`FLOWMARK ${bin} is ${JSON.stringify(main?.[1] ?? '')} ${JSON.stringify(main?.[2] ?? '')}, not the pinned ${flowmarkModule} ${pin}; run make orm-install-flowmark, or give FLOWMARK a build of a flowmark checkout at that revision`);
  }
  return bin;
}

const listening = /^\[serve\] listening on 127\.0\.0\.1:([0-9]+) for the corpus (.+)$/;

/**
 * Installs corpus/ as a new corpus and starts its server. The stop of the returned served stops the server, waits for it to end, then deletes the directory.
 */
async function serve(bin, step) {
  const s = { bin, corpus: 'conformance', root: await mkdtemp(path.join(tmpdir(), 'orm-markdown-')), server: undefined, stderr: '' };
  s.dir = path.join(s.root, s.corpus);
  s.stop = async () => {
    if (s.server !== undefined && s.server.exitCode === null && s.server.signalCode === null) {
      const exited = new Promise(resolve => s.server.once('exit', resolve));
      s.server.kill('SIGINT');
      await exited;
    }
    await rm(s.root, { recursive: true, force: true });
  };
  try {
    await mkdir(path.join(s.dir, 'dbspec'), { recursive: true });
    await writeFile(path.join(s.dir, 'dbspec', 'conformance.dbs'), await readFile(path.join(conformanceDir, 'corpus', 'dbspec', 'conformance.dbs')));
    await writeFile(path.join(s.dir, 'dbspec', 'dbspec-set.json'), await readFile(path.join(conformanceDir, 'corpus', 'dbspec', 'dbspec-set.json')));
    step(`flowmark install ${s.dir}`);
    try { await run(bin, ['install', s.dir]); } catch (error) { throw new Error(`flowmark install: ${error.message}\n${error.stdout ?? ''}${error.stderr ?? ''}`, { cause: error }); }
    step(`flowmark serve ${s.dir} --port 0`);
    s.server = spawn(bin, ['serve', s.dir, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    s.server.stderr.setEncoding('utf8').on('data', chunk => { s.stderr += chunk; });
    const lines = createInterface({ input: s.server.stdout });
    const line = await new Promise(resolve => {
      lines.once('line', resolve);
      s.server.once('exit', () => resolve(''));
    });
    lines.close();
    // The server keeps writing to stdout, so the remaining output is read and discarded.
    s.server.stdout.resume();
    const m = listening.exec(line);
    if (m === null || m[2] !== s.corpus) throw new Error(`flowmark serve printed ${JSON.stringify(line)}, not its listening line; stderr:\n${s.stderr}`);
    s.port = m[1];
    s.token = JSON.parse(await readFile(path.join(s.dir, '.flowmark', 'server.json'), 'utf8')).token;
    s.dsn = (corpus, token) => `markdown://127.0.0.1:${s.port}/${corpus}?token=${token}`;
    return s;
  } catch (error) {
    await s.stop();
    throw error;
  }
}


let served;

function withServerDiagnostics(error, s) {
  const server = s?.server;
  if (server === undefined) return error;
  const status = server.exitCode !== null
    ? `exited with code ${server.exitCode}`
    : server.signalCode !== null
      ? `ended with signal ${server.signalCode}`
      : 'is still running';
  const stderr = s.stderr.trim();
  return new Error(`${error instanceof Error ? error.message : String(error)}\nflowmark server ${status}${stderr === '' ? '' : `; stderr:\n${stderr}`}`, { cause: error });
}

const all = await loadCases();
const ids = all.map(c => c.id);
const missing = ids.filter(id => !Object.hasOwn(conformanceCases, id));
const extra = Object.keys(conformanceCases).filter(id => !ids.includes(id)).sort();
if (missing.length > 0 || extra.length > 0) throw new Error(`cases.json and the TypeScript cases differ: missing in TypeScript ${JSON.stringify(missing)}, not in cases.json ${JSON.stringify(extra)}`);

let stopped;
// The committed model must equal the output generated from the corpus catalog and from the scan of this file; that is
// the precondition of every case, so a failure fails the file before the server starts.
before(async t => {
  t.diagnostic('orm-gen gen --check of src/models/markdown_fixture');
  try {
    await run(process.execPath, ['dist/bin/orm-gen.js', 'gen', '--set', '../../tests/markdown/corpus/dbspec/dbspec-set.json', '--out', 'src/models/markdown_fixture', '--scan', 'tests/markdown_cases.mjs', '--check'], { cwd: fileURLToPath(new URL('..', import.meta.url)) });
  } catch (error) {
    throw new Error(`src/models/markdown_fixture differs from the generator output; regenerate it with the same orm-gen command without --check: ${error.stdout ?? ''}${error.stderr ?? error.message}`, { cause: error });
  }
  const bin = await pinnedFlowmark();
  served = await serve(bin, text => t.diagnostic(text));
});
// Each case is one test named by its id. A later case reads the corpus state that the cases before it made, so after
// a failure the later cases fail because of the case that stopped them.
for (const c of all) {
  caseTest(c.id, DATABASE, async () => {
    if (stopped !== undefined) throw new Error(`not run: ${stopped} failed, and this case reads the corpus state it leaves`);
    let db;
    try {
      let got;
      try {
        db = await connect(served.dsn(served.corpus, served.token));
        got = await conformanceCases[c.id]({ ...served, db });
      } catch (error) {
        if (!(error instanceof OrmError)) throw new Error(`${c.id} failed without an orm code: ${error?.stack ?? error}`, { cause: error });
        got = { error: error.code, message: error.message };
        if (isDeepStrictEqual({ error: got.error }, c.expect)) return;
        throw new Error(`${c.id}: got ${JSON.stringify(got)}, want ${JSON.stringify(c.expect)}`, { cause: error });
      }
      const actual = normalize(got);
      if (!isDeepStrictEqual(actual, c.expect)) throw new Error(`${c.id}: got ${JSON.stringify(actual)}, want ${JSON.stringify(c.expect)}`);
    } catch (error) {
      stopped = c.id;
      throw withServerDiagnostics(error, served);
    } finally {
      if (db !== undefined) await db.close();
    }
  });
}
after(async () => { if (served !== undefined) await served.stop(); });
