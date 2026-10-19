// Chooses <count> free TCP ports on 127.0.0.1 and prints them separated by spaces. Opens all ports at the same time so they differ from each other,
// then closes them after taking them. make orm-test-servers gives this checkout's servers these ports, so two checkouts' servers do not contend
// for the same fixed port. Once a server listens, that port belongs to that server.
//
// Usage: node scripts/free-ports.mts <count>
import { createServer, type Server } from 'node:net';

const count = Number(process.argv[2]);
if (!Number.isInteger(count) || count < 1) {
  console.error('usage: node scripts/free-ports.mts <count>; give the number of ports to choose');
  process.exit(2);
}
const servers: Server[] = [];
try {
  const ports = await Promise.all(Array.from({ length: count }, () => new Promise<number>((resolve, reject) => {
    const server = createServer();
    servers.push(server);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') reject(new Error(`the server listens on ${String(address)}, not a TCP port`));
      else resolve(address.port);
    });
  })));
  console.log(ports.join(' '));
} finally {
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
}
