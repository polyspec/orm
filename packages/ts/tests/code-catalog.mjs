// The generated error catalog of the TypeScript client, packages/ts/src/codes.ts, against docs/errors.yaml: every code of
// the catalog is an exported constant whose value is the code and whose note is the note of the catalog, and the file
// holds no other code. Usage: node packages/ts/tests/code-catalog.mjs
import { readFile } from 'node:fs/promises';
import { cases, COMPUTE } from '../../../tests/testcase.mts';

// readCatalog reads docs/errors.yaml, a flat list of "- code: X  # comment" lines each followed by "origin: Y", and returns
// each code with the note that its generated constant carries: the origin, then ": " and the comment when it has one.
function readCatalog(yaml) {
  const out = [];
  let comment = '';
  for (const line of yaml.split('\n')) {
    const text = line.trim();
    if (text.startsWith('- code:')) {
      const rest = text.slice('- code:'.length);
      const hash = rest.indexOf('#');
      out.push({ code: (hash < 0 ? rest : rest.slice(0, hash)).trim(), note: '' });
      comment = hash < 0 ? '' : rest.slice(hash + 1).trim();
    } else if (text.startsWith('origin:') && out.length > 0) {
      const origin = text.slice('origin:'.length).trim();
      out[out.length - 1].note = comment === '' ? origin : `${origin}: ${comment}`;
    }
  }
  if (out.length === 0) throw new Error('docs/errors.yaml lists no codes');
  return out;
}

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const run = cases();
await run.run('code-catalog/matches-errors-yaml', COMPUTE, async () => {
  const catalog = readCatalog(await readFile(new URL('../../../docs/errors.yaml', import.meta.url), 'utf8'));
  const source = await readFile(new URL('../src/codes.ts', import.meta.url), 'utf8');
  const problems = [];
  for (const { code, note } of catalog) {
    const line = new RegExp(`^// (.*)\\nexport const ${escape(code)} = '${escape(code)}';$`, 'm').exec(source);
    if (line === null) problems.push(`codes.ts has no constant for ${code}`);
    else if (line[1] !== note) problems.push(`codes.ts ${code}: ${JSON.stringify(line[1])}, docs/errors.yaml: ${JSON.stringify(note)}`);
  }
  const constants = source.match(/^export const \w+ = '\w+';$/gm) ?? [];
  if (constants.length !== catalog.length) problems.push(`codes.ts holds ${constants.length} codes, docs/errors.yaml ${catalog.length}`);
  if (problems.length > 0) throw new Error(`${problems.join('; ')}; run orm-gen errors --lang typescript --out packages/ts/src/codes.ts`);
});
await run.run('code-catalog/exported-from-package-root', COMPUTE, async () => {
  const catalog = readCatalog(await readFile(new URL('../../../docs/errors.yaml', import.meta.url), 'utf8'));
  const exported = await import('../dist/index.js');
  const missing = catalog.filter(({ code }) => exported.codes?.[code] !== code).map(({ code }) => code);
  if (missing.length > 0) throw new Error(`the package root does not export codes.${missing.join(', codes.')} with its code as value; run make typescript-build`);
});
run.finish();
