// The language service runs in a browser, so its module graph reaches no `node:` module, no bare module name other
// than the parser entry, and no Node global (Buffer, process, __dirname, require). The test starts at the built
// module of this package and follows every static import, re-export and literal dynamic import. The one bare name it
// may import is "@polyspec/orm/dbspec", which must resolve through the workspace to the parser entry; the graph of that
// entry belongs to its owner, and packages/ts/tests/browser-entry.mjs checks it by the same rules (S7), so this
// test does not read past it. A dynamic import whose specifier is not a literal cannot be followed and is a violation.
//
// Usage: node --test packages/dbspec-language/tests/module-graph.test.mjs (after the build of this package and of
// packages/ts)
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { caseTest } from '../../../tests/testcase.mts';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBuiltinModule, scanModule } from '../../../tests/module-scan.mjs';
import { resolveImports, walkModules } from '../../../tests/module-graph.mjs';

// The deadline of one case; each case runs through caseTest so it reports its RUN, PASS or FAIL line.
const TIMEOUT = 15000;
const vector = (name, body) => caseTest(name, TIMEOUT, body);

const pkgRoot = fileURLToPath(new URL('../', import.meta.url));
const start = resolve(pkgRoot, 'dist/index.js');
const parserEntry = resolve(pkgRoot, '../ts/dist/dbspec/entry.js');
const ALLOWED_BARE = '@polyspec/orm/dbspec';

/** Every file reachable from the start, with the violations found in each, and the files reached. */
function graph() {
  const entries = new Set();
  const { modules: seen, violations } = walkModules(start, file => {
    const { imports, violations: local } = scanModule(file, pkgRoot);
    const inspected = resolveImports(imports, (specifier, at) => {
      if (specifier.startsWith('node:')) {
        return { violation: `${at} imports "${specifier}"` };
      } else if (specifier.startsWith('.') || specifier.startsWith('/')) {
        return { target: resolve(dirname(file), specifier) };
      } else if (specifier === ALLOWED_BARE) {
        const resolved = fileURLToPath(import.meta.resolve(ALLOWED_BARE));
        entries.add(resolved);
        if (resolved !== parserEntry) {
          return { violation: `${at} resolves "${ALLOWED_BARE}" to ${resolved}, not the parser entry` };
        }
        return {};
      } else {
        const root = specifier.split('/')[0];
        return { violation: `${at} imports "${specifier}"${isBuiltinModule(root) ? ' (a Node builtin)' : ''}; only "${ALLOWED_BARE}" is allowed` };
      }
    });
    return { targets: inspected.targets, violations: [...local, ...inspected.violations] };
  });
  return { violations, seen, entries };
}

/** Every adapter-owned module is followed, with the language service as the only parser boundary. */
function adapterGraph() {
  const packages = [
    { root: resolve(pkgRoot, '../dbspec-lsp'), entries: ['src/index.ts', 'src/server.ts'] },
    { root: resolve(pkgRoot, '../dbspec-codemirror'), entries: ['src/index.ts'] },
    { root: resolve(pkgRoot, '../dbspec-vscode'), entries: ['src/extension.ts', 'src/server.ts'] },
  ];
  const localTarget = (file, specifier) => {
    const target = resolve(dirname(file), specifier);
    for (const candidate of [target, target.replace(/\.js$/, '.ts'), `${target}.ts`, `${target}.js`, `${target}.cjs`, resolve(target, 'index.ts'), resolve(target, 'index.js')]) {
      if (existsSync(candidate)) return candidate;
    }
    return target;
  };
  const violations = [];
  for (const { root, entries } of packages) {
    for (const entry of entries) {
      const start = resolve(root, entry);
      const result = walkModules(start, file => {
        const { imports, violations: local } = scanModule(file, root);
        const resolved = resolveImports(imports, (specifier, at) => {
          if (specifier.startsWith('@polyspec/orm')) return { violation: `${at} imports parser package "${specifier}" outside the language service` };
          if (specifier.startsWith('.') || specifier.startsWith('/')) return { target: localTarget(file, specifier) };
          return {};
        });
        return { targets: resolved.targets, violations: [...local, ...resolved.violations] };
      });
      violations.push(...result.violations);
    }
  }
  return violations;
}

// Requirements: ORE-5, ORES-44, ORES-46.
vector('the language service graph reaches no node module, Node global or driver', () => {
  const { violations } = graph();
  assert.deepEqual(violations, []);
});

vector('the bare import of @polyspec/orm/dbspec resolves to the parser entry', () => {
  const { seen, entries } = graph();
  assert.ok(seen.has(start), 'the start module is read');
  assert.deepEqual([...entries], [parserEntry], 'the parser entry is reached through the workspace');
});

// Requirements: ORE-4, ORES-44, ORES-45.
vector('the adapters import no parser package outside the language service', () => {
  assert.deepEqual(adapterGraph(), []);
});
