// cases.mts reads tests/dbspec/cases.json against its schema (schema/cases.schema.json), as strictly as the Go reader
// (packages/go/engine/dbspec/vectors_test.go decodeCaseVectors): every section and every field of the format is present with its type,
// a section or field the format does not name is refused, and every section has a case. The schema cannot state that the
// main document of a case is one of its documents; checkCases checks it.
import { readFileSync } from 'node:fs';
import { checkJson, parseJson, SchemaError, type SchemaIssue } from '../../scripts/json/schema.mts';

const NAME = 'tests/dbspec/cases.json';
const SCHEMA = new URL('./schema/cases.schema.json', import.meta.url).pathname;

/** Lines of text, each without its line end. */
type Lines = string[];
/** An error that a case expects: its line, column and rule. */
type CaseError = { line: number; column: number; rule: string };
/** A case of documents, its main document and the line ends it is written with. */
type DocumentCase = { id: string; documents: Record<string, Lines>; main: string; crlf?: boolean; mixed?: boolean };
/** tests/dbspec/cases.json, the shape its schema declares. */
export type Cases = {
  version: 1;
  note: string;
  canonical: DocumentCase[];
  normalize: (DocumentCase & { canonical: Lines })[];
  invalid: (DocumentCase & { errors: CaseError[] })[];
  hashes: { id: string; documents: Record<string, Lines>; manifestText: Lines; schemaText: Lines; manifestHash: string; schemaHash: string }[];
  sets: {
    id: string; documents: Lines[]; parsing: Record<string, Lines>; errors: CaseError[]; external?: Lines[];
    manifest?: { manifestText: Lines; externalText: Lines; schemaText: Lines; created: Lines; manifestHash: string; schemaHash: string };
  }[];
  files: { id: string; path: string; errors: CaseError[] }[];
  positions: { id: string; documents: Record<string, Lines>; main: string; positions: { kind: string; path: Lines; line: number; column: number }[] }[];
};

// mainErrors refuses each case whose main document is not one of its documents, as the schema refuses a missing
// required property: the documents of the case must have the property that main names.
function mainErrors(cases: Cases, name: string): SchemaError | null {
  const sections = { canonical: cases.canonical, normalize: cases.normalize, invalid: cases.invalid, positions: cases.positions };
  const issues: SchemaIssue[] = Object.entries(sections).flatMap(([section, list]) => list.flatMap((item, index) =>
    Object.hasOwn(item.documents, item.main) ? [] : [{ pointer: `/${section}/${index}/documents`, keyword: 'required', params: { missingProperty: item.main } }]));
  if (issues.length === 0) return null;
  return new SchemaError(issues.map(issue => `${name}: ${issue.pointer} must have required property '${String(issue.params['missingProperty'])}', the main document of the case`), issues);
}

/** checkCases checks a parsed cases.json value against its schema and its main documents and returns it typed. */
export function checkCases(value: unknown, name = NAME): Cases {
  const cases = checkJson<Cases>(value, SCHEMA, name);
  const refused = mainErrors(cases, name);
  if (refused) throw refused;
  return cases;
}

/** parseCases reads the text of a cases.json strictly; name names it in the errors. */
export function parseCases(text: string, name: string): Cases {
  const cases = parseJson<Cases>(text, SCHEMA, name);
  const refused = mainErrors(cases, name);
  if (refused) throw refused;
  return cases;
}

/** readCases reads tests/dbspec/cases.json of the repository strictly. */
export function readCases(): Cases {
  return parseCases(readFileSync(new URL('cases.json', import.meta.url), 'utf8'), NAME);
}
