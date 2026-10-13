// Mark decorations of the token classes of syntax analysis (docs/dbspec.md "Syntax analysis").
import type { Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { dbspecDocument, offsetOf } from './document.js';

const marks = new Map<string, Decoration>();

function markOf(cls: string): Decoration {
  let mark = marks.get(cls);
  if (mark === undefined) {
    mark = Decoration.mark({ class: `cm-dbspec-${cls}` });
    marks.set(cls, mark);
  }
  return mark;
}

/** One mark per token, classed `cm-dbspec-<class>`. */
export const dbspecMarks: Extension = EditorView.decorations.compute([dbspecDocument], (state): DecorationSet =>
  Decoration.set(state.field(dbspecDocument).tokens.map(token =>
    markOf(token.class).range(offsetOf(state, token.range.start), offsetOf(state, token.range.end)))),
);
