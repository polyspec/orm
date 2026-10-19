// The language service of one dbspec document (docs/spec/editor.md "Layers"): the diagnostics with their ranges, the tokens,
// the folding ranges and the formatted text. All of it is the output of the parser entry of @polyspec/orm/dbspec, and
// the positions are the language service's own (utf16.ts).
import { analyzeDbspec, formatDbspec, type DbspecDiagnostic, type DbspecToken, type DbspecTokenClass } from '@polyspec/orm/dbspec';
import { lineAt, parserLines, rangeOf, utf16Offset, type Range } from './utf16.js';

export type { Position, Range } from './utf16.js';

/** A diagnostic of the parse: its rule and message, and the range that the editor marks. */
export interface Diagnostic {
  readonly rule: DbspecDiagnostic['rule'];
  readonly message: string;
  readonly range: Range;
}

/** A token of the syntax analysis, with its class and range. */
export interface Token {
  readonly class: DbspecTokenClass;
  readonly range: Range;
}

/** A folding range from the line of a `{` to the line of its matching `}`, both 0-based. */
export interface FoldingRange {
  readonly startLine: number;
  readonly endLine: number;
}

/** The formatted text of a document with no diagnostic, or its diagnostics and no text. */
export type FormatResult =
  | { readonly text: string; readonly diagnostics: readonly [] }
  | { readonly text: null; readonly diagnostics: readonly Diagnostic[] };

/** The language service of one document. */
export interface DocumentAnalysis {
  /** Every diagnostic of the parse, in the parser's order. */
  readonly diagnostics: readonly Diagnostic[];
  /** The tokens of the syntax analysis, in source order. */
  readonly tokens: readonly Token[];
  /** The folding ranges, in order of their opening line. */
  readonly folding: readonly FoldingRange[];
  /** The formatted text, or the diagnostics when the document has any. */
  format(): FormatResult;
}

/** The options of a document: the document set, other document name to text, that its `use` lines refer to. */
export interface OpenOptions {
  readonly set: Readonly<Record<string, string>>;
}

/** Opens a document: its diagnostics, tokens, folding ranges and format. */
export function openDocument(text: string, options: OpenOptions): DocumentAnalysis {
  const analysis = analyzeDbspec(text, options.set);
  const lines = parserLines(text);
  // A diagnostic ends at the token that starts at its position: the tokens are keyed by line and start column.
  const tokenAt = new Map<string, DbspecToken>();
  for (const token of analysis.tokens) tokenAt.set(`${token.line}:${token.start}`, token);
  const diagnostics = analysis.diagnostics.map(d => diagnosticOf(d, lines, tokenAt));
  const tokens = analysis.tokens.map(token => ({
    class: token.class,
    range: rangeOf(lines, token.line, token.start, token.end),
  }));
  return {
    diagnostics,
    tokens,
    folding: foldingOf(analysis.tokens, lines),
    format: () => formatOf(text, options.set, diagnostics),
  };
}

/**
 * The range of a diagnostic runs from its position to the end of the token that starts there. Where no token starts
 * there it is one code point, and at the end of a line it is empty.
 */
function diagnosticOf(d: DbspecDiagnostic, lines: readonly string[], tokenAt: ReadonlyMap<string, DbspecToken>): Diagnostic {
  const start = d.column - 1;
  const token = tokenAt.get(`${d.line}:${start}`);
  let end: number;
  if (token !== undefined) {
    end = token.end;
  } else {
    // Without a token the range is the one code point at the position; at the line end there is none, so it is empty.
    const line = lineAt(lines, d.line);
    end = utf16Offset(line, start) >= line.length ? start : start + 1;
  }
  return { rule: d.rule, message: d.message, range: rangeOf(lines, d.line, start, end) };
}

/**
 * The folding ranges: each `{` token and its matching `}` token on a later line (docs/spec/editor.md "Results"). Only a block
 * spans lines in dbspec, so the pairs are the blocks, read from the punctuation tokens without a keyword or a line shape.
 * An unmatched brace is a parse diagnostic and pairs with nothing.
 */
function foldingOf(tokens: readonly DbspecToken[], lines: readonly string[]): FoldingRange[] {
  const open: number[] = [];
  const folds: FoldingRange[] = [];
  for (const token of tokens) {
    if (token.class !== 'punctuation') continue;
    const line = lineAt(lines, token.line);
    const text = line.slice(utf16Offset(line, token.start), utf16Offset(line, token.end));
    if (text === '{') {
      open.push(token.line);
    } else if (text === '}') {
      const opened = open.pop();
      if (opened !== undefined && opened < token.line) folds.push({ startLine: opened - 1, endLine: token.line - 1 });
    }
  }
  return folds.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

/** The format of the document: refused with its diagnostics when it has any, else the canonical text. */
function formatOf(text: string, set: Readonly<Record<string, string>>, diagnostics: readonly Diagnostic[]): FormatResult {
  const formatted = formatDbspec(text, set);
  if (formatted.text === null) return { text: null, diagnostics };
  return { text: formatted.text, diagnostics: [] };
}
