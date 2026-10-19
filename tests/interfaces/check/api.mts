// The API units of config/parity.json (kind api): each code of docs/spec/errors.yaml is one unit, whose symbol each client of its
// profile names. The checker reads the units from that file and refuses a unit, symbol or constant that does not match the
// catalog and the catalog file of its client. Units of other API symbols (codec, collection, AES) are not declared yet.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readParityConfig } from '../../../scripts/json/formats.mts';

type ApiSymbol = { implementation?: string; symbol?: string };
type ApiUnit = { id?: string; kind?: string; profile?: string; symbols?: ApiSymbol[] };
type ParityImplementation = { name?: string; errors?: { file?: string; pattern?: string } };
export type Parity = {
  implementations?: ParityImplementation[];
  profiles?: { name?: string; implementations?: string[] }[];
  units?: ApiUnit[];
};

const PREFIX = 'error-code-';

/** readParity reads config/parity.json, the one source of the units. */
export function readParity(root: string): Parity {
  return readParityConfig(join(root, 'config/parity.json'));
}

/** unitID is the unit of the catalog code `code`: error-code- and the code in lower case with - for _. */
function unitID(code: string): string {
  return `${PREFIX}${code.toLowerCase().replaceAll('_', '-')}`;
}

/**
 * apiProblems returns each way the error-catalog units of `parity` differ from the catalog `codes`: a code without its unit,
 * a unit that names no code, a client of the profile without its symbol, a symbol of a client outside the profile, and a
 * symbol that is no constant of the client's catalog file carrying the code. `sources` gives the text of a catalog file by its
 * path in the declaration; without it the file is read from `root`.
 */
export function apiProblems(root: string, parity: Parity, codes: Set<string>, sources?: Map<string, string>): string[] {
  const problems: string[] = [];
  const implementations = new Map((parity.implementations ?? []).map(entry => [entry.name ?? '', entry]));
  const units = (parity.units ?? []).filter(unit => (unit.id ?? '').startsWith(PREFIX));
  const byID = new Map<string, ApiUnit>();
  for (const unit of units) {
    const id = unit.id ?? '';
    if (byID.has(id)) problems.push(`API unit ${id} is declared twice`);
    byID.set(id, unit);
  }
  for (const code of codes) {
    if (!byID.has(unitID(code))) problems.push(`no API unit ${unitID(code)} for the code ${code} of docs/spec/errors.yaml`);
  }
  const catalogIDs = new Set([...codes].map(unitID));
  for (const unit of units) {
    const id = unit.id ?? '';
    if (unit.kind !== 'api') problems.push(`${id} is not of kind api`);
    if (!catalogIDs.has(id)) problems.push(`API unit ${id} names no code of docs/spec/errors.yaml`);
    const code = [...codes].find(entry => unitID(entry) === id);
    if (code === undefined) continue;
    const members = (parity.profiles ?? []).find(profile => profile.name === unit.profile)?.implementations;
    if (members === undefined) {
      problems.push(`API unit ${id} names the profile ${unit.profile ?? ''}, which parity.json does not declare`);
      continue;
    }
    const named = unit.symbols ?? [];
    for (const member of members) {
      const entries = named.filter(entry => entry.implementation === member);
      if (entries.length !== 1) problems.push(`API unit ${id} names ${entries.length} symbols of ${member}, want one`);
    }
    for (const entry of named) {
      const implementation = entry.implementation ?? '';
      const symbol = entry.symbol ?? '';
      if (!members.includes(implementation)) {
        problems.push(`API unit ${id} names ${implementation}, which is not an implementation of the profile ${unit.profile ?? ''}`);
        continue;
      }
      const errors = implementations.get(implementation)?.errors;
      if (errors?.file === undefined || errors.pattern === undefined) {
        problems.push(`${implementation} declares no error catalog file, so the symbol ${symbol} of ${id} has no constant to name`);
        continue;
      }
      const text = sources?.get(errors.file) ?? readFileSync(join(root, errors.file), 'utf8');
      const pattern = new RegExp(errors.pattern);
      const line = text.split('\n').find(candidate => pattern.exec(candidate)?.[1] === code);
      const identifier = /([A-Za-z_]\w*)(?::\w+)?$/.exec(symbol)?.[1] ?? '';
      if (line === undefined) problems.push(`${errors.file} has no constant for ${code}, which API unit ${id} names for ${implementation}`);
      else if (identifier === '' || !new RegExp(`\\b${identifier}\\b`).test(line)) {
        problems.push(`${implementation}: the symbol ${symbol} of ${id} is not the constant of ${code} in ${errors.file}`);
      }
    }
  }
  return problems;
}
