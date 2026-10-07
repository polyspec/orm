// TypeScript client를 build하고 그 출력 directory clients/typescript/dist를 원자적으로 publish한다. tsc는 같은
// directory의 임시 directory dist.next-<pid>에 쓰고, 성공하면 rename으로 dist를 바꾼다: 기존 dist를
// dist.old-<pid>로 옮기고 새 directory를 dist로 옮긴 뒤 옛 것을 지운다. 그래서 dist에는 끝난 build 하나의 file만
// 있고, 중간에 끊긴 build가 남긴 반쪽 출력이 없다. 실패한 build의 임시 directory는 지우고 dist는 그대로 둔다. dist를
// 쓰고 읽는 make target은 TypeScript build lease(HOLD_TYPESCRIPT, READ_TYPESCRIPT)를 가지므로 두 rename 사이를
// 다른 실행이 보지 않는다.
//
// Usage: node scripts/typescript/build.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const client = fileURLToPath(new URL('../../clients/typescript/', import.meta.url));
const dist = join(client, 'dist');
const next = join(client, `dist.next-${process.pid}`);
const old = join(client, `dist.old-${process.pid}`);
// tsc는 client의 dependency typescript다: Node가 client의 package.json에서 package 이름으로 찾는다.
let tsc;
try {
  tsc = createRequire(join(client, 'package.json')).resolve('typescript/bin/tsc');
} catch (error) {
  console.error(`typescript build: typescript does not resolve from ${client} (${error.code ?? error.message}); run make install, which installs the TypeScript compiler`);
  process.exit(1);
}
const built = spawnSync(process.execPath, [tsc, '-p', join(client, 'tsconfig.build.json'), '--outDir', next], { stdio: 'inherit' });
if (built.status !== 0) {
  rmSync(next, { recursive: true, force: true });
  console.error(`typescript build: tsc exited with ${built.status ?? built.signal}; dist keeps the previous build`);
  process.exit(1);
}
if (existsSync(dist)) renameSync(dist, old);
renameSync(next, dist);
rmSync(old, { recursive: true, force: true });
