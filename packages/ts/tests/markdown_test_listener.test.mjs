import assert from 'node:assert/strict';
import { createConnection, createServer } from 'node:net';
import test from 'node:test';
import { listenMarkdownTestServer } from './markdown_test_listener.mjs';

test('listens on an ephemeral loopback port and closes the listener', async () => {
  const server = createServer(socket => socket.end('ready'));
  const listener = await listenMarkdownTestServer(server);
  try {
    const url = new URL(listener.dsn);
    assert.equal(url.protocol, 'markdown:');
    assert.equal(url.hostname, '127.0.0.1');
    assert.ok(Number(url.port) > 0);
    assert.equal(url.pathname, '/conformance');
    assert.equal(url.searchParams.get('token'), '0123456789abcdef0123456789abcdef');

    const response = await new Promise((resolve, reject) => {
      const socket = createConnection(Number(url.port), '127.0.0.1');
      let body = '';
      socket.on('data', chunk => { body += chunk; });
      socket.on('end', () => resolve(body));
      socket.on('error', reject);
    });
    assert.equal(response, 'ready');
  } finally {
    await listener.close();
  }
  assert.equal(server.listening, false);
});

test('rejects the original asynchronous listen error and removes its listeners', async () => {
  const server = createServer();
  const expected = new Error('synthetic listen failure');
  server.listen = () => {
    process.nextTick(() => server.emit('error', expected));
    return server;
  };
  await assert.rejects(listenMarkdownTestServer(server), error => error === expected);
  assert.equal(server.listenerCount('error'), 0);
  assert.equal(server.listenerCount('connection'), 0);
});

test('rejects the original close error and destroys accepted sockets', async () => {
  let accepted;
  const server = createServer(socket => { accepted = socket; });
  const originalConnectionListeners = server.listenerCount('connection');
  const originalClose = server.close;
  let socket;
  try {
    const listener = await listenMarkdownTestServer(server);
    const acceptedConnection = new Promise(resolve => server.once('connection', resolve));
    socket = createConnection(Number(new URL(listener.dsn).port), '127.0.0.1');
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    await acceptedConnection;
    assert.ok(accepted);
    const expected = new Error('synthetic close failure');
    server.close = callback => { callback(expected); return server; };
    await assert.rejects(listener.close(), error => error === expected);
    assert.equal(accepted.destroyed, true);
    assert.equal(server.listenerCount('error'), 0);
    assert.equal(server.listenerCount('connection'), originalConnectionListeners);
  } finally {
    socket?.destroy();
    delete server.close;
    if (server.listening) await new Promise(resolve => originalClose.call(server, resolve));
  }
});
