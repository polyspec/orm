# orm-gen 생성기 검사: contracts/fixtures/bench/dbspec-set.json 문서 집합에서 models.py를 만들고,
# 생성 module이 chain 문법을 해석하는지 확인한다 (unittest).
import types
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from . import testcase

ROOT = Path(__file__).resolve().parents[3]

# orm-gen runs from the package installed into this interpreter's venv.
ORM_GEN = [sys.executable, "-m", "polyspec.orm.bin_orm_gen"]


class OrmGenTest(unittest.TestCase):
    deadline = testcase.PROCESS

    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix="orm-gen-")
        cls.addClassCleanup(tmp.cleanup)
        cls.out = tmp.name
        subprocess.run(
            args=ORM_GEN
            + [
                "gen",
                "--set",
                str(ROOT / "contracts" / "fixtures" / "bench" / "dbspec-set.json"),
                "--out",
                cls.out,
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        # The generated module is compiled from its source and registered as models, without a sys.path change.
        source = Path(cls.out) / "models.py"
        module = types.ModuleType("models")
        module.__file__ = str(source)
        sys.modules["models"] = module
        cls.addClassCleanup(sys.modules.pop, "models", None)
        exec(compile(source.read_text(), module.__file__, "exec"), module.__dict__)

    def test_generated_module_imports_and_builds_the_model(self):
        import models

        self.assertEqual(
            models.MANIFEST_HASH,
            "sha256:a26e0390c07bd97f6907d6d4588636778e3073086eceb3cd7bcf7e693f875e30",
        )
        author = models.Author()
        self.assertEqual(author.entity_def.entity.name, "author")
        self.assertEqual(len(models.model.entities), 19)
        self.assertTrue(models.SCHEMA.manifest_text.startswith("dbspec 1 bench"))

    def test_fixed_column_methods(self):
        import models

        user = models.User()
        user.set_name("tester")
        self.assertEqual(user.core.values, {"name": "tester"})
        self.assertEqual(
            [(spec.column, spec.value) for spec in user.core.sets], [("name", "tester")]
        )
        user.get_name  # 생성된 getter가 있다
        user.add_column_name().remove_column_name()
        self.assertEqual(user.core.columns_add, ["name"])
        self.assertEqual(user.core.columns_remove, ["name"])
        author = models.Author()
        author.plus_like_count(3)
        self.assertEqual(
            [(spec.column, spec.value, spec.plus) for spec in author.core.sets],
            [("like_count", 3, True)],
        )

    def test_chain_conditions(self):
        import models

        author = models.Author()
        author.service_seq(7)
        author.and_is_close(False)
        author.or_gt_read_count(6)
        items = author.core.where.items
        self.assertEqual(
            [
                (item["pred"]["column"], item["pred"]["op"], item["conn"])
                for item in items
            ],
            [
                ("service_seq", "eq", ""),
                ("is_close", "eq", "and"),
                ("read_count", "gt", "or"),
            ],
        )
        other = models.Author()
        other.between_price(["1.0", "2.0"])
        self.assertEqual(other.core.where.items[-1]["pred"]["kind"], "between")
        third = models.Author()
        third.ne_uuid("x")
        self.assertEqual(third.core.where.items[-1]["pred"]["op"], "not_eq")

    def test_order_limit_and_match(self):
        import models

        author = models.Author()
        author.order_by_seq_asc()
        self.assertEqual(
            author.core.order, [{"column": "seq", "desc": False, "fn": None}]
        )
        author.limit(0, 3)
        self.assertEqual(author.core.limit, {"offset": 0, "count": 3})
        author.match_user_seq_with_seq()
        self.assertEqual(author.core.matches, [{"left": "user_seq", "right": "seq"}])
        author.and_not(lambda m: m.name("excluded"))
        self.assertTrue(author.core.where.items[-1]["group"].not_)

    def test_scan_reports_unknown_model_methods(self):
        source = Path(self.out) / "scan_probe.py"
        source.write_text(
            "from models import Author\n"
            "author = Author()\n"
            "author.not_a_model_method()\n",
            encoding="utf-8",
        )
        result = subprocess.run(
            args=ORM_GEN
            + [
                "gen",
                "--set",
                str(ROOT / "contracts" / "fixtures" / "bench" / "dbspec-set.json"),
                "--out",
                self.out,
                "--scan",
                str(source),
            ],
            capture_output=True,
            text=True,
        )
        source.unlink()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Author.not_a_model_method", result.stderr)

    def test_check_reports_a_missing_or_differing_file(self):
        with tempfile.TemporaryDirectory(prefix="orm-gen-missing-") as missing:
            result = subprocess.run(
                args=ORM_GEN
                + [
                    "gen",
                    "--set",
                    str(ROOT / "contracts" / "fixtures" / "bench" / "dbspec-set.json"),
                    "--out",
                    missing,
                    "--check",
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("missing:", result.stdout)
        result = subprocess.run(
            args=ORM_GEN
            + [
                "gen",
                "--set",
                str(ROOT / "contracts" / "fixtures" / "bench" / "dbspec-set.json"),
                "--out",
                self.out,
                "--check",
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_the_removed_document_flags_are_usage_errors(self):
        for flag in ("--schema", "--use"):
            result = subprocess.run(
                args=ORM_GEN
                + [
                    "gen",
                    "--set",
                    str(ROOT / "contracts" / "fixtures" / "bench" / "dbspec-set.json"),
                    flag,
                    str(ROOT / "contracts" / "fixtures" / "bench" / "bench.dbs"),
                    "--out",
                    self.out,
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn(flag, result.stderr)

    def test_set_errors_print_every_error_and_write_nothing(self):
        with tempfile.TemporaryDirectory(prefix="orm-gen-set-") as tree:
            root = Path(tree)
            (root / "dbspec-set.json").write_text(
                '{"schema": 1, "documents": ["gone.dbs", "also-gone.dbs"]}',
                encoding="utf-8",
            )
            out = root / "out"
            result = subprocess.run(
                args=ORM_GEN
                + ["gen", "--set", str(root / "dbspec-set.json"), "--out", str(out)],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn(f"set.file: {root}/gone.dbs", result.stderr)
            self.assertIn(f"set.file: {root}/also-gone.dbs", result.stderr)
            self.assertFalse(out.exists())

    def test_document_diagnostics_print_every_diagnostic_and_write_nothing(self):
        with tempfile.TemporaryDirectory(prefix="orm-gen-set-") as tree:
            root = Path(tree)
            (root / "a.dbs").write_text('<?xml version="1.0"?>\n', encoding="utf-8")
            (root / "b.dbs").write_bytes(b"dbspec 1 b\n\xff\n")
            (root / "dbspec-set.json").write_text(
                '{"schema": 1, "documents": ["a.dbs", "b.dbs"]}', encoding="utf-8"
            )
            out = root / "out"
            result = subprocess.run(
                args=ORM_GEN
                + ["gen", "--set", str(root / "dbspec-set.json"), "--out", str(out)],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn(f"{root}/a.dbs:1:1: signature:", result.stderr)
            self.assertIn(f"{root}/b.dbs:2:1: encoding:", result.stderr)
            self.assertFalse(out.exists())


if __name__ == "__main__":
    testcase.main()
