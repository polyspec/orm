// The IR answers of contracts/fixtures/ir_answers.json in the TypeScript client (docs/spec/protocol.md section 5, Read). Each case
// runs its chain of tests/markdown/cases.json (markdown_cases.mjs) on a connection whose listener answers connect with
// {"ok":true} and each later request with the answer of the case, and compares the result with the case expect. Each case is
// one test named by its id. Usage: node --conditions=orm-test packages/ts/tests/ir_answers.mjs (after npm run typescript:build)
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
import { OrmError } from '../dist/index.js';
import { connect } from '../dist/models/markdown_fixture/models.js';
import { conformanceCases, normalize } from './markdown_cases.mjs';

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
      } catch (error) {
        // An unreadable line keeps the key 'unreadable'; any other error is a defect and is thrown.
        if (!(error instanceof SyntaxError)) throw error;
      }
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

// Each case of the fixture is one test named by its id, the name that the suite of the fixture holds.
const doc = JSON.parse(await readFile(fileURLToPath(new URL('../../../contracts/fixtures/ir_answers.json', import.meta.url)), 'utf8'));
for (const c of doc.cases) {
  caseTest(c.id, COMPUTE, async () => {
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
