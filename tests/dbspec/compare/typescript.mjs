// Prints the TypeScript dbspec result of every shared case and of the stress
// document in the line format of tests/dbspec/compare/check.mjs.
//
// Usage: node tests/dbspec/compare/typescript.mjs <cases.json> <stress document>
// (after the TypeScript build)
import { readFileSync } from 'node:fs';
import { emitDbspec, parseDbspec } from '../../../clients/typescript/dist/dbspec/index.js';

const [casesPath, stressPath] = process.argv.slice(2);
if (casesPath === undefined || stressPath === undefined) {
  console.error('usage: node tests/dbspec/compare/typescript.mjs <cases.json> <stress document>');
  process.exit(2);
}

// join writes the lines with LF, with CRLF when crlf is true, or with
// alternating CRLF and LF and no final line end when mixed is true.
function join(lines, crlf, mixed) {
  if (mixed) return lines.map((line, i) => (i === lines.length - 1 ? line : line + (i % 2 === 0 ? '\r\n' : '\n'))).join('');
  const end = crlf ? '\r\n' : '\n';
  return lines.join(end) + end;
}

const out = [];

// write prints the diagnostics of text, or its emission when it has none.
function write(text, set, stress) {
  const result = parseDbspec(text, set);
  if (result.diagnostics.length > 0) {
    for (const d of result.diagnostics) out.push(`! ${d.rule} ${d.line} ${d.column}`);
    return;
  }
  const emitted = emitDbspec(result.document);
  if (stress) out.push(emitted === text ? '= unchanged' : '= changed');
  else for (const line of emitted.split('\n')) out.push(`| ${line}`);
}

const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
for (const kind of ['canonical', 'normalize', 'invalid']) {
  for (const c of cases[kind]) {
    const crlf = c.crlf === true;
    const mixed = c.mixed === true;
    const set = {};
    for (const [name, lines] of Object.entries(c.documents)) if (name !== c.main) set[name] = join(lines, crlf, mixed);
    out.push(`${kind}/${c.id}`);
    write(join(c.documents[c.main], crlf, mixed), set, false);
  }
}
out.push('stress');
write(readFileSync(stressPath, 'utf8'), {}, true);
process.stdout.write(out.join('\n') + '\n');
