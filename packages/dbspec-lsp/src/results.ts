// The language service's results in the forms of the Language Server Protocol. Positions are already UTF-16 (the
// language service converts them; docs/editor.md "Layers").
import { TOKEN_CLASSES, type DocumentAnalysis } from '@polyspec/dbspec-language';
import { DiagnosticSeverity, type Diagnostic, type FoldingRange, type TextEdit } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';

const CLASS_INDEX = new Map<string, number>(TOKEN_CLASSES.map((cls, i) => [cls, i]));

/** The diagnostics of a document: errors whose code is the rule. */
export function diagnosticsOf(analysis: DocumentAnalysis): Diagnostic[] {
  return analysis.diagnostics.map(d => ({ range: d.range, severity: DiagnosticSeverity.Error, code: d.rule, source: 'dbspec', message: d.message }));
}

/**
 * The semantic tokens in the relative encoding of the protocol: per token the line delta, the start delta, the length,
 * the index of its class in the legend and no modifiers. A token never spans lines.
 */
export function semanticTokensOf(analysis: DocumentAnalysis): number[] {
  const data: number[] = [];
  let line = 0;
  let start = 0;
  for (const token of analysis.tokens) {
    const index = CLASS_INDEX.get(token.class);
    if (index === undefined) throw new Error(`token class ${token.class} is not in the legend`);
    const { start: from, end: to } = token.range;
    if (from.line !== to.line) throw new Error(`a token spans lines ${from.line} to ${to.line}`);
    data.push(from.line - line, from.line === line ? from.character - start : from.character, to.character - from.character, index, 0);
    line = from.line;
    start = from.character;
  }
  return data;
}

/** The folding ranges of the blocks. */
export function foldingRangesOf(analysis: DocumentAnalysis): FoldingRange[] {
  return analysis.folding.map(f => ({ startLine: f.startLine, endLine: f.endLine }));
}

/**
 * The formatting edits: none for a canonical document, one edit of the whole text otherwise, and null for a document
 * with a diagnostic, which is refused and never rewritten (docs/dbspec.md "Formatting"); its diagnostics are published.
 */
export function formatEditsOf(text: TextDocument, analysis: DocumentAnalysis): TextEdit[] | null {
  const result = analysis.format();
  if (result.text === null) return null;
  if (result.text === text.getText()) return [];
  return [{ range: { start: { line: 0, character: 0 }, end: text.positionAt(text.getText().length) }, newText: result.text }];
}
