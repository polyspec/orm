import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const source = fileURLToPath(new URL('../src/index.js', import.meta.url));
const tsc = fileURLToPath(new URL('../../../node_modules/.bin/tsc', import.meta.url));
const complexQueryTypes = fileURLToPath(new URL('./complex-query.types.ts', import.meta.url));
const dir = await mkdtemp(path.join(tmpdir(), 'orm-fulltext-chain-types-'));
try {
  await writeFile(path.join(dir, 'call.ts'), `import { Author } from ${JSON.stringify(source)};\nnew Author().fulltextBooleanNameWithDescription('alpha beta');\nnew Author().fulltextNameWithDescription('alpha');\n// @ts-expect-error full-text methods take text columns only\nnew Author().fulltextBooleanReadCount('seven');\n`);
  await writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: true, types: [] },
    files: ['call.ts', complexQueryTypes],
  }));
  await promisify(execFile)(tsc, ['-p', path.join(dir, 'tsconfig.json'), '--pretty', 'false']);
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log('fulltext-chain-types: ok');
