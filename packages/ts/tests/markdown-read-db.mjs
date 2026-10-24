/** Creates the database shape used by markdownRead unit tests. */
export function markdownReadDatabase(model, session) {
  return {
    markdownModel: () => model,
    zone: undefined,
    signal: undefined,
    clockMicros: () => 0,
    now: () => '2026-01-01 00:00:00.000000',
    md: { acquire: async () => session, release: () => {} },
  };
}
