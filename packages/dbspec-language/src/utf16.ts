// The positions of the language service (LSP): a line is 0-based and a character is a UTF-16 code unit. The parser
// counts code points, so the conversion happens here and nowhere else. The lines are the parser's lines: split at LF,
// with one CR before an LF being part of the line end; the last line keeps its CR, as the parser's token reading does.

export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

/** The lines of a text as the parser reads them. */
export function parserLines(text: string): readonly string[] {
  const raw = text.split('\n');
  return raw.map((line, n) => (n < raw.length - 1 && line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** The line with the 1-based number `line` of the parser. */
export function lineAt(lines: readonly string[], line: number): string {
  const text = lines[line - 1];
  if (text === undefined) throw new RangeError(`line ${line} is past the last line of the text`);
  return text;
}

/** The UTF-16 offset of the code point index `codePoints` in `line`, which is past the line end only at its end. */
export function utf16Offset(line: string, codePoints: number): number {
  let units = 0;
  let count = 0;
  for (const ch of line) {
    if (count === codePoints) break;
    units += ch.length;
    count++;
  }
  return units;
}

/** A range of one line, from a 1-based line and two code point columns counted from 0 by the parser. */
export function rangeOf(lines: readonly string[], line: number, start: number, end: number): Range {
  const text = lineAt(lines, line);
  return {
    start: { line: line - 1, character: utf16Offset(text, start) },
    end: { line: line - 1, character: utf16Offset(text, end) },
  };
}

/** The 1-based code point column of the parser at the UTF-16 offset `character` of `line`. */
export function codePointColumn(line: string, character: number): number {
  return [...line.slice(0, character)].length + 1;
}
