// Tests of scripts/kit/check-documents.mjs: each rule has a passing and a failing case, and a finding names the file, the
// line and the rule.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../../scripts/kit/check-documents.mjs';
import { checkConfig } from '../../scripts/kit/kit-check.mjs';
import { pair, put, tree } from './tree.mjs';

const CONFIG = { schema: 1, include: ['**/*.md'] };
const run = (root, config = CONFIG) => check(root, config).findings;
const has = (findings, text) => assert.ok(findings.some(line => line === text), `expected ${text}\nin\n${findings.join('\n')}`);
const hasPart = (findings, ...parts) => assert.ok(findings.some(line => parts.every(part => line.includes(part))), `expected ${parts.join(' ... ')}\nin\n${findings.join('\n')}`);

test('a pair with the same doc-id, revision, anchors, fences and links passes', (t) => {
  const body = '<a id="intro"></a>\nSee [other](other.md#title) and [site](https://example.org).\n\n```sh\nmake check\n```\n';
  const root = tree(t, { ...pair('a.md', 'alpha', body), ...pair('other.md', 'other') });
  assert.deepEqual(run(root), []);
});

test('pair-missing: a file without its twin fails in both directions', (t) => {
  const files = pair('a.md', 'alpha');
  const root = tree(t, { 'a.md': files['a.md'], 'b.ko.md': files['a.ko.md'] });
  const found = run(root);
  has(found, 'a.md: pair-missing: the Korean twin a.ko.md does not exist; every English document has one');
  has(found, 'b.ko.md: pair-missing: the English file b.md does not exist; every Korean document has an English original');
});

test('exclude and include select the documents', (t) => {
  const root = tree(t, { 'docs/a.md': '# lone\n', 'fixtures/b.md': '# lone\n' });
  assert.deepEqual(run(root, { schema: 1, include: ['docs/**'], exclude: ['docs/a.md'] }), []);
  assert.equal(run(root, { schema: 1, include: ['docs/**'] }).length, 1);
});

test('doc-id: a missing, different or repeated id fails', (t) => {
  const files = pair('a.md', 'alpha');
  const root = tree(t, { ...files, ...pair('b.md', 'alpha'), 'c.md': '# c\n', 'c.ko.md': '# c\n' });
  const found = run(root);
  has(found, 'b.md: doc-id: the doc-id alpha is also the doc-id of a.md; an id names one document');
  hasPart(found, 'c.md: doc-id: the file has 0 doc-id markers');
  put(root, { 'a.ko.md': files['a.ko.md'].replace('doc-id: alpha', 'doc-id: beta') });
  hasPart(run(root), 'a.ko.md: doc-id: the doc-id is beta; the English file a.md has alpha');
  put(root, { 'a.md': files['a.md'].replace('doc-id: alpha', 'doc-id: Bad_Id') });
  hasPart(run(root), 'a.md: doc-id: the doc-id "Bad_Id" does not match');
});

test('doc-id and revision markers written in inline code or a fenced block are not markers', (t) => {
  const body = 'Write `<!-- doc-id: x -->` and `<!-- source-sha256: y -->`.\n\n```\n<!-- doc-id: z -->\n```\n';
  assert.deepEqual(run(tree(t, pair('a.md', 'alpha', body))), []);
});

test('revision: the Korean marker must equal the sha256 of the English file', (t) => {
  const files = pair('a.md', 'alpha', 'text\n');
  const root = tree(t, files);
  assert.deepEqual(run(root), []);
  put(root, { 'a.md': `${files['a.md']}changed\n` });
  hasPart(run(root), 'a.ko.md: revision: the source-sha256 is ', 'review the translation');
  put(root, { 'a.ko.md': files['a.ko.md'].replace(/<!-- source-sha256.*-->\n/, '') });
  hasPart(run(root), 'a.ko.md: revision: the file has 0 source-sha256 markers');
});

test('sections: explicit anchors must be equal and unique', (t) => {
  const root = tree(t, pair('a.md', 'alpha', '<a id="one"></a>\n<a id="two"></a>\n', '<a id="one"></a>\n'));
  hasPart(run(root), 'a.ko.md: sections: the section anchors are [one]', 'a.md has [one, two]');
  put(root, pair('a.md', 'alpha', '<a id="one"></a>\n<a id="one"></a>\n'));
  hasPart(run(root), 'a.md: sections: the section anchor one appears more than once');
});

test('fences: blocks must be equal, closed and keep their info string', (t) => {
  const en = '```sh\nmake check\n```\n\n~~~\nplain\n~~~\n';
  assert.deepEqual(run(tree(t, pair('a.md', 'alpha', en))), []);
  const body = (text) => tree(t, pair('a.md', 'alpha', en, text));
  hasPart(run(body('```sh\nmake test\n```\n\n~~~\nplain\n~~~\n')), 'a.ko.md:', ': fences: the fenced code block 1 differs from a.md');
  hasPart(run(body('```bash\nmake check\n```\n\n~~~\nplain\n~~~\n')), 'fences: the fenced code block 1 differs');
  hasPart(run(body('```sh\nmake check\n```\n')), 'fences: the fenced code block 2 differs', 'the files have 1 and 2 blocks');
  hasPart(run(body('```sh\nmake check\n')), 'a.ko.md:', 'fences: the fenced code block opened here never closes');
});

test('link: a relative link must resolve, inside the repository', (t) => {
  const root = tree(t, { ...pair('docs/a.md', 'alpha', 'See [x](missing.md), [y](../../outside.md), [z](a.md?x=1), [ok](../b.md).\n'), ...pair('b.md', 'bee') });
  const found = run(root);
  has(found, 'docs/a.md:4:9: link: the link missing.md names docs/missing.md, which does not exist');
  hasPart(found, 'docs/a.md:4:', 'link: the link ../../outside.md leaves the repository');
  hasPart(found, 'link: the link a.md?x=1 has a query');
  assert.equal(found.filter(line => line.startsWith('docs/a.md') && line.includes('b.md')).length, 0, found.join('\n'));
});

test('link: an anchor must be an explicit anchor or a heading', (t) => {
  const root = tree(t, { ...pair('a.md', 'alpha', '[a](b.md#target) [h](b.md#the-heading) [bad](b.md#nope) [file](b.md.txt#x)\n'), ...pair('b.md', 'bee', '<a id="target"></a>\n## The heading\n') });
  const found = run(root);
  hasPart(found, 'link: the link b.md#nope names the anchor #nope, which b.md does not define');
  assert.equal(found.filter(line => line.includes('#target') || line.includes('#the-heading')).length, 0, found.join('\n'));
});

test('link: code is not read, a reference needs its definition, an absolute link depends on siteLinks', (t) => {
  const body = '`[x](missing.md)`\n\n```\n[y](missing.md)\n```\n\n[ref][one] and [other][two]\n\n[one]: b.md\n\n[abs](/guide/start)\n';
  const files = { ...pair('a.md', 'alpha', body), ...pair('b.md', 'bee') };
  const root = tree(t, files);
  const found = run(root);
  assert.equal(found.filter(line => line.includes('missing.md')).length, 0, found.join('\n'));
  hasPart(found, 'a.md:', 'link: the reference link [other][two] has no definition [two]');
  hasPart(found, 'link: the link /guide/start starts with /');
  assert.equal(run(root, { ...CONFIG, siteLinks: true }).filter(line => line.includes('/guide/start')).length, 0);
  put(root, { 'a.md': files['a.md'].replace('[abs](/guide/start)', '[site](b)'), 'a.ko.md': files['a.ko.md'].replace('[abs](/guide/start)', '[site](b)') });
  hasPart(run(root), 'link: the link b names b, which does not exist');
  assert.equal(run(root, { ...CONFIG, siteLinks: true }).filter(line => line.includes('names b,')).length, 0);
});

test('private-path: a home directory path fails', (t) => {
  const root = tree(t, pair('a.md', 'alpha', 'Run /Users/someone/work/run.sh now.\n'));
  hasPart(run(root), 'a.md:4:5: private-path: the document holds the path /Users/someone/ into a home directory');
  assert.deepEqual(run(tree(t, pair('a.md', 'alpha', 'Run scripts/run.sh now.\n'))), []);
});

test('interpolation: {{ outside a code block fails in the selected documents', (t) => {
  const files = pair('docs/a.md', 'alpha', 'Write `{{ x }}` or <code v-pre>{{ y }}</code>.\n\n```\n{{ z }}\n```\n', 'Write `{{ x }}` or <code v-pre>{{ y }}</code>.\n\n```\n{{ z }}\n```\n');
  const root = tree(t, files);
  assert.equal(run(root).length, 0, 'unselected documents are not read');
  const found = run(root, { ...CONFIG, interpolation: ['docs/**'] });
  hasPart(found, 'docs/a.md:4:8: interpolation: {{ outside a fenced code block');
  assert.equal(found.filter(line => line.startsWith('docs/a.md')).length, 1, 'the v-pre element and the fenced block are not read');
});

const FOUR_STATES = ['[ ]', '[~]', '[o]', '[!]'];
const TABLE = { path: 'plan.md', translation: 'plan.ko.md', format: 'table', idPattern: 'T[0-9]+(?:\\.[0-9]+)*(?:-[0-9]+)*', states: FOUR_STATES, active: '[~]' };
const LIST = { path: 'plan.md', translation: 'plan.ko.md', format: 'list', idPattern: '[A-Z][A-Za-z0-9.-]*', states: FOUR_STATES, active: '[~]' };
const checklist = (rows, extra = '') => `# Plan\n\n${extra}| ID | Task | State |\n| --- | --- | --- |\n${rows}\n`;
const withChecklist = (t, en, ko = en, config = TABLE) => tree(t, { ...pair(config.path, 'plan', en.replace(/^# Plan\n/, '').trimStart(), ko.replace(/^# Plan\n/, '').trimStart()) });
const run2 = (root, list = TABLE) => {
  put(root, { 'config/checklist.json': JSON.stringify({ schema: 1, hooks: ['pre-push'], trackers: [list] }) });
  return run(root);
};

test('checklist table: the four states pass, derived sub-items included', (t) => {
  const rows = '| T1.1 | a | [o] |\n| T1.2 | b | [ ] |\n| T1.2-1 | c | [~] |\n| T1.3 `parallel` | d | [!] cause: blocked by T1.2; retry: T1.2 done |';
  assert.deepEqual(run2(withChecklist(t, checklist(rows))), []);
});

test('checklist table: an invalid state, a duplicate task and a missing state cell fail', (t) => {
  const root = withChecklist(t, checklist('| T1.1 | a | done |\n| T1.2 | b | [!] cause: x |\n| T1.3 | c | [o] |\n| T1.3 | d | [o] |\n| T1.4 | no end | [o]'));
  const found = run2(root);
  hasPart(found, 'plan.md:', ': checklist-state: the state of T1.1 is "done"');
  hasPart(found, 'checklist-state: the state of T1.2 is "[!] cause: x"');
  hasPart(found, 'checklist-duplicate: the task T1.3 has a second row');
  hasPart(found, 'checklist-state: the row of T1.4 does not end with a state cell');
});

test('checklist table: a marker outside the state and a line that is not a task fail with line and column', (t) => {
  const stray = checklist('| T1.1 | print [~] | [o] |\n| T1.2 | b | [x] |', 'Legend: [ ] waiting.\n\n');
  const found = run2(withChecklist(t, stray));
  hasPart(found, 'plan.md:', ':1: checklist-line: the line is not a heading or a task table row');
  for (const marker of ['[ ]', '[~]']) hasPart(found, 'checklist-marker: the state marker ' + marker + ' is not the state of a task');
  hasPart(found, 'checklist-state: the state of T1.2 is "[x]"');
  const cell = found.find(line => line.startsWith('plan.md:') && line.includes('marker [~]'));
  assert.match(cell, /^plan\.md:8:16: checklist-marker/, cell);
});

test('checklist table: a row whose first cell is not a task ID is not allowed', (t) => {
  const found = run2(withChecklist(t, checklist('| T1.1 | a | [o] |\n| Notes | b | [o] |')));
  hasPart(found, 'checklist-line: the first cell "Notes" is not a task ID matching');
});

test('checklist table: a document without task rows fails', (t) => {
  hasPart(run2(withChecklist(t, checklist(''))), 'checklist-empty: the checklist has no task whose ID matches');
});

test('checklist list: items, sub-items and a bypass with cause and retry pass', (t) => {
  const list = LIST;
  const text = '# Plan\n\n## Wave\n\n- [o] C1 First\n  - [~] C1.1 Sub-item\n- [ ] C2 Second\n  continued text\n- [!] C3 Third\n  Cause: blocked. Retry: when C2 is done.\n';
  assert.deepEqual(run2(withChecklist(t, text, text, list), list), []);
});

test('checklist list: a bypass without cause, an unknown state, a stray marker and free text fail', (t) => {
  const list = LIST;
  const text = '# Plan\n\n- [!] C1 First\n- [x] C2 Second\n- [o] C3 mentions [ ] here\n\nfree text\n- [ ] C3 again\n';
  const found = run2(withChecklist(t, text, text, list), list);
  hasPart(found, 'checklist-state: the bypassed task C1 names no cause');
  hasPart(found, 'checklist-state: the bypassed task C1 names no retry condition');
  hasPart(found, 'checklist-state: the state of C2 is [x]');
  hasPart(found, 'checklist-marker: the state marker [ ] is not the state of a task');
  hasPart(found, 'checklist-line: the line is not a heading, a task item');
  hasPart(found, 'checklist-duplicate: the task C3 has a second row');
});

test('checklist-pair: the Korean checklist has the same tasks and states', (t) => {
  const en = checklist('| T1.1 | a | [o] |\n| T1.2 | b | [ ] |');
  assert.deepEqual(run2(withChecklist(t, en, checklist('| T1.1 | 가 | [o] |\n| T1.2 | 나 | [ ] |'))), []);
  hasPart(run2(withChecklist(t, en, checklist('| T1.1 | 가 | [o] |\n| T1.2 | 나 | [~] |'))), 'plan.ko.md:', 'checklist-pair: the state of T1.2 is [~]; plan.md has [ ]');
  hasPart(run2(withChecklist(t, en, checklist('| T1.1 | 가 | [o] |'))), 'plan.ko.md: checklist-pair: the task IDs differ from plan.md');
  const bypass = checklist('| T1.1 | a | [!] cause: blocked; retry: later |');
  assert.deepEqual(run2(withChecklist(t, bypass, checklist('| T1.1 | 가 | [!] 원인: 막힘; 재시도: 나중 |'))), [], 'the cause text is translated, the state is compared');
});

test('checklist list: a state outside the declared states fails, and the states of a tracker apply to its items', (t) => {
  const text = '# Plan\n\n- [o] C1 First\n- [?] C2 Second\n- [~] C3 Third\n';
  const found = run2(withChecklist(t, text, text, LIST), LIST);
  hasPart(found, 'plan.md:', 'checklist-state: the state of C2 is [?]; expected [ ], [~], [o] or [!]');
  assert.equal(found.filter(line => line.includes('checklist-state')).length, 2, '[?] is wrong in the English and the Korean file');
  const reduced = { ...LIST, states: ['[ ]', '[o]'], active: '[ ]' };
  hasPart(run2(withChecklist(t, '# Plan\n\n- [~] C1 First\n', undefined, reduced), reduced), 'checklist-state: the state of C1 is [~]; expected [ ] or [o]');
});

test('checklist: a task ID may be followed by a code span, and a checklist without a translation reads its English file only', (t) => {
  const rows = '| T1.1 `parallel` | a | [o] |\n| T1.2 | b | [~] |';
  const solo = { ...TABLE, translation: undefined };
  const root = tree(t, { 'plan.md': `<!-- doc-id: plan -->\n${checklist(rows)}`, 'plan.ko.md': '<!-- doc-id: plan -->\n# Plan\n\nfree text that no checklist rule reads\n' });
  const found = run2(root, solo);
  assert.equal(found.filter(line => line.includes('checklist-')).length, 0, found.join('\n'));
});

test('checklist: an invalid config/checklist.json is a finding of the document check', (t) => {
  const root = tree(t, pair('plan.md', 'plan'));
  put(root, { 'config/checklist.json': JSON.stringify({ schema: 1, hooks: ['pre-push'], trackers: [{ path: 'plan.md', format: 'tree', active: '[~]' }] }) });
  hasPart(run(root), 'config/checklist.json: config: ', '$.trackers[0].format is "tree"');
});

const FEATURES = { path: 'features.md', idPattern: '[a-z][a-z0-9-]*', cells: 4, columns: [{ index: 1, enum: ['planned', 'implemented'] }, { index: 3, pattern: '\\]\\([^)]+\\)' }] };
const table = rows => `| ID | Status | Note | Evidence |\n| --- | --- | --- | --- |\n${rows}\n`;
const withTable = (t, en, ko = en) => tree(t, pair('features.md', 'features', en, ko));

test('status-table: declared cells and values pass and are equal in both languages', (t) => {
  const rows = '| parse | implemented | Parse | [g](g.md) |\n| print | planned | Print | [g](g.md) |';
  const root = tree(t, { ...pair('features.md', 'features', table(rows), table(rows.replaceAll('Parse', '파싱'))), ...pair('g.md', 'guide') });
  assert.deepEqual(run(root, { ...CONFIG, statusTables: [FEATURES] }), []);
});

test('status-table: a bad value, a missing evidence link, a wrong cell count, a repeated ID and a language mismatch fail', (t) => {
  const en = table('| parse | done | Parse | [g](g.md) |\n| print | planned | Print | none |\n| odd | planned | [g](g.md) |\n| parse | planned | Parse | [g](g.md) |');
  const root = tree(t, { ...pair('features.md', 'features', en), ...pair('g.md', 'guide') });
  const found = run(root, { ...CONFIG, statusTables: [FEATURES] });
  hasPart(found, 'features.md:', ': status-table: the row parse has "done" in cell 2; expected planned, implemented');
  hasPart(found, 'status-table: the row print has "none" in cell 4; expected a match of');
  hasPart(found, 'status-table: the row odd has 3 cells; expected 4');
  hasPart(found, 'status-table: the row parse repeats the ID of line');
  const good = '| parse | implemented | Parse | [g](g.md) |';
  const mismatch = tree(t, { ...pair('features.md', 'features', table(good), table(good.replace('implemented', 'planned'))), ...pair('g.md', 'guide') });
  hasPart(run(mismatch, { ...CONFIG, statusTables: [FEATURES] }), 'features.ko.md: status-table: the rows differ from features.md');
  hasPart(run(withTable(t, 'no table here\n'), { ...CONFIG, statusTables: [FEATURES] }), 'status-table: the table has no row');
});

test('changelog: Unreleased first, versions newest first, same sections in both languages', (t) => {
  const log = '# Changes\n\n## Unreleased\n\n## 1.2.0\n\n- x\n\n## 1.1.0\n';
  const config = { ...CONFIG, changelogs: ['CHANGELOG.md'] };
  assert.deepEqual(run(tree(t, pair('CHANGELOG.md', 'changelog', log.replace('# Changes\n\n', ''))), config), []);
  const bad = '## 1.1.0\n\n## 1.2.0\n\n## Unreleased\n\n## Unreleased\n\n## next\n';
  const found = run(tree(t, pair('CHANGELOG.md', 'changelog', bad)), config);
  hasPart(found, 'changelog: the first section is ## 1.1.0');
  hasPart(found, 'changelog: the section ## 1.2.0 follows ## 1.1.0');
  hasPart(found, 'changelog: ## Unreleased appears 2 times');
  hasPart(found, 'changelog: the section ## next is neither ## Unreleased nor a released version');
  const mismatch = pair('CHANGELOG.md', 'changelog', '## Unreleased\n\n## 1.0.0\n', '## Unreleased\n');
  hasPart(run(tree(t, mismatch), config), 'CHANGELOG.ko.md:', 'changelog: the sections ## Unreleased differ');
});

test('the command reads config/documents.json and exits with the findings', (t) => {
  const root = tree(t, { ...pair('a.md', 'alpha'), 'b.md': '# lone\n', 'config/documents.json': JSON.stringify(CONFIG) });
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  cpSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/kit'), path.join(root, 'scripts/kit'), { recursive: true });
  const failed = spawnSync(process.execPath, ['scripts/kit/check-documents.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /\[check-documents\] b\.md: pair-missing: /);
  put(root, { 'b.md': null });
  const passed = spawnSync(process.execPath, ['scripts/kit/check-documents.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /1 document pairs/);
});

test('config/documents.json is validated against its schema', (t) => {
  const root = tree(t, { 'config/documents.json': JSON.stringify({ schema: 1, include: ['docs/**'], checklists: [{ path: 'a.md', style: 'grid', idPattern: 'T' }], statusTables: [{ path: 'f.md', idPattern: 'x', cells: 0, columns: [] }], extra: true }) });
  mkdirSync(path.join(root, 'scripts/kit'), { recursive: true });
  cpSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/kit/schema'), path.join(root, 'scripts/kit/schema'), { recursive: true });
  const found = checkConfig(root);
  hasPart(found, 'config/documents.json: $.checklists is not in the schema');
  hasPart(found, '$.statusTables[0].cells is 0, the schema requires at least 1');
  hasPart(found, '$.extra is not in the schema');
});
