# The shared runner of the Python feature coverage tests (scripts/features/coverage.mjs). The checker runs
# `<python> <file> <case id>...`, and the whole output must be `CASE <id> PASS` lines, so the runner runs
# exactly the requested cases in their order and writes that one line for each case that passed. A failure
# raises, so the process ends with a nonzero code and the error.
import sys
from pathlib import Path

# The repository root, resolved from this file.
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def run_cases(cases):
    """Runs exactly the case IDs of the command line in their order; an unknown, repeated or missing ID is
    an error before any case runs."""
    requested = sys.argv[1:]
    if not requested or len(set(requested)) != len(requested) or any(i not in cases for i in requested):
        raise SystemExit(f'usage: {Path(sys.argv[0]).name} {"|".join(cases)}...; got {requested}')
    for case_id in requested:
        cases[case_id]()
        print(f'CASE {case_id} PASS', flush=True)
