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
import { caseTest } from '../../../tests/testcase.mts';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBuiltinModule, scanModule } from '../../../tests/module-scan.mjs';
import { walkModules } from '../../../tests/module-graph.mjs';

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
    const targets = [];
    for (const { specifier, at } of imports) {
      if (specifier.startsWith('node:')) {
        local.push(`${at} imports "${specifier}"`);
      } else if (specifier.startsWith('.') || specifier.startsWith('/')) {
        targets.push(resolve(dirname(file), specifier));
      } else if (specifier === ALLOWED_BARE) {
        const resolved = fileURLToPath(import.meta.resolve(ALLOWED_BARE));
        if (resolved !== parserEntry) local.push(`${at} resolves "${ALLOWED_BARE}" to ${resolved}, not the parser entry`);
        entries.add(resolved);
      } else {
        const root = specifier.split('/')[0];
        local.push(`${at} imports "${specifier}"${isBuiltinModule(root) ? ' (a Node builtin)' : ''}; only "${ALLOWED_BARE}" is allowed`);
      }
    }
    return { targets, violations: local };
  });
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
