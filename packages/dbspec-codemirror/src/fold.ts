// Folding of the blocks that the language service reports.
import { foldService } from '@codemirror/language';
import { dbspecDocument } from './document.js';

/** Folds a block that opens on the line from the end of the line to the end of the line before its closing line. */
export const dbspecFolding = foldService.of((state, lineStart, lineEnd) => {
  const line = state.doc.lineAt(lineStart).number - 1;
  const range = state.field(dbspecDocument).folding.find(r => r.startLine === line);
  return range === undefined ? null : { from: lineEnd, to: state.doc.line(range.endLine).to };
});
