// The DSN of a markdown:// connection, connect and control messages, parsing of error lines, and the SQL-only
// surface that a markdown connection rejects are checked with a fake server that answers from a script in place of the flowmark server (docs/spec/protocol.md §5, docs/spec/dialects.md
// "Markdown IR executor"). These are the same cases as packages/go/orm/markdown_test.go in Go.
//
// Usage: node packages/ts/tests/markdown.mjs (after npm run typescript:build)
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { COMPUTE, caseTest } from '../../../tests/testcase.mts';
import { Db, OrmError } from '../dist/index.js';
import { parseDsn } from '../dist/driver.js';
import { beginLine, markdownParam } from '../dist/markdown.js';
import { checkAssign, checkParam, transformParam } from '../dist/bind_check.js';
import { readFileSync } from 'node:fs';

const token = '0123456789abcdef0123456789abcdef';
const connectLine = `{"op":"connect","corpus":"tracker","token":"${token}"}`;

/**
 * A fake server that records the messages of one connection and writes the answers from answers in order. received holds the lines
 * received when the connection ends.
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

// Requirements: PRT-63.
caseTest('markdown/parse-dsn', COMPUTE, () => {
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

// The connect and control messages the client sends, and the parsing of error lines.
// Requirements: PRT-64.
caseTest('markdown/session-messages', COMPUTE, async () => {
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

// The CONFIG the server answers to connect is the error of connect.
// Requirements: PRT-64.
caseTest('markdown/connect-refused', COMPUTE, async () => {
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

// A markdown connection rejects the SQL-only surface with CAPABILITY_UNSUPPORTED.
caseTest('markdown/rejected-surfaces', COMPUTE, async () => {
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
// Message case of tests/bind/vectors.json: the runtime value model JSON of an IR executor message parameter
// (docs/spec/protocol.md §5 "Parameters"). These are the same cases as TestBindMessageVectors in Go.
const bind = JSON.parse(readFileSync(new URL('../../../tests/bind/vectors.json', import.meta.url), 'utf8'));
// The control cases: the begin control message of a transaction with and without readOnly (docs/spec/protocol.md §5 Session).
if (!Array.isArray(bind.control) || bind.control.length === 0) throw new Error('tests/bind/vectors.json has no control cases');
for (const c of bind.control) {
  caseTest(`markdown/bind-message/control/${c.name}`, COMPUTE, () => {
    const got = beginLine(c.read_only);
    if (!isDeepStrictEqual(JSON.parse(got), c.json)) throw new Error(`begin of readOnly ${c.read_only} = ${got}; want ${JSON.stringify(c.json)}`);
  });
}
for (const c of bind.message) {
  caseTest(`markdown/bind-message/${c.name}`, COMPUTE, () => {
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
// Bind case of tests/bind/vectors.json: checks a parameter value against the logical type of its slot (docs/spec/protocol.md §5
// "Parameters"). These are the same cases as TestBindVectors in Go.
function vectorValue(value) {
  if (value === null || typeof value !== 'object') return value;
  // A native value of the tagged kind: the host object a TypeScript program passes for it.
  if (value.native !== undefined) return new Date(Date.UTC(2024, 0, 2, 3, 4, 5));
  if (value.int !== undefined) return BigInt(value.int);
  if (value.f64 !== undefined) return Number(value.f64);
  if (value.bytes !== undefined) return new Uint8Array(Buffer.from(value.bytes, 'base64'));
  throw new Error(`value ${JSON.stringify(value)} has no host form`);
}
for (const c of bind.bind) {
  caseTest(`bind/${c.name}`, COMPUTE, () => {
    let value = vectorValue(c.value);
    const slot = { type: c.slot.type, precision: c.slot.precision ?? 0, scale: c.slot.scale ?? 0, length: c.slot.length ?? 0 };
    let code = '';
    try {
      if (c.slot.transform !== undefined) value = transformParam(c.slot.transform, value);
      else {
        checkAssign(0, value, { ...slot, notNull: c.slot.not_null === true, column: 'column' });
        checkParam(0, value, slot, bind.zone);
      }
    } catch (error) {
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
