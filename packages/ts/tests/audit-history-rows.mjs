/** Projects audit history models to the shared comparison fields. */
export function auditHistoryRows(rows, core) {
  return rows.map(row => [
    row[core].column('change'), row[core].column('previous_audit_seq'), row[core].column('seq'), row[core].column('title'),
    row[core].column('audit_seq'), row[core].column('deleted_at') !== null,
  ]);
}
