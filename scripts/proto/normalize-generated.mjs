import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const roots = [
  'clients/php/src/Proto',
  'clients/rust/orm/src/gen',
  'clients/typescript/src/gen',
];

async function normalize(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      await normalize(child);
    } else if (['.php', '.rs', '.ts'].includes(extname(entry.name))) {
      const source = await readFile(child, 'utf8');
      const output = source.replace(/\n+$/u, '\n');
      if (output !== source) await writeFile(child, output);
    }
  }
}

for (const root of roots) await normalize(root);
