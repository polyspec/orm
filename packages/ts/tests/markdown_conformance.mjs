// markdown IR executor conformance(tests/markdown/README.md)를 TypeScript client로 실행한다.
// tests/markdown/cases.json의 모든 case를 그 순서대로, FLOWMARK가 가리키는 flowmark build의 server
// 하나에서 실행하고 각 결과를 expect와 비교한다. 그 build는 tests/markdown/flowmark.version이 고정한
// build여야 하고, 없거나 다른 build이면 실패한다(건너뛰지 않는다). 뒤의 case는 앞 case가 만든 corpus
// 상태를 읽으므로 첫 실패 뒤의 case는 그 실패를 이유로 실패한다.
//
// 사용: FLOWMARK=<flowmark> node --conditions=orm-test packages/ts/tests/markdown_conformance.mjs
// (npm run typescript:build 뒤; make markdown-conformance-check가 FLOWMARK를 준다)
//
// contracts/fixtures/ir_answers.json의 IR answer case는 flowmark 없이 ir_answers.mjs가 실행한다. 두 file은
// case 함수를 markdown_cases.mjs에서 함께 쓴다.
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { after } from 'node:test';
import { DATABASE, PROCESS, caseTest, cases } from '../../../tests/testcase.mts';
import { OrmError } from '../dist/index.js';
import { connect } from '../dist/models/markdown_fixture/models.js';
import { conformanceCases, normalize } from './markdown_cases.mjs';

const run = promisify(execFile);
const conformanceDir = fileURLToPath(new URL('../../../tests/markdown/', import.meta.url));
// FLOWMARK가 가리키는 build의 main module이어야 하는 module path다.
const flowmarkModule = 'github.com/polyspec/flowmark';

const runner = cases();

/** cases.json의 case다: 비지 않고 겹치지 않는 id와 expect. */
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
 * FLOWMARK가 가리키는 flowmark binary다. `go version -m`이 읽은 build 정보의 main module이 flowmark module의
 * flowmark.version 판이 아니면 실패한다.
 */
async function pinnedFlowmark() {
  const pin = (await readFile(path.join(conformanceDir, 'flowmark.version'), 'utf8')).trim();
  const bin = process.env.FLOWMARK ?? '';
  if (bin === '') throw new Error(`FLOWMARK is not set; run make markdown-conformance-check, which passes the path of the flowmark ${pin} pinned in tests/markdown/flowmark.version`);
  let info;
  try {
    info = (await run('go', ['version', '-m', bin])).stdout;
  } catch (error) {
    throw new Error(`FLOWMARK ${bin} is no Go build (${String(error.stderr ?? error.message).trim()}); run make install-flowmark, which installs the flowmark ${pin} pinned in tests/markdown/flowmark.version`);
  }
  const main = /^\tmod\t(\S+)\t(\S+)/m.exec(info);
  if (main === null || main[1] !== flowmarkModule || main[2] !== pin) {
    throw new Error(`FLOWMARK ${bin} is ${JSON.stringify(main?.[1] ?? '')} ${JSON.stringify(main?.[2] ?? '')}, not the pinned ${flowmarkModule} ${pin}; run make install-flowmark, or give FLOWMARK a build of a flowmark checkout at that revision`);
  }
  return bin;
}

const listening = /^\[serve\] listening on 127\.0\.0\.1:([0-9]+) for the corpus (.+)$/;

/**
 * corpus/를 새 corpus로 install하고 그 server를 시작해 연결한다. 돌려준 served의 stop이 연결을 닫고 server를
 * 멈춘 뒤 끝나기를 기다리고 directory를 지운다.
 */
async function serve(bin, step) {
  const s = { corpus: 'conformance', root: await mkdtemp(path.join(tmpdir(), 'orm-markdown-')), db: undefined, server: undefined, stderr: '' };
  s.dir = path.join(s.root, s.corpus);
  s.stop = async () => {
    if (s.db !== undefined) await s.db.close();
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
    step(`flowmark install ${s.dir}`);
    try { await run(bin, ['install', s.dir]); } catch (error) { throw new Error(`flowmark install: ${error.message}\n${error.stdout ?? ''}${error.stderr ?? ''}`); }
    step(`flowmark serve ${s.dir} --port 0`);
    s.server = spawn(bin, ['serve', s.dir, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    s.server.stderr.setEncoding('utf8').on('data', chunk => { s.stderr += chunk; });
    const lines = createInterface({ input: s.server.stdout });
    const line = await new Promise(resolve => {
      lines.once('line', resolve);
      s.server.once('exit', () => resolve(''));
    });
    lines.close();
    // server는 계속 stdout에 쓰므로 남은 출력을 읽어 버린다.
    s.server.stdout.resume();
    const m = listening.exec(line);
    if (m === null || m[2] !== s.corpus) throw new Error(`flowmark serve printed ${JSON.stringify(line)}, not its listening line; stderr:\n${s.stderr}`);
    s.port = m[1];
    s.token = JSON.parse(await readFile(path.join(s.dir, '.flowmark', 'server.json'), 'utf8')).token;
    s.dsn = (corpus, token) => `markdown://127.0.0.1:${s.port}/${corpus}?token=${token}`;
    try { s.db = await connect(s.dsn(s.corpus, s.token)); } catch (error) { throw new Error(`connect: ${error.message}; stderr:\n${s.stderr}`); }
    return s;
  } catch (error) {
    await s.stop();
    throw error;
  }
}


let served;

let ready = false;
let all = [];
await runner.run('markdown/setup', PROCESS, async ({ step }) => {
  // commit된 model은 corpus catalog과 이 file의 scan에서 생성한 출력과 같아야 한다.
  step('orm-gen gen --check of src/models/markdown_fixture');
  try {
    await run(process.execPath, ['dist/bin/orm-gen.js', 'gen', '--set', '../../tests/markdown/corpus/dbspec/dbspec-set.json', '--out', 'src/models/markdown_fixture', '--scan', 'tests/markdown_cases.mjs', '--check'], { cwd: fileURLToPath(new URL('..', import.meta.url)) });
  } catch (error) {
    throw new Error(`src/models/markdown_fixture differs from the generator output; regenerate it with the same orm-gen command without --check: ${error.stdout ?? ''}${error.stderr ?? error.message}`);
  }
  const bin = await pinnedFlowmark();
  all = await loadCases();
  const ids = all.map(c => c.id);
  const missing = ids.filter(id => !Object.hasOwn(conformanceCases, id));
  const extra = Object.keys(conformanceCases).filter(id => !ids.includes(id)).sort();
  if (missing.length > 0 || extra.length > 0) throw new Error(`cases.json and the TypeScript cases differ: missing in TypeScript ${JSON.stringify(missing)}, not in cases.json ${JSON.stringify(extra)}`);
  served = await serve(bin, step);
  ready = true;
});
if (ready) {
  // Each case is one test named by its id. A later case reads the corpus state that the cases before it made, so after
  // a failure the later cases fail with the case that stopped them.
  let stopped;
  for (const c of all) {
    caseTest(c.id, DATABASE, async () => {
      if (stopped !== undefined) throw new Error(`not run: ${stopped} failed, and this case reads the corpus state it leaves`);
      try {
        let got;
        try {
          got = await conformanceCases[c.id](served);
        } catch (error) {
          if (!(error instanceof OrmError)) throw new Error(`${c.id} failed without an orm code: ${error?.stack ?? error}`);
          got = { error: error.code, message: error.message };
          if (isDeepStrictEqual({ error: got.error }, c.expect)) return;
          throw new Error(`${c.id}: got ${JSON.stringify(got)}, want ${JSON.stringify(c.expect)}`);
        }
        const actual = normalize(got);
        if (!isDeepStrictEqual(actual, c.expect)) throw new Error(`${c.id}: got ${JSON.stringify(actual)}, want ${JSON.stringify(c.expect)}`);
      } catch (error) {
        stopped = c.id;
        throw error;
      }
    });
  }
  // The server stops after the last case; a failed stop fails the run.
  after(() => served.stop());
}
runner.finish();
