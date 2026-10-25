/** Starts a Markdown test listener on an ephemeral loopback port. */
export async function listenMarkdownTestServer(server) {
  const sockets = new Set();
  let listenError;
  let listening = false;
  const onConnection = socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  const onError = error => { listenError ??= error; };
  server.on('connection', onConnection);
  server.on('error', onError);
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => {
        if (listenError) return fail(listenError);
        settled = true;
        listening = true;
        server.removeListener('error', fail);
        resolve();
      });
    });
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    server.removeListener('connection', onConnection);
    server.removeListener('error', onError);
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Markdown listener did not expose a TCP address');
  return {
    dsn: `markdown://127.0.0.1:${address.port}/conformance?token=0123456789abcdef0123456789abcdef`,
    close: async () => {
      let closeError;
      try {
        if (listening) {
          await new Promise((resolve, reject) => {
            try {
              server.close(error => error ? reject(error) : resolve());
            } catch (error) {
              reject(error);
            }
            for (const socket of sockets) socket.destroy();
          });
        }
        if (listenError) throw listenError;
      } catch (error) {
        closeError = error;
      } finally {
        for (const socket of sockets) socket.destroy();
        server.removeListener('connection', onConnection);
        server.removeListener('error', onError);
      }
      if (closeError) throw closeError;
    },
  };
}
