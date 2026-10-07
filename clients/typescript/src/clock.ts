// The wall clock with microseconds of the client and its tools.

/** The microseconds that wallMicros adds to the monotonic clock reading. */
let clockAnchor = performance.timeOrigin * 1000;

/**
 * Microseconds since the epoch on the wall clock. Date has millisecond
 * resolution, so the monotonic clock, anchored to the wall clock, supplies
 * the microseconds within the millisecond that Date.now() reports. A reading
 * outside that millisecond, as when the two clocks drift apart or after a
 * wall clock adjustment, is moved to its nearest end and the anchor moves
 * with it. The reading is therefore not earlier than the previous one while
 * the wall clock does not go back.
 */
export function wallMicros(): number {
  const wall = Date.now() * 1000;
  const monotonic = performance.now() * 1000;
  const estimate = Math.floor(clockAnchor + monotonic);
  // estimate를 Date.now()가 알리는 millisecond 안으로 옮기고, anchor도 함께 옮겨 다음 읽기가 이어지게 한다.
  const micros = Math.min(Math.max(estimate, wall), wall + 999);
  if (micros !== estimate) clockAnchor = micros - monotonic;
  return micros;
}
