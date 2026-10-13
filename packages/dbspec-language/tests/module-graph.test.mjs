// The language service runs in a browser, so its module graph reaches no `node:` module, no bare module name other
// than the parser entry, and no Node global (Buffer, process, __dirname, require). The test starts at the built
// module of this package and follows every static import, re-export and literal dynamic import. The one bare name it
// may import is "@polyspec/orm/dbspec", which must resolve through the workspace to the parser entry; the graph of that
// entry belongs to its owner, and packages/orm-npm/tests/browser-entry.mjs checks it by the same rules (S7), so this
// test does not read past it. A dynamic import whose specifier is not a literal cannot be followed and is a violation.
//
// Usage: node --test packages/dbspec-language/tests/module-graph.test.mjs (after the build of this package and of
// packages/orm-npm)
import assert from 'node:assert/strict';
import { caseTest } from '../../../tests/testcase.mjs';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync, visitorKeys } from 'oxc-parser';

// The deadline of one case; each case runs through caseTest so it reports its RUN, PASS or FAIL line.
const TIMEOUT = 15000;
const vector = (name, body) => caseTest(name, TIMEOUT, body);

const pkgRoot = fileURLToPath(new URL('../', import.meta.url));
const start = resolve(pkgRoot, 'dist/index.js');
const parserEntry = resolve(pkgRoot, '../orm-npm/dist/dbspec/entry.js');
const ALLOWED_BARE = '@polyspec/orm/dbspec';

const FORBIDDEN_GLOBALS = new Set(['Buffer', 'process', '__dirname', 'require']);
const BUILTIN_ROOTS = new Set(builtinModules.map(m => m.replace(/^node:/, '').split('/')[0]));

/** Whether the identifier is a reference to a binding rather than the name of a property or a member. */
function isReference(node, parent) {
  if (parent.type === 'MemberExpression' && !parent.computed && parent.property === node) return false;
  if (parent.type === 'Property' && !parent.computed && !parent.shorthand && parent.key === node) return false;
  if ((parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition' || parent.type === 'AccessorProperty') && !parent.computed && parent.key === node) return false;
  return true;
}

/** The literal text of a module specifier: a string literal or a template literal without substitutions. */
function literal(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return undefined;
}

/** The import specifiers, dynamic imports with no literal specifier and forbidden identifier uses of one module. */
function scan(file) {
  const text = readFileSync(file, 'utf8');
  const parsed = parseSync(file, text);
  assert.deepEqual(parsed.errors.map(error => error.message), [], `${relative(pkgRoot, file)} parses`);
  const where = node => {
    const before = text.slice(0, node.start).split('\n');
    return `${relative(pkgRoot, file)}:${before.length}:${before.at(-1).length + 1}`;
  };
  const imports = [];
  const violations = [];
  const visit = (node, parent) => {
    if ((node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) {
      imports.push({ specifier: node.source.value, at: where(node) });
    } else if (node.type === 'ImportExpression') {
      const specifier = literal(node.source);
      if (specifier !== undefined) imports.push({ specifier, at: where(node) });
      else violations.push(`${where(node)} dynamic import with no literal specifier cannot be followed`);
    } else if (node.type === 'Identifier' && FORBIDDEN_GLOBALS.has(node.name) && isReference(node, parent)) {
      violations.push(`${where(node)} uses the Node global ${node.name}`);
    }
    for (const key of visitorKeys[node.type] ?? []) {
      for (const child of [node[key]].flat()) if (child) visit(child, node);
    }
  };
  visit(parsed.program, undefined);
  return { imports, violations };
}

/** Every file reachable from the start, with the violations found in each, and the files reached. */
function graph() {
  const seen = new Set();
  const entries = new Set();
  const violations = [];
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const { imports, violations: local } = scan(file);
    violations.push(...local);
    for (const { specifier, at } of imports) {
      if (specifier.startsWith('node:')) {
        violations.push(`${at} imports "${specifier}"`);
      } else if (specifier.startsWith('.') || specifier.startsWith('/')) {
        queue.push(resolve(dirname(file), specifier));
      } else if (specifier === ALLOWED_BARE) {
        const resolved = fileURLToPath(import.meta.resolve(ALLOWED_BARE));
        if (resolved !== parserEntry) violations.push(`${at} resolves "${ALLOWED_BARE}" to ${resolved}, not the parser entry`);
        entries.add(resolved);
      } else {
        const root = specifier.split('/')[0];
        violations.push(`${at} imports "${specifier}"${BUILTIN_ROOTS.has(root) ? ' (a Node builtin)' : ''}; only "${ALLOWED_BARE}" is allowed`);
      }
    }
  }
  return { violations, seen, entries };
}

vector('the language service graph reaches no node module, Node global or driver', () => {
  const { violations } = graph();
  assert.deepEqual(violations, []);
});

vector('the bare import of @polyspec/orm/dbspec resolves to the parser entry', () => {
  const { seen, entries } = graph();
  assert.ok(seen.has(start), 'the start module is read');
  assert.deepEqual([...entries], [parserEntry], 'the parser entry is reached through the workspace');
});
