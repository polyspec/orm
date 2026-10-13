// The CodeMirror 6 adapter of the dbspec language service (docs/editor.md "Layers"): it turns the service's results into
// CodeMirror's forms and reads nothing of its own.
import type { Extension } from '@codemirror/state';
import { dbspecFormatKey } from './commands.js';
import { dbspecDocument, dbspecOptions, type DbspecOptions } from './document.js';
import { dbspecFolding } from './fold.js';
import { dbspecLinter } from './lint.js';
import { dbspecMarks } from './marks.js';
import { dbspecTheme } from './theme.js';

export { formatDbspec } from './commands.js';
export { dbspecDocument } from './document.js';
export type { DbspecOptions } from './document.js';
export { dbspecDiagnostics } from './lint.js';

/** The dbspec language for CodeMirror 6: token marks, diagnostics, folding and the format command on Shift+Alt+F. */
export function dbspec(options: DbspecOptions = {}): Extension {
  return [dbspecOptions.of(options), dbspecDocument, dbspecMarks, dbspecTheme, dbspecLinter, dbspecFolding, dbspecFormatKey];
}
