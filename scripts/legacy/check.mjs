import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
const forbiddenPaths = [
  /^cmd\/ormd(?:\/|$)/,
  /^proto\/orm\/compiler(?:\/|$)/,
  /^proto\/generated\.sha256\.json$/,
  /^clients\/(?:go|php|rust|typescript)\/.*(?:compiler_bridge|compiler_transport|ConnectCompiler|compiler\.ts|wasm|ffi)/i,
  /^(?:deploy|deployment)\//,
];
const found = tracked.filter(path => forbiddenPaths.some(pattern => pattern.test(path)));
if (found.length > 0) {
  throw new Error(`removed compiler artifacts are tracked:\n${found.join('\n')}`);
}

const makefile = readFileSync(join(root, 'Makefile'), 'utf8');
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
const obsolete = /(?:^|[\s:/_-])(proto-check|proto:|ormd|compiler_transport|compiler_bridge|wasm|ffi)(?:$|[\s/'"._-])/im;
for (const [name, text] of [['Makefile', makefile], ['.github/workflows/ci.yml', ci]]) {
  if (obsolete.test(text)) throw new Error(`${name} still references a removed compiler or deployment entry point`);
}
console.log(`legacy removal check: ${tracked.length} tracked paths inspected`);
