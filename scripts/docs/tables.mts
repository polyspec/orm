// The GFM tables of a Markdown document, read with mdast-util-from-markdown and mdast-util-gfm (the grammar of GFM, with the
// escaped pipe of a cell and the pipes of a code span as the specification gives them). A cell is the source text of its
// content, so `\|` stays in its cell and a pipe that a table does not split on is not split. A table in a code block is not a table.
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import type { Heading, Nodes, Root, Table as MdastTable, TableCell } from 'mdast';

/** A table: the line of its header and of its last row (1-based), its header cells and its body rows, cell by cell. */
export type Table = { line: number; endLine: number; header: string[]; rows: string[][] };

/** parse reads a Markdown document with the GFM grammar. */
export function parse(text: string): Root {
  return fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

// span returns the position of a node that the parser read from the document, which every node of it has.
function span(node: Nodes): { start: number; end: number; line: number; endLine: number } {
  const { position } = node;
  if (position?.start.offset === undefined || position.end.offset === undefined) throw new Error(`the parser gave a ${node.type} node no offset`);
  return { start: position.start.offset, end: position.end.offset, line: position.start.line, endLine: position.end.line };
}

// raw returns the source text of a cell: from its first child to its last, so the escaped pipes and the code spans are kept as written.
function raw(text: string, cell: TableCell): string {
  const first = cell.children[0];
  const last = cell.children.at(-1);
  if (first === undefined || last === undefined) return '';
  return text.slice(span(first).start, span(last).end).trim();
}

function toTable(text: string, table: MdastTable): Table {
  const [header, ...body] = table.children;
  if (header === undefined) throw new Error('the parser gave a table no header row');
  const cells = (row: MdastTable['children'][number]) => row.children.map(cell => raw(text, cell));
  const position = span(table);
  return { line: position.line, endLine: position.endLine, header: cells(header), rows: body.map(cells) };
}

/** textOf returns the text of a node without its markup, as a heading's title is read. */
export function textOf(node: Nodes): string {
  if ('value' in node) return node.value;
  if ('children' in node) return node.children.map(textOf).join('');
  return '';
}

/** tablesIn returns every table of a document in order, a table nested in a list or a quote included. */
export function tablesIn(text: string): Table[] {
  const found: Table[] = [];
  const visit = (node: Nodes): void => {
    if (node.type === 'table') found.push(toTable(text, node));
    if ('children' in node) node.children.forEach(visit);
  };
  visit(parse(text));
  return found;
}

/** tableUnder returns the first table below the first heading that `isHeading` accepts, up to the next heading of its depth or higher. */
export function tableUnder(text: string, isHeading: (heading: Heading) => boolean): Table | undefined {
  let depth = 0;
  for (const node of parse(text).children) {
    if (node.type === 'heading') {
      if (depth > 0 && node.depth <= depth) return undefined;
      if (depth === 0 && isHeading(node)) depth = node.depth;
    } else if (depth > 0 && node.type === 'table') {
      return toTable(text, node);
    }
  }
  return undefined;
}
