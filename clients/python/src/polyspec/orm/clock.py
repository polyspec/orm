# client와 그 도구가 쓰는 microsecond wall clock.
import time

_ANCHOR_START = time.time_ns() // 1000
_MONOTONIC_START = time.monotonic_ns() // 1000
_anchor = float(_ANCHOR_START)


def wall_micros() -> int:
    """epoch부터의 wall clock microsecond. time.time은 밀리초 분해능이라
    monotonic clock을 wall clock에 anchor해 그 밀리초 안의 microsecond를 채운다.
    두 clock이 벌어지거나 wall clock이 조정돼서 읽은 값이 그 밀리초 밖이면 가까운
    끝으로 옮기고 anchor도 함께 옮긴다. 그래서 wall clock이 뒤로 가지 않는 동안
    읽은 값도 뒤로 가지 않는다."""
    wall = time.time_ns() // 1000
    monotonic = time.monotonic_ns() // 1000
    global _anchor
    estimate = int(_anchor) + (monotonic - _MONOTONIC_START)
    micros = min(max(estimate, wall), wall + 999)
    if micros != estimate:
        _anchor = float(micros - (monotonic - _MONOTONIC_START))
    return micros
