// The wall clock with microseconds of the client and its tools.

/** The microseconds that wallMicros adds to the monotonic clock reading. */
let clockAnchor = performance.timeOrigin * 1000;

/**
 * Microseconds since the epoch on the wall clock. Date has millisecond
 * resolution, so the monotonic clock, anchored to the wall clock at process
 * start, supplies the microseconds; when the two clocks differ by more than
 * one millisecond, as after a wall clock adjustment, the anchor moves to the
 * wall clock.
 */
export function wallMicros(): number {
  const wall = Date.now();
  let micros = Math.floor(clockAnchor + performance.now() * 1000);
  if (Math.abs(Math.floor(micros / 1000) - wall) > 1) {
    clockAnchor = wall * 1000 - performance.now() * 1000;
    micros = Math.floor(clockAnchor + performance.now() * 1000);
  }
  return micros;
}
