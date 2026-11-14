# The unit test of the Python case harness (testcase.py): unittest's own report of each case, the step lines, that no
# clock ends a case, and that every test of the package runs through it.
import io
import re
import subprocess
import sys
import tempfile
import textwrap
import threading
import types
import unittest
from pathlib import Path

from . import testcase
from .vector_case import VectorCase, vector_load_tests

TESTS = Path(__file__).resolve().parent
REPOSITORY_ROOT = TESTS.parents[3]

SAMPLE = textwrap.dedent("""
    import unittest
    from legacy.packages.python.tests import testcase


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
""")


def run_sample(*names: str) -> subprocess.CompletedProcess:
    """Runs the sample through the discovery entry point of python-unit-check."""
    with tempfile.TemporaryDirectory() as directory:
        (Path(directory) / "sample.py").write_text(SAMPLE)
        return subprocess.run(
            [
                sys.executable,
                "-m",
                "legacy.packages.python.tests.testcase",
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


class NoClockTest(unittest.TestCase):
    """No clock ends a case (T474): a case that runs through CaseRunner arms no timer, so its result does not depend on the
    time that the machine gives its work."""

    def test_a_case_arms_no_timer(self) -> None:
        armed: list[float] = []
        original = threading.Timer

        def recording(interval, function, args=None, kwargs=None):
            armed.append(interval)
            return original(interval, function, args, kwargs)

        class Long(unittest.TestCase):
            def test_long(self) -> None:
                testcase.step("long step")

        threading.Timer = recording
        try:
            stream = io.StringIO()
            result = testcase.CaseRunner(stream=stream, verbosity=2).run(
                unittest.defaultTestLoader.loadTestsFromTestCase(Long)
            )
        finally:
            threading.Timer = original
        self.assertTrue(result.wasSuccessful(), stream.getvalue())
        self.assertEqual(armed, [], "the harness armed a timer for the case")


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


class StreamTest(unittest.TestCase):
    def test_main_writes_the_report_on_the_stream_it_is_given(self) -> None:
        # A caller that reads stdout, as run of scripts/physical.mts does, passes it to main (T289).
        code = textwrap.dedent("""
            import sys
            import unittest
            from legacy.packages.python.tests import testcase


            class Sample(unittest.TestCase):
                def test_pass(self):
                    pass


            testcase.main(argv=sys.argv[:1], stream=sys.stdout)
        """)
        result = subprocess.run(
            [sys.executable, "-c", code],
            cwd=REPOSITORY_ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("test_pass (__main__.Sample.test_pass) ... ok", result.stdout)
        self.assertRegex(result.stdout, r"(?m)^Ran 1 test in ")
        self.assertNotIn("Ran 1 test", result.stderr)


class VectorSelectionTest(unittest.TestCase):
    """The cases of a vector file follow the name patterns of the run (-k), as the methods of a test class do (T452)."""

    def _loaded(self, patterns) -> list[str]:
        module = types.ModuleType("sample_vectors")
        module.load_tests = vector_load_tests(
            VectorCase, [{"id": "one"}, {"id": "two"}], lambda _test, _case: None
        )
        sys.modules[module.__name__] = module
        self.addCleanup(sys.modules.pop, module.__name__)
        loader = unittest.TestLoader()
        loader.testNamePatterns = patterns
        suite = module.load_tests(loader, unittest.TestSuite(), None)
        return [test.id() for test in suite]

    def test_a_run_without_a_pattern_loads_every_case(self) -> None:
        self.assertEqual(self._loaded(None), ["one", "two"])

    def test_a_pattern_of_a_case_loads_that_case(self) -> None:
        self.assertEqual(self._loaded(["*two*"]), ["two"])

    def test_a_pattern_of_the_module_loads_its_cases(self) -> None:
        self.assertEqual(self._loaded(["*sample_vectors*"]), ["one", "two"])

    def test_a_pattern_of_another_test_loads_no_case(self) -> None:
        self.assertEqual(self._loaded(["*test_recipe_send_listener*"]), [])


if __name__ == "__main__":
    testcase.main()
