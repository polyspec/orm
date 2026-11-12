// Runs tsc once over generated TypeScript files, each use of the client a file of its own, so that tsc reports each rejected use at its file.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';

const tsc = fileURLToPath(new URL('../../../../node_modules/.bin/tsc', import.meta.url));

/** The tsc diagnostics of each text, by its index; each text is the file `<name><index>.ts` of a new directory with the prefix. */
export async function tscDiagnostics(prefix, name, texts) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    const files = texts.map((_, i) => `${name}${i}.ts`);
    for (const [i, text] of texts.entries()) await writeFile(path.join(dir, files[i]), text);
    await writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', lib: JSON.parse(readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8')).compilerOptions.lib, module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: true, types: [] },
      files,
    }));
    let output = '';
    try {
      await promisify(execFile)(tsc, ['-p', path.join(dir, 'tsconfig.json'), '--pretty', 'false']);
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    }
    const byIndex = texts.map(() => []);
    const located = new RegExp(`${name}(\\d+)\\.ts\\(\\d+,\\d+\\): (error .*)$`);
    for (const line of output.split('\n')) {
      const m = located.exec(line);
      if (m !== null) byIndex[Number(m[1])].push(m[2]);
      else if (line.includes('error TS')) throw new Error(`tsc reported an error outside the ${name} files: ${line}`);
    }
    return byIndex;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
