# Microsecond wall clock used by the client and its tools.
import time

_ANCHOR_START = time.time_ns() // 1000
_MONOTONIC_START = time.monotonic_ns() // 1000
_anchor = float(_ANCHOR_START)


def wall_micros() -> int:
    """Wall clock microseconds since the epoch. time.time has millisecond resolution, so
    anchor the monotonic clock to the wall clock and fill in the microseconds within that millisecond.
    if the two clocks drift apart, or the wall clock is adjusted so the reading falls outside that millisecond, the value is moved to the nearest
    edge and the anchor is moved along with it. So while the wall clock does not go backward,
    the values read do not go backward either."""
    wall = time.time_ns() // 1000
    monotonic = time.monotonic_ns() // 1000
    global _anchor
    estimate = int(_anchor) + (monotonic - _MONOTONIC_START)
    micros = min(max(estimate, wall), wall + 999)
    if micros != estimate:
        _anchor = float(micros - (monotonic - _MONOTONIC_START))
    return micros
