import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';

const roots = [
  'proto/orm/compiler/v1/compiler.proto',
  'proto/orm/compiler/v1/compiler.pb.go',
  'proto/orm/compiler/v1/compilerv1connect',
  'clients/php/src/Proto',
  'clients/rust/orm/src/gen',
  'clients/typescript/src/gen',
];
const files = [];
async function collect(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
  if (entries === null) { files.push(path); return; }
  for (const entry of entries) await collect(`${path}/${entry.name}`);
}
for (const root of roots) await collect(root);
files.sort();
const hashes = {};
for (const file of files) hashes[file] = createHash('sha256').update(await readFile(file)).digest('hex');
await writeFile('proto/generated.sha256.json', `${JSON.stringify({ version: 1, files: hashes }, null, 2)}\n`);
