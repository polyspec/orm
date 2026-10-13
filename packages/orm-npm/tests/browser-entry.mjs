// The browser-safe dbspec entry (docs/editor.md "Layers"): the module that the package's "./dbspec" subpath
// exports must reach no `node:` module, no bare module name (a Node builtin or a package such as a driver),
// no Node global (Buffer, process, __dirname, require), and must export exactly the parser functions. The test
// starts at the subpath's built module, read from package.json, and follows every static import, re-export and
// literal dynamic import transitively. A dynamic import whose specifier is not a literal cannot be followed and
// is a violation.
//
// Usage: node --test packages/orm-npm/tests/browser-entry.mjs (after the build)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const pkgRoot = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8'));
const subpath = pkg.exports['./dbspec'];
const start = resolve(pkgRoot, subpath.import);

// Node globals that the entry must not read. A use is an identifier in expression position; a property name such
// as `x.process` or an object key is not a use.
const FORBIDDEN_GLOBALS = new Set(['Buffer', 'process', '__dirname', 'require']);
// Every Node builtin root name, with and without the node: prefix, so `fs/promises` is caught through `fs`.
const BUILTIN_ROOTS = new Set(builtinModules.map(m => m.replace(/^node:/, '').split('/')[0]));

/** Whether the identifier is a reference to a binding rather than the name of a property or a member. */
function isReference(node) {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if ((ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) && parent.name === node) return false;
  return true;
}

/** The import specifiers, dynamic imports with no literal specifier and forbidden identifier uses of one module. */
function scan(file) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const where = node => {
    const at = source.getLineAndCharacterOfPosition(node.getStart(source));
    return `${relative(pkgRoot, file)}:${at.line + 1}:${at.character + 1}`;
  };
  const imports = [];
  const violations = [];
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      imports.push({ specifier: node.moduleSpecifier.text, at: where(node) });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) imports.push({ specifier: arg.text, at: where(node) });
      else violations.push(`${where(node)} dynamic import with no literal specifier cannot be followed`);
    } else if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text) && isReference(node)) {
      violations.push(`${where(node)} uses the Node global ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
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
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
        const root = specifier.split('/')[0];
        const kind = BUILTIN_ROOTS.has(root) ? 'a Node builtin' : 'a bare module (a package such as a driver)';
        violations.push(`${at} imports "${specifier}", ${kind}`);
        continue;
      }
      const target = resolve(dirname(file), specifier);
      if (!target.endsWith('.js')) {
        violations.push(`${at} imports "${specifier}", which is not a built .js module`);
        continue;
      }
      queue.push(target);
    }
  }
  return { modules: seen, violations };
}

test('the subpath module reaches no Node module, bare module or Node global', () => {
  const { modules, violations } = graph();
  assert.ok(modules.size > 1, 'the graph follows the imports of the subpath module');
  assert.deepEqual(violations, [], `the browser entry reaches a Node or driver dependency:\n${violations.join('\n')}`);
});

test('the subpath module exports exactly the parser functions', async () => {
  const entry = await import(start);
  assert.deepEqual(
    Object.keys(entry).sort(),
    ['analyzeDbspec', 'emitDbspec', 'formatDbspec', 'parseDbspec', 'readDbspecBytes'],
  );
});
