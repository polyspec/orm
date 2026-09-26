#!/usr/bin/env python3
"""Run conformance result tests with an explicit deadline for each command."""

from pathlib import Path
import os
import signal
import subprocess
import time


ROOT = Path(__file__).resolve().parents[2]
COMMANDS = [
    (["npm", "--prefix", "clients/typescript", "run", "build"], 120),
    (["php", "tests/conformance/result_php.php"], 10),
    (["node", "--test", "tests/conformance/result_typescript.test.mjs"], 10),
]


def main() -> None:
    for command, seconds in COMMANDS:
        print("RUN", " ".join(command), flush=True)
        started = time.monotonic()
        process = subprocess.Popen(command, cwd=ROOT, start_new_session=True)
        try:
            code = process.wait(timeout=seconds)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            print("TIMEOUT", f"{time.monotonic() - started:.3f}s", flush=True)
            raise SystemExit(124)
        print("PASS" if code == 0 else "FAIL", f"exit={code}", f"elapsed={time.monotonic() - started:.3f}s", flush=True)
        if code != 0:
            raise SystemExit(code)


if __name__ == "__main__":
    main()
