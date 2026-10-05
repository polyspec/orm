// 빈 TCP port <count>개를 127.0.0.1에서 고르고 공백으로 나눠 출력한다. 모든 port를 동시에 열어 서로 다른 port를
// 받은 뒤 닫는다. make test-servers는 이 checkout의 server에 이 port를 주므로, 두 checkout의 server가 같은 고정 port를
// 두고 다투지 않는다. server가 listen하면 그 port는 그 server의 것이다.
//
// Usage: node scripts/free-ports.mjs <count>
import { createServer } from 'node:net';

const count = Number(process.argv[2]);
if (!Number.isInteger(count) || count < 1) {
  console.error('usage: node scripts/free-ports.mjs <count>; give the number of ports to choose');
  process.exit(2);
}
const servers = [];
try {
  const ports = await Promise.all(Array.from({ length: count }, () => new Promise((resolve, reject) => {
    const server = createServer();
    servers.push(server);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  })));
  console.log(ports.join(' '));
} finally {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(() => resolve()))));
}
