// The diagnostics of the language service as CodeMirror lint diagnostics.
import type { EditorState } from '@codemirror/state';
import { linter, type Diagnostic } from '@codemirror/lint';
import { dbspecDocument, offsetOf } from './document.js';

/** The diagnostics of the state's document; each message starts with its rule. */
export function dbspecDiagnostics(state: EditorState): Diagnostic[] {
  return state.field(dbspecDocument).diagnostics.map(d => ({
    from: offsetOf(state, d.range.start),
    to: offsetOf(state, d.range.end),
    severity: 'error',
    source: 'dbspec',
    message: `${d.rule}: ${d.message}`,
  }));
}

/** The lint source of the dbspec extension. */
export const dbspecLinter = linter(view => dbspecDiagnostics(view.state));
