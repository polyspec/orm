#!/usr/bin/env node
// The language-parity check (`make parity-check`, `make parity-declarations-check`). config/parity.json declares the
// implementations of the repository, the one source of its language set, the profiles that group them and the units that
// every implementation of a profile holds: vector suites, API symbols, the error-code catalog, native-only symbols and
// exclusions. The facts come from the tree, never from a flag in the declaration: the checker runs the binding of each suite
// itself and keeps the ledger of the cases that ran, reads the exported symbols from the extractor snapshot of each
// implementation and the error codes from its generated artifact.
//
//   node scripts/kit/parity.mjs [--declarations]
//     --declarations  check the declarations only: every rule except R3, and no binding runs
//
// The rules, each a finding that fails the check:
//   R1 missing-implementation  an API unit has no exported symbol in an implementation of its profile
//   R2 missing-binding         a suite has no binding of an implementation of its profile
//   R3 not-executed            a binding exits with an error, the cases that passed are not exactly the cases of the suite,
//                              or its second run gives another status, case or result than its first; a run whose
//                              environment reference is unset or empty cannot start
//   R4 undeclared-suite        a file of the suite globs is the file of no suite unit
//   R5 undeclared-test         a test file of an implementation, other than a support file, is the test of no binding, or
//                              a node, php or python support file reports a case when it runs
//   R6 misplaced-test          the test of a binding lies outside the roots of its implementation, or a file of the test
//                              patterns of a runner, other than a support file of that runner, lies outside its roots
//   R7 error-catalog           the codes of an implementation differ from the catalog, or it declares none
//   R8 exclusion               an exclusion: it never counts as holding the unit
//   R9 language-set-drift      a declared list of implementation names in another file differs from its profile
//   R10 docs-count             a document counts implementations that no profile of that count holds, or lists
//                              implementations in a sentence whose names are no profile
//   R11 undeclared-public      an exported symbol that no API unit and no native-only entry declares
// A declaration that breaks the schema or names what does not exist is a finding of `declaration`, and no rule runs on it.
import { parseArgs } from 'node:util';
import { DECLARATION, findingLine, readDeclaration } from './parity-declaration.mjs';
import { errorCatalog, readCodes } from './parity-errors.mjs';
import { runBindings } from './parity-ledger.mjs';
import { documentCounts, languageLists } from './parity-text.mjs';
import { exclusions, misplacedTests, missingBindings, missingImplementations, undeclaredPublic, undeclaredSuites, undeclaredTests } from './parity-units.mjs';
import { isMain, ROOT } from './paths.mjs';
import { checkedFiles } from './tracked-files.mjs';

/**
 * The check of the checkout at `root`: `{ findings, ledger }`, the findings in the order of the rules. `execute` runs the
 * bindings (R3) with the environment `env`; `say` prints a line for each step.
 */
export function checkParity(root, { execute = true, env = process.env, say = () => {} } = {}) {
  const files = new Set(checkedFiles(root));
  say(`read ${DECLARATION}`);
  const declaration = readDeclaration(root, files);
  const model = declaration.model;
  const ledger = { runs: [], cases: [] };
  if (declaration.errors.length) return { findings: declaration.errors, ledger };
  const { codes, findings: unreadable } = readCodes(model, root);
  if (unreadable.length) return { findings: unreadable, ledger };
  for (const profile of model.narrow) say(`profile ${profile.name} omits ${profile.omitted.join(', ')}: ${profile.reason}`);
  const executed = execute ? runBindings(model, root, { env, files, say }) : { ledger, findings: [] };
  say('check the units against the tree');
  const findings = [
    ...missingImplementations(model),
    ...missingBindings(model),
    ...executed.findings,
    ...undeclaredSuites(model, files),
    ...undeclaredTests(model, files),
    ...misplacedTests(model, files),
    ...errorCatalog(model, codes),
    ...exclusions(model),
    ...languageLists(model, root),
    ...documentCounts(model, root, files),
    ...undeclaredPublic(model),
  ];
  return { findings, ledger: executed.ledger };
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { declarations: { type: 'boolean' } } });
  const say = text => console.log(`[parity] ${text}`);
  const { findings, ledger } = checkParity(ROOT, { execute: !values.declarations, say });
  if (!values.declarations) say(`${ledger.runs.length / 2} bindings ran twice, ${ledger.cases.filter(entry => entry.outcome === 'pass').length} cases passed`);
  for (const item of findings) console.error(`[parity] ${findingLine(item)}`);
  if (findings.length) console.error(`[parity] ${findings.length} findings`);
  else say(values.declarations ? 'every declaration holds' : 'every unit holds in every implementation');
  process.exitCode = findings.length ? 1 : 0;
}
