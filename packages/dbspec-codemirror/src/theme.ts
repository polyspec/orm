// Colours of the token classes for dark and light editor themes, the colours of the documentation site's dbs fence.
import { EditorView } from '@codemirror/view';

const light: Record<string, string> = {
  keyword: '#a626a4', type: '#0184bc', name: '#383a42', setting: '#c18401', number: '#986801',
  string: '#50a14f', operator: '#0184bc', punctuation: '#696c77', comment: '#8a8c93', word: '#e45649',
};
const dark: Record<string, string> = {
  keyword: '#c678dd', type: '#56b6c2', name: '#abb2bf', setting: '#e5c07b', number: '#d19a66',
  string: '#98c379', operator: '#56b6c2', punctuation: '#8b929e', comment: '#7f848e', word: '#e06c75',
};

function rules(mode: '&light' | '&dark', colors: Record<string, string>): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [cls, color] of Object.entries(colors)) out[`${mode} .cm-dbspec-${cls}`] = { color };
  return out;
}

/** The token colours for light and dark themes. */
export const dbspecTheme = EditorView.baseTheme({
  ...rules('&light', light),
  ...rules('&dark', dark),
  '.cm-dbspec-comment': { fontStyle: 'italic' },
});
