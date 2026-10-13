// Shared helpers of the language service tests: the vectors of tests/dbspec, the line model of the parser and the
// UTF-16 offsets of a code point index. They are test code only; the service never imports them.
import { readFileSync } from 'node:fs';

/** The repository root. */
export const repo = new URL('../../../', import.meta.url);

/** A vector file of tests/dbspec, parsed. */
export function vectorsFile(name) {
  return JSON.parse(readFileSync(new URL(`tests/dbspec/${name}`, repo), 'utf8'));
}

/**
 * Joins the lines of a vector the way the vectors do: with LF, with CRLF when crlf is true, or alternating CRLF and
 * LF with no final line end when mixed is true.
 */
export function join(lines, crlf, mixed = false) {
  if (mixed) return lines.map((line, i) => (i === lines.length - 1 ? line : line + (i % 2 === 0 ? '\r\n' : '\n'))).join('');
  const end = crlf ? '\r\n' : '\n';
  return lines.join(end) + end;
}

/**
 * The lines of a text as the tokens of the parser read them: split at LF, and one CR before an LF is part of the
 * line end. The last line keeps its CR, as in the parser's token reading.
 */
export function parserLines(text) {
  const raw = text.split('\n');
  return raw.map((line, n) => (n < raw.length - 1 && line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** The UTF-16 offset of the code point index `cp` in `line`; an index past the end gives the line length. */
export function utf16Index(line, cp) {
  let units = 0;
  let count = 0;
  for (const ch of line) {
    if (count === cp) break;
    units += ch.length;
    count++;
  }
  return units;
}

/** The code point index of the UTF-16 offset `units` in `line`; an offset in the middle of a pair is an error. */
export function codePointIndex(line, units) {
  let at = 0;
  let count = 0;
  for (const ch of line) {
    if (at === units) return count;
    if (at > units) throw new Error(`UTF-16 offset ${units} splits a code point of ${JSON.stringify(line)}`);
    at += ch.length;
    count++;
  }
  if (at === units) return count;
  throw new Error(`UTF-16 offset ${units} is past the end of ${JSON.stringify(line)}`);
}
