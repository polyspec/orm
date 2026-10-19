// markdown-table check: the table "Markdown IR executor" of docs/spec/dialects.md and docs/spec/dialects.ko.md holds one row per
// row of the capability table of flowmark's docs/spec/60-dialect.md (and its Korean twin) at the version pinned in
// tests/markdown/flowmark.version, with the same surface and the same ruling text, the ruling split into a Result and
// a Rule. `node scripts/docs/markdown-table.mts` checks both files; `--write` rewrites the table in both.
//
// The split is mechanical so that the check can recompute it: the Result is the ruling up to the first top-level
// "; ", ": ", " — " or ". " (outside code spans, parentheses and brackets), and the Rule is the rest. A relative link
// of flowmark's document becomes the absolute link to the pinned revision, to the English document in both languages and without the anchor of a heading, as the translation of a document
// keeps the link targets of its source and a heading has another anchor in each language.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from './lib.mts';

const version = (await readFile(path.join(root, 'tests/markdown/flowmark.version'), 'utf8')).trim();
const revision = version.split('-').pop();
// The module source of the pinned flowmark, which make orm-install-flowmark downloads into the module cache; a check
// downloads nothing, so a missing module names the install target instead of fetching.
const cache = execFileSync('go', ['env', 'GOMODCACHE'], { cwd: root, encoding: 'utf8' }).trim();
const module = { Dir: path.join(cache, 'github.com', `polyspec/flowmark@${version}`) };
if (!existsSync(module.Dir)) throw new Error(`${module.Dir} is missing; run make orm-install-flowmark, which downloads the module of tests/markdown/flowmark.version`);

const absolute = (text: string) => text.replace(/\]\((\d\d-[a-z-]+(?:\.ko)?\.md)(#[^)]*)?\)/g,
  (_, file: string) => `](https://github.com/polyspec/flowmark/blob/${revision}/docs/spec/${file.replace('.ko.md', '.md')})`);

// split returns the Result and the Rule of a ruling.
function split(ruling: string): [string, string] {
  let depth = 0;
  let code = false;
  for (let i = 0; i < ruling.length; i++) {
    const c = ruling[i];
    if (c === '`') code = !code;
    if (code) continue;
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0) {
      for (const d of ['; ', ': ', ' — ', '. ']) {
        if (ruling.startsWith(d, i)) return [ruling.slice(0, i), ruling.slice(i + d.length)];
      }
    }
  }
  return [ruling, ''];
}

// cells splits a table row at the pipes that are not inside code spans.
function cells(line: string) {
  const out = [];
  let cell = '';
  let code = false;
  for (const c of line.replace(/^\|/, '').replace(/\|\s*$/, '')) {
    if (c === '`') code = !code;
    if (c === '|' && !code) { out.push(cell.trim()); cell = ''; } else cell += c;
  }
  out.push(cell.trim());
  return out;
}

// rows reads the surface table of a flowmark spec 60: the first table under its Surfaces heading.
function rows(text: string) {
  const lines = text.split('\n');
  const start = lines.findIndex(l => /^## Surfaces?$/.test(l));
  if (start < 0) throw new Error('the spec 60 of the pinned flowmark has no Surfaces heading');
  const table = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('|')) table.push(line);
    else if (table.length > 0) break;
  }
  return table.slice(2).map(line => {
    const [surface, ruling] = cells(line);
    const [result, rule] = split(absolute(ruling ?? ''));
    return `| ${surface} | ${result} | ${rule} |`;
  });
}

const targets = [
  { file: 'docs/spec/dialects.md', spec: 'docs/spec/60-dialect.md', heading: '## Markdown IR executor', header: '| Surface | Result | Rule |' },
  { file: 'docs/spec/dialects.ko.md', spec: 'docs/spec/60-dialect.ko.md', heading: '## Markdown IR executor', header: '| 표면 | 결과 | 규칙 |' },
];

const write = process.argv.includes('--write');
const failures = [];
for (const t of targets) {
  const expected = rows(await readFile(path.join(module.Dir, t.spec), 'utf8'));
  const text = await readFile(path.join(root, t.file), 'utf8');
  const lines = text.split('\n');
  const heading = lines.findIndex(l => l === t.heading);
  if (heading < 0) { failures.push(`${t.file}: no "${t.heading}" section`); continue; }
  const first = lines.findIndex((l, i) => i > heading && l.startsWith('|'));
  let last = first;
  while (lines[last + 1]?.startsWith('|')) last++;
  const have = lines.slice(first + 2, last + 1);
  if (write) {
    lines.splice(first, last - first + 1, t.header, '|---|---|---|', ...expected);
    await writeFile(path.join(root, t.file), lines.join('\n'));
    continue;
  }
  if (lines[first] !== t.header) failures.push(`${t.file}: the table header is not ${t.header}`);
  for (let i = 0; i < Math.max(have.length, expected.length); i++) {
    if (have[i] !== expected[i]) failures.push(`${t.file}: row ${i + 1} differs from ${t.spec} at ${version}\n  have: ${have[i]}\n  want: ${expected[i]}`);
  }
}
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(write ? 'markdown-table: rewritten' : `markdown-table: ${targets.length} tables mirror flowmark spec 60 at ${version}`);
