// cases.mts reads tests/dbspec/cases.json against its schema (schema/cases.schema.json), as strictly as the Go reader
// (packages/go/engine/dbspec/vector_loaders_test.go decodeCaseVectors): every section and every field of the format is present with its type,
// and a section or field the format does not name is refused. The document cases moved to the recipes (tests/dbspec/*.json);
// cases.json keeps the hashes and the sets.
import { readFileSync } from 'node:fs';
import { checkJson, parseJson } from '../../scripts/json/schema.mts';

const NAME = 'tests/dbspec/cases.json';
const SCHEMA = new URL('./schema/cases.schema.json', import.meta.url).pathname;

/** Lines of text, each without its line end. */
type Lines = string[];
/** A case of the hashes section: its documents and the manifest and schema it gives. */
type HashCase = { id: string; documents: Record<string, Lines>; manifestText: Lines; schemaText: Lines; manifestHash: string; schemaHash: string };
/** A case of the sets section: its owned documents, the parsing and external documents and the errors it expects. */
type SetCase = {
  id: string; documents: Lines[]; parsing: Record<string, Lines>; errors: { line: number; column: number; rule: string }[]; external?: Lines[];
  manifest?: { manifestText: Lines; externalText: Lines; schemaText: Lines; created: Lines; manifestHash: string; schemaHash: string };
};
/** tests/dbspec/cases.json, the shape its schema declares. */
export type Cases = { version: 1; note: string; hashes: HashCase[]; sets: SetCase[] };

/** checkCases checks a parsed cases.json value against its schema and returns it typed. */
export function checkCases(value: unknown, name = NAME): Cases {
  return checkJson<Cases>(value, SCHEMA, name);
}

/** parseCases reads the text of a cases.json strictly; name names it in the errors. */
export function parseCases(text: string, name: string): Cases {
  return parseJson<Cases>(text, SCHEMA, name);
}

/** readCases reads tests/dbspec/cases.json of the repository strictly. */
export function readCases(): Cases {
  return parseCases(readFileSync(new URL('cases.json', import.meta.url), 'utf8'), NAME);
}
