import { canonicalMarkdownTables } from './markdown-tables.mts';
import { tableUnder, textOf } from './tables.mts';

/** Remove only declared Flowmark-owned tables; their exact content is checked separately. */
export function authoredStyleText(file: string, sourceText: string): string {
  const target = canonicalMarkdownTables.find(table => table.file === file);
  if (target === undefined) return sourceText;
  const table = tableUnder(sourceText, heading => heading.depth === 2 && `## ${textOf(heading)}` === target.heading);
  if (table === undefined) return sourceText;
  const lines = sourceText.split('\n');
  lines.splice(table.line - 1, table.endLine - table.line + 1);
  return lines.join('\n');
}
