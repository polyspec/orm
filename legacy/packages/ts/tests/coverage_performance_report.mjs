// Formats nanosecond samples using the microsecond unit shown by performance gates.
export function formatMicroseconds(nanoseconds) {
  return `${(Number(nanoseconds) / 1e3).toFixed(1)}µs`;
}
