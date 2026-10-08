// Reading a table of statuses, such as a feature status table: rows `| <ID> | ... |` whose cells have a fixed count, a
// closed set of values or a pattern. The rows of the English and the Korean file must agree on the ID and on every
// column that has a closed set of values (the other columns are translated text).
import { finding } from './findings.mjs';
import { tableCells } from './markdown.mjs';

/**
 * Reads the rows of `text` for the table `spec` ({ idPattern, cells, columns: [{ index, enum?, pattern? }] }).
 * Returns `{ findings, rows }`; each row is `{ id, values, line }` where `values` are the cells of the columns that have a
 * closed set of values.
 */
export function readStatusTable(text, spec) {
  const id = new RegExp(`^(?:${spec.idPattern})$`);
  const findings = [];
  const rows = [];
  const seen = new Map();
  text.split('\n').forEach((line, index) => {
    if (!line.startsWith('|')) return;
    const cells = tableCells(line).map(cell => cell.text.trim());
    if (!id.test(cells[0])) return;
    const number = index + 1;
    if (cells.length !== spec.cells) findings.push(finding(number, 'status-table', `the row ${cells[0]} has ${cells.length} cells; expected ${spec.cells}`));
    if (seen.has(cells[0])) findings.push(finding(number, 'status-table', `the row ${cells[0]} repeats the ID of line ${seen.get(cells[0])}`));
    else seen.set(cells[0], number);
    const values = [];
    for (const column of spec.columns) {
      const value = cells[column.index] ?? '';
      if (column.enum) {
        values.push(value);
        if (!column.enum.includes(value)) findings.push(finding(number, 'status-table', `the row ${cells[0]} has ${JSON.stringify(value)} in cell ${column.index + 1}; expected ${column.enum.join(', ')}`));
      }
      if (column.pattern && !new RegExp(column.pattern).test(value)) findings.push(finding(number, 'status-table', `the row ${cells[0]} has ${JSON.stringify(value)} in cell ${column.index + 1}; expected a match of ${column.pattern}`));
    }
    rows.push({ id: cells[0], values, line: number });
  });
  if (!rows.length) findings.push(finding(1, 'status-table', `the table has no row whose first cell matches ${spec.idPattern}`));
  return { findings, rows };
}
