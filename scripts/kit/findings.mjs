// A finding of a document check: `{ line, column, rule, message }` with the column 1.

/** The finding of `rule` at `line` of a document. */
export const finding = (line, rule, message) => ({ line, column: 1, rule, message });
