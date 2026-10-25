# The shared 2000-table dbspec stress input: exact size, canonical parse/emit identity, and repeated-emission stability.
# Requirements: DBS-123.
from pathlib import Path
import subprocess
import unittest

from polyspec.orm.dbspec import emit_dbspec, parse_dbspec

from . import testcase


class StressCanonicalTest(unittest.TestCase):
    deadline = testcase.PROCESS

    def test_stress_document_round_trips(self) -> None:
        # Discover the checkout from tracked markers so this test follows the runtime working tree.
        working_directory = Path.cwd().resolve()
        root = next(
            (
                directory
                for directory in (working_directory, *working_directory.parents)
                if (directory / "go.work").is_file()
                and (directory / "tests" / "dbspec" / "stress.mts").is_file()
            ),
            None,
        )
        self.assertIsNotNone(root, "could not find repository root from test working directory")
        assert root is not None
        generator = root / "tests" / "dbspec" / "stress.mts"
        generated = subprocess.run(
            ["node", str(generator)],
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(generated.returncode, 0, f"node tests/dbspec/stress.mts failed: {generated.stderr}")
        text = generated.stdout
        testcase.step(f"generated {len(text.encode('utf-8'))} bytes")

        document, _positions, diagnostics = parse_dbspec(text, {})
        self.assertFalse(diagnostics, "The generated stress document has no parse diagnostics")
        self.assertIsNotNone(document, "The generated stress document parses")
        assert document is not None
        self.assertEqual(2000, len(document.tables), "Stress document table count")
        self.assertEqual(60000, sum(len(table.columns) for table in document.tables), "Stress document column count")
        self.assertEqual(10000, sum(len(table.foreign_keys) for table in document.tables), "Stress document foreign key count")

        first = emit_dbspec(document)
        second = emit_dbspec(document)
        self.assertEqual(text, first, "emit(parse(stress)) reproduces the generated canonical document")
        self.assertEqual(first, second, "Two emissions of the parsed stress document are identical")


if __name__ == "__main__":
    testcase.main()
