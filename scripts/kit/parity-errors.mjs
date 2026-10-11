// R7 of the language-parity check: every implementation of the profile of `errors` has the codes of the catalog, read from the
// generated artifact that each implementation declares, no code more and no code less. The catalog pattern reads every line of
// the catalog that is not blank or a comment (`#` or `//`), so no code escapes it; a line that the pattern matches without its
// group holds no code. A catalog or an artifact from which the pattern reads no code is a declaration finding. Whether a
// generated artifact matches its catalog is the repository's own generator check, which runs before the parity check.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { captured, difference, finding } from './parity-declaration.mjs';

const COMMENT = /^(?:#|\/\/)/;

/** The codes of the catalog and of each implementation artifact, and the declaration findings of reading them. */
export function readCodes(model, root) {
  const errors = model.config.errors;
  const codes = { catalog: new Set(), implementations: new Map() };
  if (!errors) return { codes, findings: [] };
  const findings = [];
  const { file, pattern } = errors.catalog;
  readFileSync(path.join(root, file), 'utf8').split('\n').forEach((line, index) => {
    if (!line.trim() || COMMENT.test(line.trim())) return;
    const match = new RegExp(pattern).exec(line);
    if (!match) findings.push(finding('declaration', `the catalog pattern ${pattern} does not read the line ${JSON.stringify(line)}; write a pattern that reads every line of the catalog`, { place: `${file}:${index + 1}` }));
    else if (match[1] !== undefined) codes.catalog.add(match[1]);
  });
  if (!findings.length && !codes.catalog.size) findings.push(finding('declaration', `the catalog pattern ${pattern} reads no code`, { place: file }));
  for (const implementation of model.config.implementations.filter(entry => entry.errors)) {
    const read = new Set(captured(readFileSync(path.join(root, implementation.errors.file), 'utf8'), implementation.errors.pattern).map(match => match.text).filter(Boolean));
    if (!read.size) findings.push(finding('declaration', `the pattern ${implementation.errors.pattern} of ${implementation.name} reads no code`, { place: implementation.errors.file }));
    codes.implementations.set(implementation.name, read);
  }
  return { codes, findings };
}

/** R7: the codes of each implementation of the profile against the catalog. */
export function errorCatalog(model, codes) {
  const errors = model.config.errors;
  if (!errors) return [];
  return model.profiles.get(errors.profile).map(name => model.implementations.get(name)).flatMap((implementation) => {
    if (!implementation.errors) return [finding('R7', `${implementation.name} declares no error codes; name its generated codes in errors of the implementation`, { implementation: implementation.name, place: errors.catalog.file })];
    const differs = difference([...codes.catalog], [...codes.implementations.get(implementation.name)], 'the catalog');
    return differs ? [finding('R7', `the codes differ from ${errors.catalog.file}: ${differs}`, { implementation: implementation.name, place: implementation.errors.file })] : [];
  });
}
