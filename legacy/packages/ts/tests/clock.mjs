// wallMicros of the TypeScript clock source, under a wall clock and a monotonic clock that the case sets. The
// clock of a stored value is the case clock_microseconds of the recipe conformance_verification.
//
// Usage: node packages/ts/tests/clock.mjs (after npm run typescript:build)
import { wallMicros } from '../dist/clock.js';
import { caseTest } from '../../../../tests/testcase.mts';
import { createFailureCheck } from './check-state.mjs';

const CASE_DEADLINE_MS = 30_000;
let failures = 0;

const check = createFailureCheck(() => 'clock_wall_micros_order', () => { failures++; });

/**
 * wallMicros under a wall clock and a monotonic clock that the case sets.
 * The monotonic clock runs ahead of the wall clock, which never goes back:
 * reading a falls 1.9 ms after the millisecond of the wall clock, reading b
 * 2.0 ms after the millisecond of reading a, and Date.now() advances by one
 * millisecond between them. Every reading lies within the millisecond that
 * Date.now() reports, and reading b is not earlier than reading a; a now
 * condition read right after an insert then matches the inserted row.
 */
function clockWallMicrosOrder() {
  const wallNow = Date.now;
  const monotonicNow = performance.now;
  let wall = 0;
  let monotonic = 0;
  Date.now = () => wall;
  performance.now = () => monotonic;
  try {
    // base is one day ahead of the real wall clock, so the first read is moved to the start of that millisecond and the anchor is set.
    const base = wallNow() + 86_400_000;
    wall = base; monotonic = 1_000;
    const start = wallMicros();
    check(start === base * 1000, `start ${start} is the wall clock ${base * 1000}`);
    const readings = [];
    for (const [w, m] of [[base + 4000, 5001.9], [base + 4001, 5003.0], [base + 4001, 5003.5], [base + 4002, 5004.2]]) {
      wall = w; monotonic = m;
      const micros = wallMicros();
      readings.push(micros);
      check(Math.floor(micros / 1000) === w, `reading ${micros} at wall ${w} and monotonic ${m} lies within the millisecond of the wall clock`);
    }
    for (let i = 1; i < readings.length; i++) {
      check(readings[i] >= readings[i - 1], `reading ${readings[i]} is not earlier than the previous reading ${readings[i - 1]} while the wall clock goes from ${base + 4000} to ${base + 4002}`);
    }
  } finally {
    Date.now = wallNow;
    performance.now = monotonicNow;
  }
}

caseTest('clock/clock_wall_micros_order', CASE_DEADLINE_MS, async () => {
  clockWallMicrosOrder();
  if (failures > 0) throw new Error(`${failures} check(s) failed; each FAIL line above names one`);
});
if (failures > 0) process.exitCode = 1;
