// markdown-table check: the table "Markdown IR executor" of docs/spec/dialects.md and docs/spec/dialects.ko.md holds one row per
// row of the capability table of flowmark's docs/spec/60-dialect.md (and its Korean twin) at the version pinned in
// tests/markdown/flowmark.version, with the same surface and the same ruling text, the ruling split into a Result and
// a Rule. `node scripts/docs/markdown-table.mts` checks both files; `--write` rewrites the table in both.
//
// The tables are read with mdast-util-from-markdown and mdast-util-gfm (tables.mts), so an escaped pipe stays in its cell.
// The split is mechanical so that the check can recompute it: the Result is the ruling up to the first top-level
// "; ", ": ", " — " or ". " (outside code spans, parentheses and brackets), and the Rule is the rest. A relative link
// of flowmark's document becomes the absolute link to the pinned revision, to the English document in both languages and without the anchor of a heading, as the translation of a document
// keeps the link targets of its source and a heading has another anchor in each language.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Link, Nodes } from 'mdast';
import { root } from './lib.mts';
import { parse, tableUnder, textOf } from './tables.mts';

const version = (await readFile(path.join(root, 'tests/markdown/flowmark.version'), 'utf8')).trim();
const revision = version.split('-').pop();
// The module source of the pinned flowmark, which make orm-install-flowmark downloads into the module cache; a check
// downloads nothing, so a missing module names the install target instead of fetching.
const cache = execFileSync('go', ['env', 'GOMODCACHE'], { cwd: root, encoding: 'utf8' }).trim();
const module = { Dir: path.join(cache, 'github.com', `polyspec/flowmark@${version}`) };
if (!existsSync(module.Dir)) throw new Error(`${module.Dir} is missing; run make orm-install-flowmark, which downloads the module of tests/markdown/flowmark.version`);

// A relative link of the ruling: a spec of flowmark (NN-name.md or NN-name.ko.md) with an optional anchor.
const relativeLink = /^(\d\d-[a-z-]+(?:\.ko)?\.md)(?:#.*)?$/;
const links = (node: Nodes): Link[] => (node.type === 'link' ? [node] : 'children' in node ? node.children.flatMap(links) : []);

// absolute rewrites the relative links of a ruling's source text to the English spec at the pinned revision, without the anchor.
// The links are found by the parser, so a `](...)` inside a code span is not one; each rewrite keeps the text before the destination.
const absolute = (ruling: string): string => {
  let text = ruling;
  for (const link of links(parse(ruling)).filter(link => relativeLink.test(link.url)).reverse()) {
    const start = link.position?.start.offset;
    const end = link.position?.end.offset;
    if (start === undefined || end === undefined) throw new Error(`the parser gave the link ${link.url} no offset`);
    const file = relativeLink.exec(link.url)?.[1] ?? '';
    const destination = text.slice(start, end).lastIndexOf('](');
    text = `${text.slice(0, start + destination)}](https://github.com/polyspec/flowmark/blob/${revision}/docs/spec/${file.replace('.ko.md', '.md')})${text.slice(end)}`;
  }
  return text;
};

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

// rows reads the surface table of a flowmark spec 60: the first table under its Surfaces heading, one line per surface.
function rows(text: string) {
  const surfaces = tableUnder(text, heading => heading.depth === 2 && /^Surfaces?$/.test(textOf(heading)));
  if (surfaces === undefined) throw new Error('the spec 60 of the pinned flowmark has no Surfaces heading with a table; run make orm-install-flowmark to install the version that tests/markdown/flowmark.version pins');
  return surfaces.rows.map(cells => {
    if (cells.length !== 2) throw new Error(`a surface row of the pinned flowmark spec 60 has ${cells.length} cells, not 2: ${cells.join(' | ')}`);
    const [surface = '', ruling = ''] = cells;
    const [result, rule] = split(absolute(ruling));
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
  const table = tableUnder(text, heading => heading.depth === 2 && `## ${textOf(heading)}` === t.heading);
  if (table === undefined) { failures.push(`${t.file}: no table under "${t.heading}"`); continue; }
  const lines = text.split('\n');
  // The header is the first line of the table (1-based), its body follows the delimiter line.
  const first = table.line - 1;
  const last = table.endLine - 1;
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
