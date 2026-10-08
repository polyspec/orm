// Clock text of the tools.

/** The current time as an ISO 8601 text. */
export const now = () => new Date().toISOString();

/** `milliseconds` as seconds with one decimal and a unit after a space (`1.2 s`); `-` when it is not a finite number. */
export const seconds = milliseconds => (Number.isFinite(milliseconds) ? `${(milliseconds / 1000).toFixed(1)} s` : '-');

/** `milliseconds` as seconds with one decimal and no space (`1.2s`), as the progress lines of the test runs print it. */
export const compactSeconds = milliseconds => `${(milliseconds / 1000).toFixed(1)}s`;
