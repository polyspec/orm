// Language server sessions over standard input and output (docs/editor.md): the built `dbspec-lsp` is started as a
// child process and spoken to over JSON-RPC. The editor fixtures of tests/editor give the expected diagnostics, semantic
// tokens, folding ranges and formatting; set resolution, an open buffer winning over the disk, and a watched file
// change are checked on real file trees.
//
// Usage: node --test packages/dbspec-lsp/tests/session.test.mjs (after the build of this package and its dependencies)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import { caseTest } from '../../../tests/testcase.mts';

const TIMEOUT = 20000;
const bin = fileURLToPath(new URL('../bin/dbspec-lsp.mjs', import.meta.url));
const fixtures = new URL('../../../tests/editor/', import.meta.url);
const CLASSES = ['keyword', 'type', 'name', 'setting', 'number', 'string', 'operator', 'punctuation', 'comment', 'word'];

/** A started server with the diagnostics and messages it sent. */
async function start() {
  const child = spawn(process.execPath, [bin, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
  const diagnostics = new Map();
  const messages = [];
  // Waiters by URI: one refresh publishes every URI of the open documents and their sets, so a step waits for the
  // publication of the URI it reads, never for a late publication of an earlier refresh.
  const waiters = new Map();
  connection.onNotification('textDocument/publishDiagnostics', params => {
    diagnostics.set(params.uri, params.diagnostics);
    const list = waiters.get(params.uri) ?? [];
    waiters.delete(params.uri);
    list.forEach(resolve => resolve());
  });
  connection.onNotification('window/showMessage', params => { messages.push(params.message); });
  connection.onRequest('client/registerCapability', () => null);
  connection.listen();
  const init = await connection.sendRequest('initialize', {
    processId: process.pid, rootUri: null,
    capabilities: { general: { positionEncodings: ['utf-16'] }, workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } },
  });
  await connection.sendNotification('initialized', {});
  const settle = uri => new Promise(resolve => waiters.set(uri, [...(waiters.get(uri) ?? []), resolve]));
  return {
    init, diagnostics, messages,
    async open(uri, text, read = uri) {
      const published = settle(read);
      await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'dbspec', version: 1, text } });
      await published;
    },
    async change(uri, text, version, read = uri) {
      const published = settle(read);
      await connection.sendNotification('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
      await published;
    },
    async watched(uri, read) {
      const published = settle(read);
      await connection.sendNotification('workspace/didChangeWatchedFiles', { changes: [{ uri, type: 2 }] });
      await published;
    },
    request: (method, params) => connection.sendRequest(method, params),
    async stop() {
      await connection.sendRequest('shutdown');
      await connection.sendNotification('exit');
      connection.dispose();
      child.kill();
    },
  };
}

/** The semantic tokens of a document as `{class, range}` in absolute positions. */
function decode(data) {
  const out = [];
  let line = 0;
  let character = 0;
  for (let i = 0; i < data.length; i += 5) {
    line += data[i];
    character = data[i] === 0 ? character + data[i + 1] : data[i + 1];
    out.push({ class: CLASSES[data[i + 3]], range: [[line, character], [line, character + data[i + 2]]] });
  }
  return out;
}

const tree = () => realpathSync(mkdtempSync(join(tmpdir(), 'dbspec-lsp-')));
const CORE = 'dbspec 1 core\n\ntable users {\n  id i64 identity\n  primary key (id)\n}\n';
const SHOP = 'dbspec 1 shop\n\nuse core { users }\n\ntable orders {\n  id i64 identity\n  primary key (id)\n}\n';

/** Runs body with a server and a fresh tree holding the files, removing both after. */
async function withTree(files, body) {
  const root = tree();
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const server = await start();
    try {
      await body(server, path => pathToFileURL(join(root, path)).href, root);
    } finally { await server.stop(); }
  } finally { rmSync(root, { recursive: true }); }
}

caseTest('the server declares utf-16, full sync and the class legend', TIMEOUT, async () => {
  const server = await start();
  try {
    const { capabilities } = server.init;
    assert.equal(capabilities.positionEncoding, 'utf-16');
    assert.equal(capabilities.textDocumentSync.change, 1);
    assert.deepEqual(capabilities.semanticTokensProvider.legend.tokenTypes, CLASSES);
  } finally { await server.stop(); }
});

for (const name of readdirSync(fixtures).filter(n => n.endsWith('.dbs')).map(n => n.slice(0, -4)).sort()) {
  caseTest(`fixture ${name} through the language server`, TIMEOUT, async () => {
    const text = readFileSync(new URL(`${name}.dbs`, fixtures), 'utf8');
    const expected = JSON.parse(readFileSync(new URL(`${name}.json`, fixtures), 'utf8'));
    const uri = `untitled:${name}.dbs`;
    const server = await start();
    try {
      await server.open(uri, text);
      const range = r => [[r.start.line, r.start.character], [r.end.line, r.end.character]];
      assert.deepEqual(server.diagnostics.get(uri).map(d => ({ rule: d.code, message: d.message, range: range(d.range) })), expected.diagnostics);
      const tokens = await server.request('textDocument/semanticTokens/full', { textDocument: { uri } });
      assert.deepEqual(decode(tokens.data), expected.tokens);
      const folding = await server.request('textDocument/foldingRange', { textDocument: { uri } });
      assert.deepEqual(folding.map(f => ({ startLine: f.startLine, endLine: f.endLine })), expected.folding);
      const edits = await server.request('textDocument/formatting', { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } });
      if (expected.formatted === null) assert.equal(edits, null);
      else if (expected.formatted === text) assert.deepEqual(edits, []);
      else assert.deepEqual(edits.map(e => e.newText), [expected.formatted]);
    } finally { await server.stop(); }
  });
}

const SET = '{"schema": 1, "documents": ["shop.dbs", "core.dbs"]}\n';

caseTest('a document takes its set from the nearest set file', TIMEOUT, () =>
  withTree({ 'dbspec-set.json': SET, 'core.dbs': CORE, 'shop.dbs': SHOP }, async (server, uri) => {
    await server.open(uri('shop.dbs'), SHOP);
    assert.deepEqual(server.diagnostics.get(uri('shop.dbs')), []);
  }));

caseTest('a document no set file lists is alone and its use line reports it', TIMEOUT, () =>
  withTree({ 'shop.dbs': SHOP }, async (server, uri) => {
    await server.open(uri('shop.dbs'), SHOP);
    assert.deepEqual(server.diagnostics.get(uri('shop.dbs')).map(d => d.code), ['use']);
  }));

caseTest('a set error is shown and the document is analyzed alone', TIMEOUT, () =>
  withTree({ 'dbspec-set.json': '{"schema": 1, "documents": ["shop.dbs", "gone.dbs"]}\n', 'shop.dbs': SHOP }, async (server, uri) => {
    await server.open(uri('shop.dbs'), SHOP);
    assert.ok(server.messages.some(m => m.startsWith('set.file: ')), server.messages.join('\n'));
    assert.deepEqual(server.diagnostics.get(uri('shop.dbs')).map(d => d.code), ['use']);
  }));

caseTest('an open buffer of a listed file wins over the disk', TIMEOUT, () =>
  withTree({ 'dbspec-set.json': SET, 'core.dbs': CORE, 'shop.dbs': SHOP }, async (server, uri) => {
    await server.open(uri('shop.dbs'), SHOP);
    await server.open(uri('core.dbs'), CORE);
    assert.deepEqual(server.diagnostics.get(uri('shop.dbs')), []);
    await server.change(uri('core.dbs'), CORE.replace('table users', 'table people'), 2, uri('shop.dbs'));
    assert.deepEqual(server.diagnostics.get(uri('shop.dbs')).map(d => d.code), ['use']);
  }));

caseTest('a watched file change analyzes the open documents again', TIMEOUT, () =>
  withTree({ 'dbspec-set.json': SET, 'core.dbs': CORE, 'shop.dbs': SHOP }, async (server, uri, root) => {
    await server.open(uri('shop.dbs'), SHOP);
    assert.deepEqual(server.diagnostics.get(uri('shop.dbs')), []);
    writeFileSync(join(root, 'core.dbs'), CORE.replace('table users', 'table people'));
    await server.watched(uri('core.dbs'), uri('shop.dbs'));
    assert.deepEqual(server.diagnostics.get(uri('shop.dbs')).map(d => d.code), ['use']);
  }));

caseTest('a diagnostic of another file of the set is published on its URI', TIMEOUT, () =>
  withTree({
    'dbspec-set.json': '{"schema": 1, "documents": ["shop.dbs", "sub/bad.dbs"]}\n',
    'shop.dbs': 'dbspec 1 shop\n\ntable t {\n  id i64 identity\n  primary key (id)\n}\n',
    'sub/bad.dbs': '<?xml version="1.0"?>\n',
  }, async (server, uri, root) => {
    await server.open(uri('shop.dbs'), readFileSync(join(root, 'shop.dbs'), 'utf8'), uri('sub/bad.dbs'));
    assert.deepEqual(server.diagnostics.get(uri('sub/bad.dbs')).map(d => d.code), ['signature']);
  }));
