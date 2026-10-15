// markdown:// 연결의 DSN, connect와 control message, error 줄의 해석, markdown 연결이 거절하는 SQL 전용
// surface를 flowmark server 대신 script대로 답하는 가짜 server로 확인한다(docs/protocol.md §5, docs/dialects.md
// "Markdown IR executor"). Go의 packages/go/orm/markdown_test.go와 같은 case다.
//
// 사용: node packages/ts/tests/markdown.mjs (npm run typescript:build 뒤)
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { COMPUTE, cases } from '../../../tests/testcase.mts';
import { Db, OrmError } from '../dist/index.js';
import { parseDsn } from '../dist/driver.js';
import { markdownParam } from '../dist/markdown.js';
import { checkParam } from '../dist/bind_check.js';
import { readFileSync } from 'node:fs';

const run = cases();
const token = '0123456789abcdef0123456789abcdef';
const connectLine = `{"op":"connect","corpus":"tracker","token":"${token}"}`;

/**
 * 한 연결의 message를 받아 적고 answers의 답을 차례로 쓰는 가짜 server다. received는 연결이 끝났을 때 받은
 * 줄들이다.
 */
async function fakeServer(...answers) {
  let done;
  const received = new Promise(resolve => { done = resolve; });
  const server = createServer(socket => {
    const got = [];
    const lines = createInterface({ input: socket });
    let next = 0;
    lines.on('line', line => {
      got.push(line);
      if (next < answers.length) socket.write(`${answers[next++]}\n`);
      if (next >= answers.length) socket.end();
    });
    socket.on('close', () => done(got));
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { dsn: `markdown://127.0.0.1:${port}/tracker?token=${token}`, received, close: () => new Promise(resolve => server.close(resolve)) };
}

async function codeOf(work) {
  try { await work(); } catch (error) {
    if (error instanceof OrmError) return error.code;
    throw error;
  }
  return '';
}

await run.run('markdown/parse-dsn', COMPUTE, () => {
  const parsed = parseDsn(`markdown://127.0.0.1:4100/tracker?token=${token}`);
  const want = { driver: 'markdown', zone: '+00:00', markdown: { address: '127.0.0.1:4100', corpus: 'tracker', token } };
  if (!isDeepStrictEqual(parsed, want)) throw new Error(`parseDsn() = ${JSON.stringify(parsed)}; want ${JSON.stringify(want)}`);
  for (const input of [
    'markdown://127.0.0.1:4100/tracker',
    'markdown://127.0.0.1:4100/tracker?token=',
    'markdown://127.0.0.1:4100/tracker?token=a&token=b',
    'markdown://127.0.0.1:4100/tracker?token=a&mode=ro',
    'markdown://127.0.0.1/tracker?token=a',
    'markdown://127.0.0.1:0/tracker?token=a',
    'markdown://127.0.0.1:port/tracker?token=a',
    'markdown://localhost:4100/tracker?token=a',
    'markdown://10.0.0.1:4100/tracker?token=a',
    'markdown://user@127.0.0.1:4100/tracker?token=a',
    'markdown://127.0.0.1:4100/?token=a',
    'markdown://127.0.0.1:4100/a/b?token=a',
  ]) {
    let code = '';
    try { parseDsn(input); } catch (error) { code = error?.code; }
    if (code !== 'CONFIG') throw new Error(`parseDsn(${input}) gave ${code || 'no error'}; want CONFIG`);
  }
});

// client가 보내는 connect와 control message, 그리고 error 줄의 해석이다.
await run.run('markdown/session-messages', COMPUTE, async () => {
  const s = await fakeServer(
    '{"ok":true}',
    '{"ok":true}', '{"ok":true}', '{"ok":true}', '{"ok":true}',
    '{"ok":true}', '{"error":{"code":"WRITE_CONFLICT","message":"people.flowmark.md:3 changed since it was read"}}',
  );
  try {
    const db = await Db.connect(s.dsn);
    try {
      await db.transaction(() => db.transaction(() => undefined), { readOnly: true });
      let failure;
      try { await db.transaction(() => undefined); } catch (error) { failure = error; }
      if (!(failure instanceof OrmError) || failure.code !== 'WRITE_CONFLICT' || failure.message !== 'WRITE_CONFLICT: people.flowmark.md:3 changed since it was read') {
        throw new Error(`commit error = ${failure}; want WRITE_CONFLICT with the server's message`);
      }
    } finally {
      await db.close();
    }
    const want = [
      connectLine,
      '{"op":"begin","read_only":true}',
      '{"op":"savepoint","name":"orm_sp_1"}',
      '{"op":"release","name":"orm_sp_1"}',
      '{"op":"commit"}',
      '{"op":"begin"}',
      '{"op":"commit"}',
    ];
    const got = await s.received;
    if (!isDeepStrictEqual(got, want)) throw new Error(`messages:\n${got.join('\n')}\nwant:\n${want.join('\n')}`);
  } finally {
    await s.close();
  }
});

// server가 connect에 답한 CONFIG가 connect의 오류다.
await run.run('markdown/connect-refused', COMPUTE, async () => {
  const s = await fakeServer('{"error":{"code":"CONFIG","message":"connect: the token is not the corpus\'s token"}}');
  try {
    let failure;
    try { await (await Db.connect(s.dsn)).close(); } catch (error) { failure = error; }
    if (!(failure instanceof OrmError) || failure.code !== 'CONFIG' || failure.message !== "CONFIG: connect: the token is not the corpus's token") {
      throw new Error(`connect error = ${failure}; want the server's CONFIG`);
    }
    const got = await s.received;
    if (!isDeepStrictEqual(got, [connectLine])) throw new Error(`messages = ${JSON.stringify(got)}`);
  } finally {
    await s.close();
  }
});

// markdown 연결은 SQL 전용 surface를 CAPABILITY_UNSUPPORTED로 거절한다.
await run.run('markdown/rejected-surfaces', COMPUTE, async () => {
  const s = await fakeServer('{"ok":true}');
  try {
    const db = await Db.connect(s.dsn);
    try {
      const surfaces = {
        isolation: () => db.transaction(() => undefined, { isolation: 'serializable' }),
        timeoutMs: () => db.transaction(() => undefined, { timeoutMs: 100 }),
        lock: () => db.utils().lock('k'),
        setLocal: () => db.utils().setLocal('k', 'v'),
        subscribe: async () => db.subscribe(() => undefined),
        statementTimeoutMs: () => Db.connect(s.dsn, { statementTimeoutMs: 100 }),
      };
      for (const [name, work] of Object.entries(surfaces)) {
        const code = await codeOf(work);
        if (code !== 'CAPABILITY_UNSUPPORTED') throw new Error(`${name}: ${code || 'no error'}; want CAPABILITY_UNSUPPORTED`);
      }
    } finally {
      await db.close();
    }
  } finally {
    await s.close();
  }
});
// tests/bind/vectors.json의 message case: IR executor message parameter의 runtime value model JSON이다
// (docs/protocol.md §5 "Parameters"). Go의 TestBindMessageVectors와 같은 case다.
const bind = JSON.parse(readFileSync(new URL('../../../tests/bind/vectors.json', import.meta.url), 'utf8'));
for (const c of bind.message) {
  await run.run(`markdown/bind-message/${c.name}`, COMPUTE, () => {
    const db = { zone: bind.zone, aesKey: '' };
    let got, code = '';
    try { got = markdownParam(db, 0, c.value, [{ type: c.type }]); } catch (error) {
      if (!(error instanceof OrmError)) throw error;
      code = error.code;
    }
    if (c.code !== undefined) {
      if (code !== c.code) throw new Error(`markdownParam(${JSON.stringify(c.value)}) = ${got} ${code}; want ${c.code}`);
    } else if (code !== '' || got !== JSON.stringify(c.json)) {
      throw new Error(`markdownParam(${JSON.stringify(c.value)}) = ${got} ${code}; want ${JSON.stringify(c.json)}`);
    }
  });
}
// tests/bind/vectors.json의 bind case: parameter 값을 그 slot의 논리 type으로 검사한다(docs/protocol.md §5
// "Parameters"). Go의 TestBindVectors와 같은 case다.
function vectorValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (value.int !== undefined) return BigInt(value.int);
  if (value.f64 !== undefined) return Number(value.f64);
  if (value.bytes !== undefined) return new Uint8Array(Buffer.from(value.bytes, 'base64'));
  throw new Error(`value ${JSON.stringify(value)} has no host form`);
}
for (const c of bind.bind) {
  await run.run(`bind/${c.name}`, COMPUTE, () => {
    const value = vectorValue(c.value);
    const slot = { type: c.slot.type, precision: c.slot.precision ?? 0, scale: c.slot.scale ?? 0, length: c.slot.length ?? 0 };
    let code = '';
    try { checkParam(0, value, slot, bind.zone); } catch (error) {
      if (!(error instanceof OrmError)) throw error;
      code = error.code;
    }
    if (c.code !== undefined) {
      if (code !== c.code) throw new Error(`checkParam(${JSON.stringify(c.value)}) = ${code}; want ${c.code}`);
    } else if (code !== '' || !isDeepStrictEqual(value, vectorValue(c.bound))) {
      throw new Error(`checkParam(${JSON.stringify(c.value)}) = ${code}; want ${JSON.stringify(c.bound)} bound`);
    }
  });
}
run.finish();
