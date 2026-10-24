import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const tsc = fileURLToPath(new URL('../../../node_modules/.bin/tsc', import.meta.url));
const source = fileURLToPath(new URL('./complex-query-request.types.ts', import.meta.url));
const dir = await mkdtemp(path.join(tmpdir(), 'orm-complex-query-request-types-'));
try {
  const config = path.join(dir, 'tsconfig.json');
  await writeFile(config, JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: true, types: [] },
    files: [source],
  }));
  await promisify(execFile)(tsc, ['-p', config, '--pretty', 'false']);
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log('complex-query-request-types: ok');
