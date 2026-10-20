// The browser-safe dbspec entry (docs/spec/editor.md "Layers"): the module that the package's "./dbspec" subpath
// exports must reach no `node:` module, no Node builtin, no package outside BROWSER_PACKAGES (such as a driver),
// no Node global (Buffer, process, __dirname, require), and must export exactly the parser functions. The test
// starts at the subpath's built module, read from package.json, and follows every static import, re-export and
// literal dynamic import transitively, into the modules of a BROWSER_PACKAGES package as well, which are checked by
// the same rules. A dynamic import whose specifier is not a literal cannot be followed and is a violation.
//
// Usage: node --test packages/ts/tests/browser-entry.mjs (after the build)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync, visitorKeys } from 'oxc-parser';
import { caseTest } from '../../../tests/testcase.mts';

// The deadline of one case; each case runs through caseTest so it reports its RUN, PASS or FAIL line.
const TIMEOUT = 15000;

const pkgRoot = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8'));
const subpath = pkg.exports['./dbspec'];
const start = resolve(pkgRoot, subpath.import);

// Node globals that the entry must not read. A use is an identifier in expression position; a property name such
// as `x.process` or an object key is not a use.
const FORBIDDEN_GLOBALS = new Set(['Buffer', 'process', '__dirname', 'require']);
// The packages that the entry may import: each is written for browsers and Node alike, and its modules are followed
// and checked like the entry's own. @noble/hashes gives the synchronous SHA-256 of the renderer names (names.ts).
const BROWSER_PACKAGES = new Set(['@noble/hashes']);
// Every Node builtin root name, with and without the node: prefix, so `fs/promises` is caught through `fs`.
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

/** Every module reachable from the subpath's module, with the violations found in each. */
function graph() {
  const seen = new Set();
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
        continue;
      }
      let target;
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
        const parts = specifier.split('/');
        const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
        if (!BROWSER_PACKAGES.has(name)) {
          const kind = BUILTIN_ROOTS.has(parts[0]) ? 'a Node builtin' : 'a bare module (a package such as a driver)';
          violations.push(`${at} imports "${specifier}", ${kind}`);
          continue;
        }
        target = createRequire(file).resolve(specifier);
      } else {
        target = resolve(dirname(file), specifier);
      }
      if (!target.endsWith('.js')) {
        violations.push(`${at} imports "${specifier}", which is not a built .js module`);
        continue;
      }
      queue.push(target);
    }
  }
  return { modules: seen, violations };
}

// Requirements: ORE-6, ORES-53, ORES-54, ORES-55.
caseTest('the subpath module reaches no Node module, undeclared package or Node global', TIMEOUT, () => {
  const { modules, violations } = graph();
  assert.ok(modules.size > 1, 'the graph follows the imports of the subpath module');
  assert.deepEqual(violations, [], `the browser entry reaches a Node or driver dependency:\n${violations.join('\n')}`);
});

// Requirements: ORE-1, ORES-52.
caseTest('the subpath module exports exactly the parser functions', TIMEOUT, async () => {
  const entry = await import(start);
  assert.deepEqual(
    Object.keys(entry).sort(),
    ['analyzeDbspec', 'emitDbspec', 'formatDbspec', 'parseDbspec', 'parseDbspecSet', 'parseSet', 'readDbspecBytes'],
  );
});
