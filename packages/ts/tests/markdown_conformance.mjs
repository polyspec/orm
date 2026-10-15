// markdown IR executor conformance(tests/markdown/README.md)를 TypeScript client로 실행한다.
// tests/markdown/cases.json의 모든 case를 그 순서대로, FLOWMARK가 가리키는 flowmark build의 server
// 하나에서 실행하고 각 결과를 expect와 비교한다. 그 build는 tests/markdown/flowmark.version이 고정한
// build여야 하고, 없거나 다른 build이면 실패한다(건너뛰지 않는다). 뒤의 case는 앞 case가 만든 corpus
// 상태를 읽으므로 첫 실패 뒤의 case는 그 실패를 이유로 실패한다.
//
// 사용: FLOWMARK=<flowmark> node --conditions=orm-test packages/ts/tests/markdown_conformance.mjs
// (npm run typescript:build 뒤; make markdown-conformance-check가 FLOWMARK를 준다)
//
// --ir-answers를 주면 flowmark 없이 contracts/fixtures/ir_answers.json의 case만 실행한다: case마다 server 대신
// connect에 {"ok":true}, chain의 request 하나에 case의 answer를 쓰는 listener에 연결해 chain(cases.json의 case)을
// 실행하고 결과를 expect와 비교한다(docs/protocol.md §5 Read).
// 사용: node --conditions=orm-test packages/ts/tests/markdown_conformance.mjs --ir-answers
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { after } from 'node:test';
import { COMPUTE, DATABASE, PROCESS, caseTest, cases } from '../../../tests/testcase.mts';
import { OrmError, StyledValue } from '../dist/index.js';
import { Logs, People, Tasks, connect } from '../dist/models/markdown_fixture/models.js';

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

/** transaction을 rollback시키려고 callback이 던지는 오류다. */
const stop = new Error('stop');

/** cases.json의 id마다 그 case를 실행하고 README가 정한 결과 값을 돌려주는 함수다. 던진 OrmError는 그 code의 {"error": code}다. */
const conformanceCases = {
  insert_one: async s => {
    const m = await new People().connect(s.db).setName('Ann').setEmail('ann@example.com').setAge(30).setScore('1.50').create();
    return { id: m.getId() };
  },
  insert_rows: async s => {
    const bob = new People().setName('Bob').setEmail('bob@example.com').setAge(25).setScore('2.00');
    const cara = new People().setName('Cara').setEmail(null).setAge(null).setScore('0.50');
    return new People().connect(s.db).creates([bob, cara]);
  },
  insert_rows_tasks: async s => new Tasks().connect(s.db).creates([
    new Tasks().setOwner('P1').setTitle('write spec').setPoints(3).setDue('2026-10-01'),
    new Tasks().setOwner('P1').setTitle('review').setPoints(5).setDue(null),
    new Tasks().setOwner('P2').setTitle('ship').setPoints(8).setDue('2026-10-05'),
  ]),
  insert_identity: async s => {
    const m = await new Logs().connect(s.db).setTask('T1').setNote('started').create();
    return { id: m.getId() };
  },
  one: async s => (await new People().connect(s.db).removeAllColumns().addColumnName().addColumnEmail().addColumnAge().addColumnActive().addColumnScore().id('P1').get()).toArray(),
  one_no_rows: async s => new People().connect(s.db).id('P9').get(),
  all: async s => (await new People().connect(s.db).removeAllColumns().addColumnName().addColumnAge().orderByNameDesc().gets()).toArray(),
  count: async s => new Tasks().connect(s.db).owner('P1').getCount(),
  group_count: async s => (await new Tasks().connect(s.db).groupByOwner().orderByOwnerAsc().getsCount()).toArray(),
  group_count_no_rows: async s => (await new Tasks().connect(s.db).owner('P9').groupByOwner().orderByOwnerAsc().getsCount()).toArray(),
  sum: async s => new Tasks().connect(s.db).sumPoints().getSum(),
  avg: async s => new People().connect(s.db).avgAge().getAvg(),
  paginate: async s => {
    const page = await new People().connect(s.db).removeAllColumns().addColumnName().orderByNameAsc().getsPage(2, 2);
    return { items: page.items.toArray(), total_count: page.totalCount, total_pages: page.totalPages };
  },
  join: async s => (await new Tasks().connect(s.db).removeAllColumns().addColumnTitle()
    .joinOwnerWithId(new People().removeAllColumns().addColumnName())
    .orderByTitleAsc().gets()).toArray(),
  relation_many: async s => (await new People().connect(s.db).removeAllColumns().addColumnName()
    .relations(new Tasks().removeAllColumns().addColumnDue().matchIdWithOwner().orderByTitleAsc())
    .id('P1').get()).toArray(),
  relation_one: async s => (await new Tasks().connect(s.db).removeAllColumns().addColumnTitle()
    .relation(new People().removeAllColumns().addColumnName().matchOwnerWithId())
    .id('T3').get()).toArray(),
  update: async s => {
    const m = await new People().connect(s.db).id('P2').get();
    await m.setAge(26).update();
    return (await new People().connect(s.db).removeAllColumns().addColumnAge().id('P2').get()).toArray();
  },
  update_optimistic_conflict: async s => {
    const stale = await new People().connect(s.db).id('P2').get();
    const fresh = await new People().connect(s.db).id('P2').get();
    await fresh.setName('Bobby').update();
    return stale.setAge(27).update(true);
  },
  insert_on_duplicate: async s => {
    const m = await new People().connect(s.db).setName('Ann B').setEmail('ann@example.com')
      .duplication(new People().setName('Ann B')).create();
    const read = await new People().connect(s.db).id('P1').get();
    return { created: m.getId(), name: read.getName() };
  },
  delete: async s => {
    const m = await new Tasks().connect(s.db).id('T2').get();
    await m.delete();
    return new Tasks().connect(s.db).getCount();
  },
  delete_referenced: async s => {
    const m = await new Tasks().connect(s.db).id('T1').get();
    return m.delete();
  },
  soft_delete: async s => {
    const m = await new People().connect(s.db).id('P3').get();
    await m.delete();
    return new People().connect(s.db).getCount();
  },
  restore: async s => {
    const m = await new People().connect(s.db).setId('P3').restore();
    const n = await new People().connect(s.db).getCount();
    return { id: m.getId(), name: m.getName(), count: n };
  },
  transaction_commit: async s => {
    await s.db.transaction(async () => { await new Logs().setTask('T3').setNote('committed').create(); });
    return new Logs().connect(s.db).getCount();
  },
  transaction_rollback: async s => {
    const error = await s.db.transaction(async () => {
      await new Logs().setTask('T3').setNote('rolled back').create();
      throw stop;
    }).then(() => undefined, e => e);
    if (error !== stop) throw new Error(`the transaction ended with ${error}, not its callback's error`);
    return new Logs().connect(s.db).getCount();
  },
  savepoint_rollback: async s => {
    await s.db.transaction(async () => {
      await new Logs().setTask('T3').setNote('outer').create();
      const error = await s.db.transaction(async () => {
        await new Logs().setTask('T3').setNote('inner').create();
        throw stop;
      }).then(() => undefined, e => e);
      if (error !== stop) throw new Error(`the savepoint ended with ${error}, not its callback's error`);
    });
    const rows = await new Logs().connect(s.db).orderByIdAsc().gets();
    return rows.values().map(m => m.getNote());
  },
  read_only_write: async s => s.db.transaction(async () => { await new Logs().setTask('T3').setNote('read only').create(); }, { readOnly: true }),
  lock_update: async s => s.db.transaction(async () => (await new People().connect(s.db).removeAllColumns().id('P1').forUpdate().get()).toArray()),
  lock_nowait: async s => s.db.transaction(async () => { await new People().connect(s.db).id('P1').forUpdateNoWait().get(); }),
  get_query: async s => new People().connect(s.db).getQuery(),
  isolation: async s => s.db.transaction(async () => undefined, { isolation: 'serializable' }),
  // A transaction that reads P1 and writes its own name back, with retry options: the commit's code (null when it
  // commits) and how many times the callback ran. WRITE_CONFLICT is never retried, DEADLOCK is
  // (contracts/fixtures/ir_answers.json).
  transaction_retry_commit: async s => {
    let runs = 0;
    const error = await s.db.transaction(async () => {
      runs += 1;
      const m = await new People().id('P1').get();
      await m.setName(m.getName()).update();
    }, { retry: 3 }).then(() => undefined, e => e);
    if (error !== undefined && !(error instanceof OrmError)) throw error;
    return { error: error === undefined ? null : error.code, runs };
  },
  write_conflict: async s => {
    const error = await s.db.transaction(async () => {
      const m = await new People().id('P1').get();
      await m.setName('Ann C').update();
      // engine 밖의 편집: transaction이 쓸 file을 commit 전에 바꾼다.
      const file = path.join(s.dir, 'people.flowmark.md');
      const text = await readFile(file, 'utf8');
      if (!text.includes('Cara')) throw new Error(`${file} holds no Cara to edit:\n${text}`);
      await writeFile(file, text.replace('Cara', 'Carol'));
    }).then(() => undefined, e => e);
    const read = await new People().connect(s.db).id('P1').get();
    return { error: error instanceof OrmError ? error.code : String(error), name: read.getName() };
  },
  connect_corpus_mismatch: async s => (await connect(s.dsn('other', s.token))).close(),
  connect_token_mismatch: async s => (await connect(s.dsn(s.corpus, '0'.repeat(32)))).close(),
};

/** 결과를 JSON으로 썼다 읽은 값이다: cases.json의 expect와 같은 형태다. TypeScript model은 date를 README
 * "Results"가 정한 YYYY-MM-DD text로 가진다. */
function normalize(value) {
  if (value instanceof StyledValue) throw new Error('a case result holds a styled value, which has no JSON form here');
  return JSON.parse(JSON.stringify(value ?? null));
}

let served;
/** connect에 {"ok":true}, 다음 message에 answer를 쓰는 listener다. */
/**
 * A listener that answers connect with {"ok":true} and every later message with the answer of answers keyed by the op
 * of a control message or the kind of a request; a message without an answer is IR_INVALID.
 */
async function keyedServer(answers) {
  const server = createServer(socket => {
    let first = true;
    createInterface({ input: socket }).on('line', line => {
      if (first) {
        first = false;
        socket.write('{"ok":true}\n');
        return;
      }
      let key = 'unreadable';
      try {
        const message = JSON.parse(line);
        key = message.op ?? message.request?.kind ?? key;
      } catch {}
      const answer = Object.hasOwn(answers, key) ? answers[key] : { error: { code: 'IR_INVALID', message: `the case has no answer for ${key}` } };
      socket.write(`${JSON.stringify(answer)}\n`);
    });
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { dsn: `markdown://127.0.0.1:${port}/conformance?token=0123456789abcdef0123456789abcdef`, close: () => new Promise(resolve => server.close(resolve)) };
}

async function answeringServer(answer) {
  const server = createServer(socket => {
    const replies = ['{"ok":true}', answer];
    createInterface({ input: socket }).on('line', () => {
      if (replies.length > 0) socket.write(`${replies.shift()}\n`);
    });
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { dsn: `markdown://127.0.0.1:${port}/conformance?token=0123456789abcdef0123456789abcdef`, close: () => new Promise(resolve => server.close(resolve)) };
}

if (process.argv.includes('--ir-answers')) {
  const doc = JSON.parse(await readFile(fileURLToPath(new URL('../../../contracts/fixtures/ir_answers.json', import.meta.url)), 'utf8'));
  for (const c of doc.cases) {
    await runner.run(`ir-answers/${c.id}`, COMPUTE, async () => {
      const chain = conformanceCases[c.chain];
      if (chain === undefined) throw new Error(`chain ${c.chain} is no markdown conformance case`);
      const server = c.answers !== undefined ? await keyedServer(c.answers) : await answeringServer(JSON.stringify(c.answer));
      const db = await connect(server.dsn);
      let got;
      try {
        got = normalize(await chain({ db }));
      } catch (error) {
        if (!(error instanceof OrmError)) throw new Error(`${c.id} failed without an orm code: ${error?.stack ?? error}`);
        got = { error: error.code };
      } finally {
        await db.close();
        await server.close();
      }
      if (!isDeepStrictEqual(got, c.expect)) throw new Error(`${c.id}: got ${JSON.stringify(got)}, want ${JSON.stringify(c.expect)}`);
    });
  }
  runner.finish();
  process.exit(process.exitCode ?? 0);
}

let ready = false;
let all = [];
await runner.run('markdown/setup', PROCESS, async ({ step }) => {
  // commit된 model은 corpus catalog과 이 file의 scan에서 생성한 출력과 같아야 한다.
  step('orm-gen gen --check of src/models/markdown_fixture');
  try {
    await run(process.execPath, ['dist/bin/orm-gen.js', 'gen', '--set', '../../tests/markdown/corpus/dbspec/dbspec-set.json', '--out', 'src/models/markdown_fixture', '--scan', 'tests/markdown_conformance.mjs', '--check'], { cwd: fileURLToPath(new URL('..', import.meta.url)) });
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
