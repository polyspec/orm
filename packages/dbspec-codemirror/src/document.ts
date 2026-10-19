// The language service document of an editor state: one analysis per document text (docs/spec/editor.md "Layers").
import { Facet, StateField, type EditorState } from '@codemirror/state';
import { openDocument, type DocumentAnalysis, type Position } from '@polyspec/dbspec-language';

/** Options of {@link dbspec}: the document set, other document name to text, that the document's `use` lines name. */
export interface DbspecOptions {
  readonly set?: Readonly<Record<string, string>>;
}

/** The options of the first {@link dbspec} extension of a state. */
export const dbspecOptions = Facet.define<DbspecOptions, DbspecOptions>({
  combine: values => values[0] ?? {},
});

function documentOf(state: EditorState): DocumentAnalysis {
  return openDocument(state.doc.toString(), { set: state.facet(dbspecOptions).set ?? {} });
}

/** The analysis of the state's text, made again when the document changes. */
export const dbspecDocument = StateField.define<DocumentAnalysis>({
  create: documentOf,
  update: (analysis, transaction) => (transaction.docChanged ? documentOf(transaction.state) : analysis),
});

/**
 * The offset of a language service position (0-based line, UTF-16 character) in the state's document, whose offsets
 * are UTF-16 code units too; the language service already converted code points.
 */
export function offsetOf(state: EditorState, position: Position): number {
  return state.doc.line(position.line + 1).from + position.character;
}
