/** Returns whether an error has the INTERNAL code and names the expected table column. */
export function isInternalColumnError(error, table, column) {
  return error?.code === 'INTERNAL' && error.message.includes(`${table}.${column}`);
}
