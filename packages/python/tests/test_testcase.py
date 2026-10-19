# The unit test of the Python case harness (testcase.py): unittest's own report of each case, the step lines, the
# deadline that ends a stalled case, and that every test of the package runs through it.
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from . import testcase

TESTS = Path(__file__).resolve().parent
REPOSITORY_ROOT = TESTS.parents[2]

SAMPLE = textwrap.dedent("""
    import unittest
    from packages.python.tests import testcase


    class Sample(unittest.TestCase):
        def test_pass(self):
            testcase.step('one step')

        def test_fail(self):
            self.assertEqual(1, 2)

        def test_error(self):
            raise ValueError('broken')

        @unittest.skip('not here')
        def test_skip(self):
            pass

        def test_sub(self):
            for value in (1, 2):
                with self.subTest(value=value):
                    self.assertEqual(value, 1)


    class Stalled(unittest.TestCase):
        deadline = 0.1

        def test_stall(self):
            import time
            time.sleep(60)
""")


def run_sample(*names: str) -> subprocess.CompletedProcess:
    """Runs the sample through the discovery entry point of python-unit-check."""
    with tempfile.TemporaryDirectory() as directory:
        (Path(directory) / "sample.py").write_text(SAMPLE)
        return subprocess.run(
            [
                sys.executable,
                "-m",
                "packages.python.tests.testcase",
                "discover",
                "-s",
                directory,
                "-t",
                directory,
                "-p",
                "sample.py",
                *[arg for name in names for arg in ("-k", name)],
            ],
            cwd=REPOSITORY_ROOT,
            capture_output=True,
            text=True,
            timeout=testcase.PROCESS,
        )


class DurationTest(unittest.TestCase):
    def test_go_duration_form(self) -> None:
        for seconds, text in (
            (60, "1m0s"),
            (120, "2m0s"),
            (300, "5m0s"),
            (1.5, "1.5s"),
            (0.012, "12ms"),
            (0.0000004, "0µs"),
            (0.9996, "1s"),
            (3725, "1h2m5s"),
        ):
            self.assertEqual(testcase.duration(seconds), text, seconds)


class ReportTest(unittest.TestCase):
    deadline = testcase.PROCESS

    def test_unittest_report_of_each_outcome(self) -> None:
        result = run_sample("Sample")
        self.assertEqual(result.returncode, 1, result.stderr)
        # The step is a line of the case's output; the outcome of each case is unittest's line on its stream.
        self.assertIn("one step", result.stdout.splitlines())
        name = "sample.Sample."
        report = result.stderr.splitlines()
        for pattern in (
            rf"^test_pass \({name}test_pass\) \.\.\. ok$",
            rf"^test_fail \({name}test_fail\) \.\.\. FAIL$",
            rf"^test_error \({name}test_error\) \.\.\. ERROR$",
            rf"^test_skip \({name}test_skip\) \.\.\. skipped 'not here'$",
            rf"^\s*test_sub \({name}test_sub\) \(value=2\) \.\.\. FAIL$",
        ):
            self.assertTrue(
                any(re.search(pattern, line) for line in report),
                (pattern, result.stderr),
            )
        self.assertIn("ValueError: broken", result.stderr)
        self.assertIn("(value=2)", result.stderr)
        self.assertNotRegex(
            result.stdout + result.stderr, r"(?m)^(RUN|PASS|FAIL|SKIP|STEP) sample\."
        )

    def test_stalled_case_ends_the_process(self) -> None:
        result = run_sample("Stalled")
        self.assertEqual(result.returncode, 1, result.stderr)
        # The stall message follows the unfinished `test_stall ... ` text of unittest on the same stream line.
        self.assertIn(
            "sample.Stalled.test_stall: deadline 100ms exceeded and the case did not stop",
            result.stderr,
        )


class EveryTestTest(unittest.TestCase):
    def test_modules_run_through_the_harness(self) -> None:
        modules = sorted(TESTS.glob("*.py")) + sorted(
            (REPOSITORY_ROOT / "tests" / "interfaces").glob("test_*.py")
        )
        direct = [
            str(path.relative_to(REPOSITORY_ROOT))
            for path in modules
            if path.name != "testcase.py"
            and re.search(r"^\s*unittest\.main\(", path.read_text(), re.M)
        ]
        self.assertEqual(
            direct, [], "these modules call unittest.main instead of testcase.main"
        )

    def test_discovery_runs_through_the_harness(self) -> None:
        makefile = (REPOSITORY_ROOT / "Makefile").read_text()
        bare = [line.strip() for line in makefile.splitlines() if "-m unittest" in line]
        self.assertEqual(
            bare, [], "these Makefile lines discover the Python tests without testcase"
        )


if __name__ == "__main__":
    testcase.main()
