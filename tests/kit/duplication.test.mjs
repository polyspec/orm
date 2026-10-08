// Tests that no function of scripts/kit exists twice. A shared piece lives in one module that its users import; a second copy
// in another file fails here.
//
// A function is a top-level declaration of a file: `function`, `async function`, `class` or `const NAME =` with `export` or
// without. It spans its first line and every following line that is indented or starts with a closing `}`, `)` or `]`.
//
// Normalization, applied before two functions are compared:
//   1. block comments, whole-line `//` comments and trailing `//` comments are removed;
//   2. the whitespace at both ends of a line is removed, runs of whitespace inside a line become one space, and blank lines
//      are removed;
//   3. the declared name is replaced by NAME and `export` is removed, so a copy under another name is still a copy.
// Two functions in different files with the same normalized text and at least MIN_LINES lines are duplicates. Local variable
// names are not changed, so a copy that renames its variables is not found by this test; review catches it.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ROOT } from '../../scripts/kit/paths.mjs';

const MIN_LINES = 6;
const KIT = path.join(ROOT, 'scripts/kit');

// Duplicates that are allowed, each as `{ files, reason }`; empty, because every shared piece has one module.
const EXEMPT = [];

const DECLARATION = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+(\w+)|class\s+(\w+)|const\s+(\w+)\s*=)/;

/** The text of `line` without a trailing `//` comment, when the `//` is outside quotes. */
function withoutLineComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
    } else if (character === '\'' || character === '"' || character === '`') quote = character;
    else if (character === '/' && line[index + 1] === '/' && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index);
  }
  return line;
}

/** The functions of `text` as `{ name, line, lines }`, with `lines` normalized. */
export function functionsOf(text) {
  const lines = text.replace(/\/\*[\s\S]*?\*\//g, match => '\n'.repeat(match.split('\n').length - 1)).split('\n');
  const found = [];
  for (let start = 0; start < lines.length; start += 1) {
    const declaration = DECLARATION.exec(lines[start]);
    if (!declaration) continue;
    let end = start;
    for (let next = start + 1; next < lines.length; next += 1) {
      const line = lines[next];
      if (line.trim() === '') {
        const following = lines.slice(next + 1).find(candidate => candidate.trim() !== '');
        if (following !== undefined && /^(\s|[})\]])/.test(following)) continue;
        break;
      }
      if (/^\s/.test(line)) { end = next; continue; }
      if (/^[})\]]/.test(line)) end = next;
      break;
    }
    const name = declaration[1] ?? declaration[2] ?? declaration[3];
    const body = lines.slice(start, end + 1).map(withoutLineComment).map(line => line.trim().replace(/\s+/g, ' ')).filter(Boolean);
    body[0] = body[0].replace(/^export /, '').replace(new RegExp(`\\b${name}\\b`), 'NAME');
    found.push({ name, line: start + 1, lines: body });
    start = end;
  }
  return found;
}

/** The groups of functions with the same normalized text in at least two files: `[{ lines, places: ['file:line name', ...] }]`. */
export function duplicates(files, minimum = MIN_LINES) {
  const byText = new Map();
  for (const [file, text] of Object.entries(files)) {
    for (const fn of functionsOf(text)) {
      if (fn.lines.length < minimum) continue;
      const key = fn.lines.join('\n');
      if (!byText.has(key)) byText.set(key, { lines: fn.lines.length, entries: [] });
      byText.get(key).entries.push({ file, place: `${file}:${fn.line} ${fn.name}` });
    }
  }
  return [...byText.values()]
    .filter(group => new Set(group.entries.map(entry => entry.file)).size > 1)
    .map(group => ({ lines: group.lines, files: [...new Set(group.entries.map(entry => entry.file))].sort(), places: group.entries.map(entry => entry.place) }));
}

const KIT_FILES = Object.fromEntries(readdirSync(KIT).filter(name => name.endsWith('.mjs')).sort().map(name => [name, readFileSync(path.join(KIT, name), 'utf8')]));

test(`no function of scripts/kit of ${MIN_LINES} lines or more exists in two files`, () => {
  const exempt = group => EXEMPT.some(entry => entry.files.join(',') === group.files.join(','));
  const found = duplicates(KIT_FILES).filter(group => !exempt(group));
  assert.deepEqual(found.map(group => `${group.lines} lines: ${group.places.join(' = ')}`), [], 'move the function into one module of scripts/kit and import it where it is used');
});

test('every exemption names its files and a reason', () => {
  for (const entry of EXEMPT) {
    assert.ok(entry.files.length > 1 && entry.reason.length > 20, JSON.stringify(entry));
    for (const file of entry.files) assert.ok(file in KIT_FILES, `${file} is not a file of scripts/kit`);
  }
});

test('the detector reads the functions of the modules of scripts/kit', () => {
  const names = functionsOf(KIT_FILES['holder-lock.mjs']).map(fn => fn.name);
  for (const expected of ['procStart', 'processStart', 'holderRunning', 'acquireHolderLock', 'removeDeadLock', 'main']) assert.ok(names.includes(expected), `${expected} in [${names.join(', ')}]`);
});

test('the detector finds a copy that differs in name, whitespace, comments and export, and not a different function', (t) => {
  const body = ['{', '  const total = values.reduce((sum, value) => sum + value, 0);', '  if (total > 10) {', '    return total;', '  }', '  return 0;', '}'];
  const original = `// The sum.\nexport function sum(values) ${body.join('\n')}\n`;
  const renamed = `/* block */\nconst addAll = (values) => ${body.join('\n').replace(/^\{/, '{ // trailing comment').replace(/  const total/, '    const   total')}\n`.replace('const addAll = (values) =>', 'function addAll(values)');
  const different = original.replace('total > 10', 'total > 11').replace('sum(', 'other(');
  const found = duplicates({ 'a.mjs': original, 'b.mjs': renamed, 'c.mjs': different });
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.deepEqual(found[0].files, ['a.mjs', 'b.mjs']);
  assert.equal(found[0].lines, 7);
  assert.deepEqual(duplicates({ 'a.mjs': original, 'b.mjs': original }, 8), [], 'a function shorter than the minimum is not compared');
  assert.deepEqual(duplicates({ 'a.mjs': `${original}${original.replace('sum', 'sum2')}` }), [], 'a copy in the same file is not reported');
});

test('the detector keeps a comment marker inside a string', () => {
  const text = 'function url() {\n  const a = \'http://x\';\n  const b = "// not a comment";\n  const c = `a // b`;\n  return [a, b, c];\n}\n';
  assert.deepEqual(functionsOf(text)[0].lines.slice(1, 4), ['const a = \'http://x\';', 'const b = "// not a comment";', 'const c = `a // b`;']);
});

test('the detector runs on a directory written to disk', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'kit-duplication-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(directory, { recursive: true });
  const text = 'export function copy(a) {\n  const b = a + 1;\n  const c = b + 1;\n  const d = c + 1;\n  const e = d + 1;\n  return e;\n}\n';
  writeFileSync(path.join(directory, 'one.mjs'), text);
  writeFileSync(path.join(directory, 'two.mjs'), text.replace('copy', 'again'));
  const files = Object.fromEntries(readdirSync(directory).map(name => [name, readFileSync(path.join(directory, name), 'utf8')]));
  assert.equal(duplicates(files).length, 1);
});
