# The generated error catalog of the Python client, polyspec/orm/codes.py, against docs/spec/errors.yaml: every code of the
# catalog is a constant whose value is the code and whose comment is the note of the catalog, and the file holds no other
# code.
import re
import unittest
from pathlib import Path

from . import testcase

ROOT = Path(__file__).resolve().parents[3]
CATALOG = ROOT / "docs" / "spec" / "errors.yaml"
CODES = ROOT / "packages" / "python" / "src" / "polyspec" / "orm" / "codes.py"


def read_catalog() -> list[tuple[str, str]]:
    """Read docs/spec/errors.yaml, a flat list of "- code: X  # comment" lines each followed by "origin: Y", and return each
    code with the note that its generated constant carries: the origin, then ": " and the comment when it has one."""
    out: list[tuple[str, str]] = []
    comment = ""
    for line in CATALOG.read_text(encoding="utf-8").split("\n"):
        text = line.strip()
        if text.startswith("- code:"):
            code, _, rest = text[len("- code:") :].partition("#")
            out.append((code.strip(), ""))
            comment = rest.strip()
        elif text.startswith("origin:") and out:
            origin = text[len("origin:") :].strip()
            out[-1] = (out[-1][0], origin if comment == "" else f"{origin}: {comment}")
    if not out:
        raise ValueError("docs/spec/errors.yaml lists no codes")
    return out


class CodeCatalogTest(unittest.TestCase):
    # Requirements: INT-65.
    def test_codes_match_errors_yaml(self):
        catalog = read_catalog()
        source = CODES.read_text(encoding="utf-8")
        problems: list[str] = []
        for code, note in catalog:
            line = re.search(
                rf'^# (.*)\n{re.escape(code)} = "{re.escape(code)}"$', source, re.M
            )
            if line is None:
                problems.append(f"codes.py has no constant for {code}")
            elif line.group(1) != note:
                problems.append(
                    f"codes.py {code}: {line.group(1)!r}, docs/spec/errors.yaml: {note!r}"
                )
        constants = re.findall(r'^\w+ = "\w+"$', source, re.M)
        if len(constants) != len(catalog):
            problems.append(
                f"codes.py holds {len(constants)} codes, docs/spec/errors.yaml {len(catalog)}"
            )
        self.assertEqual(
            problems,
            [],
            "; run orm-gen errors --lang python --out packages/python/src/polyspec/orm/codes.py",
        )

    def test_codes_exported_from_package(self):
        import polyspec.orm as orm
        from polyspec.orm import codes

        self.assertIn("codes", orm.__all__)
        missing = [
            code for code, _ in read_catalog() if getattr(codes, code, None) != code
        ]
        self.assertEqual(
            missing,
            [],
            "polyspec.orm.codes lacks a constant whose value is the code of docs/spec/errors.yaml",
        )


if __name__ == "__main__":
    testcase.main()
