// The error catalog of every implementation: each code of docs/spec/errors.yaml is one constant of the catalog file of each
// implementation of contracts/implementations.json, which orm-gen writes from the same file. The checker refuses a code that a
// catalog file lacks or holds twice, a constant of a catalog file that names no code, and an implementation with no catalog file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readImplementations } from '../../../scripts/json/formats.mts';

/** The catalog file of each implementation and the pattern of its line, whose group 1 is the code. */
export const ERROR_CATALOGS: Record<string, { file: string; pattern: string }> = {
  go: { file: 'packages/go/orm/codes.go', pattern: '^\\tCode\\w+\\s+= "(\\w+)"' },
  php: { file: 'packages/php/src/Code.php', pattern: "^    public const (\\w+) = '\\w+';$" },
  'php-extension': { file: 'packages/php-ext/src/polyspec_orm.stub.php', pattern: "^    public const (?:string )?(\\w+) = '\\1';$" },
  typescript: { file: 'packages/ts/src/codes.ts', pattern: "^export const (\\w+) = '\\w+';$" },
  python: { file: 'packages/python/src/polyspec/orm/codes.py', pattern: '^(\\w+) = "\\w+"$' },
  rust: { file: 'packages/rust/orm/src/codes.rs', pattern: '^pub const (\\w+): &str = "\\w+";$' },
};

/** The implementations of orm (contracts/implementations.json). */
export function readImplementationNames(root: string): string[] {
  return readImplementations(join(root, 'contracts/implementations.json')).map(entry => entry.name);
}

/**
 * apiProblems returns each way the catalog file of an implementation of `implementations` differs from the catalog `codes`: an
 * implementation with no catalog file, a code its file lacks or holds twice, and a constant of its file that names no code.
 * `sources` gives the text of a catalog file by its path; without it the file is read from `root`.
 */
export function apiProblems(root: string, implementations: readonly string[], codes: Set<string>, sources?: Map<string, string>, catalogs = ERROR_CATALOGS): string[] {
  const problems: string[] = [];
  for (const implementation of implementations) {
    const catalog = catalogs[implementation];
    if (catalog === undefined) {
      problems.push(`${implementation} declares no error catalog file`);
      continue;
    }
    const text = sources?.get(catalog.file) ?? readFileSync(join(root, catalog.file), 'utf8');
    const pattern = new RegExp(catalog.pattern);
    const found = text.split('\n').flatMap(line => {
      const code = pattern.exec(line)?.[1];
      return code === undefined ? [] : [code];
    });
    for (const code of codes) {
      const count = found.filter(entry => entry === code).length;
      if (count !== 1) problems.push(`${catalog.file} holds ${count} constants for ${code} of docs/spec/errors.yaml, want one (${implementation})`);
    }
    for (const code of new Set(found)) if (!codes.has(code)) problems.push(`${catalog.file} holds the constant ${code}, which docs/spec/errors.yaml does not declare (${implementation})`);
  }
  return problems;
}
