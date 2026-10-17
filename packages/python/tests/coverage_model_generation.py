# model_generation coverage: orm-gen with the arguments of the committed generation and --check reports that the
# committed models.py equals the generator output, and that a copy with one changed byte differs, as the
# model_generation coverage of Go, PHP, TypeScript and Rust does. The arguments are those of make python-model-check.
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from .coverage_case import REPOSITORY_ROOT, expect_equal, CoverageCase, coverage_main

SET = "contracts/fixtures/bench/dbspec-set.json"
MODELS = REPOSITORY_ROOT / "packages" / "python" / "src" / "polyspec" / "orm" / "models"


def orm_gen(out: Path) -> tuple[int, str, str]:
    """Runs orm-gen gen --check of the bench set into out and returns its exit code and output."""
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "polyspec.orm.bin_orm_gen",
            "gen",
            "--check",
            "--set",
            SET,
            "--out",
            str(out),
        ],
        cwd=REPOSITORY_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    return result.returncode, result.stdout, result.stderr


def model_generation_check():
    expect_equal(
        orm_gen(MODELS), (0, "", ""), "the committed models equal the generator output"
    )
    with tempfile.TemporaryDirectory(prefix="orm-python-generation-") as work:
        out = Path(work) / "models"
        out.mkdir()
        shutil.copyfile(MODELS / "models.py", out / "models.py")
        expect_equal(
            orm_gen(out), (0, "", ""), "an unchanged copy equals the generator output"
        )
        changed = bytearray((out / "models.py").read_bytes())
        at = changed.find(b"class ")
        if at < 0:
            raise AssertionError("models.py declares no class")
        changed[at] = ord("C")
        (out / "models.py").write_bytes(bytes(changed))
        expect_equal(
            orm_gen(out),
            (1, f"differs: {out / 'models.py'}\n", ""),
            "a copy with one changed byte differs",
        )


class CoverageTest(CoverageCase):
    def test_model_generation_check(self):
        self.each_item("model_generation_check", model_generation_check)


if __name__ == "__main__":
    coverage_main(CoverageTest)
