"""orm-install-python installs the wheel lock with hashes (kit K54): packages/python/pylock.toml goes to pip with --require-hashes."""

import pathlib
import unittest

from . import testcase

ROOT = pathlib.Path(__file__).resolve().parents[3]


def recipe_of(text: str, name: str) -> list[str]:
    """The tab-indented recipe lines of the target `name`, up to the first line that is not tab-indented."""
    lines = text.split("\n")
    start = next(i for i, line in enumerate(lines) if line.startswith(f"{name}:"))
    recipe: list[str] = []
    for line in lines[start + 1 :]:
        if not line.startswith("\t"):
            break
        recipe.append(line)
    return recipe


class InstallLockTest(unittest.TestCase):
    def test_install_python_installs_the_lock_with_hashes(self) -> None:
        makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
        pip_lines = [
            line
            for line in recipe_of(makefile, "orm-install-python")
            if " install " in line
        ]
        hashed = [
            line
            for line in pip_lines
            if "--require-hashes" in line and "-r packages/python/pylock.toml" in line
        ]
        message = "orm-install-python must install packages/python/pylock.toml with --require-hashes; its pip install lines:\n"
        self.assertEqual(len(hashed), 1, message + "\n".join(pip_lines))


if __name__ == "__main__":
    testcase.main()
