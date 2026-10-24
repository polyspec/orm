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
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseTest } from '../../../tests/testcase.mts';
import { isBuiltinModule, scanModule } from '../../../tests/module-scan.mjs';
import { walkModules } from '../../../tests/module-graph.mjs';

// The deadline of one case; each case runs through caseTest so it reports its RUN, PASS or FAIL line.
const TIMEOUT = 15000;

const pkgRoot = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8'));
const subpath = pkg.exports['./dbspec'];
const start = resolve(pkgRoot, subpath.import);

// Node globals that the entry must not read. A use is an identifier in expression position; a property name such
// as `x.process` or an object key is not a use.
// The packages that the entry may import: each is written for browsers and Node alike, and its modules are followed
// and checked like the entry's own. @noble/hashes gives the synchronous SHA-256 of the renderer names (names.ts).
const BROWSER_PACKAGES = new Set(['@noble/hashes']);
/** Every module reachable from the subpath's module, with the violations found in each. */
function graph() {
  const { modules, violations } = walkModules(start, file => {
    const { imports, violations: local } = scanModule(file, pkgRoot);
    const targets = [];
    for (const { specifier, at } of imports) {
      if (specifier.startsWith('node:')) {
        local.push(`${at} imports "${specifier}"`);
        continue;
      }
      let target;
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
        const parts = specifier.split('/');
        const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
        if (!BROWSER_PACKAGES.has(name)) {
          const kind = isBuiltinModule(specifier) ? 'a Node builtin' : 'a bare module (a package such as a driver)';
          local.push(`${at} imports "${specifier}", ${kind}`);
          continue;
        }
        target = createRequire(file).resolve(specifier);
      } else {
        target = resolve(dirname(file), specifier);
      }
      if (!target.endsWith('.js')) {
        local.push(`${at} imports "${specifier}", which is not a built .js module`);
        continue;
      }
      targets.push(target);
    }
    return { targets, violations: local };
  });
  return { modules, violations };
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
