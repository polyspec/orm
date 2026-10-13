// The format command (docs/dbspec.md "Formatting"): a document with a diagnostic is refused, never rewritten.
import type { StateCommand } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { dbspecDocument } from './document.js';

/** Replaces the document with its canonical text. Returns false and changes nothing when the document is refused. */
export const formatDbspec: StateCommand = ({ state, dispatch }) => {
  const result = state.field(dbspecDocument).format();
  if (result.text === null) return false;
  if (result.text !== state.doc.toString()) {
    dispatch(state.update({ changes: { from: 0, to: state.doc.length, insert: result.text }, userEvent: 'format' }));
  }
  return true;
};

/**
 * Binds Shift+Alt+F to {@link formatDbspec} by the physical key (`KeyboardEvent.code` `KeyF`): a keymap binding of
 * `Shift-Alt-f` matches the typed character, and on macOS Option+Shift+F types another character.
 */
export const dbspecFormatKey = EditorView.domEventHandlers({
  keydown(event, view) {
    if (event.code !== 'KeyF' || !event.shiftKey || !event.altKey || event.ctrlKey || event.metaKey) return false;
    if (!formatDbspec(view)) return false;
    event.preventDefault();
    return true;
  },
});
