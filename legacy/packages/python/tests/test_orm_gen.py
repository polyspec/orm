# orm-gen generator check: builds models.py from the document set of contracts/fixtures/bench/dbspec-set.json,
# and checks that the generated module interprets the chain syntax (unittest).
import hashlib
import inspect
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import types
import typing
import unittest
from pathlib import Path
from unittest import mock

from polyspec.orm import OrmError, RuntimeModel
from polyspec.orm.database import Db
from polyspec.orm.dbspec.manifest import dbspec_manifest
from polyspec.orm.engine import model as engine_model
from polyspec.orm.generate.python import write_text_if_changed
from polyspec.orm.model import register_model
from polyspec.orm.schema import Schema

from . import testcase

ROOT = Path(__file__).resolve().parents[3]

# orm-gen runs from the package installed into this interpreter's venv.
ORM_GEN = [sys.executable, "-m", "polyspec.orm.bin_orm_gen"]


def run_gen(set_file, out, scan=None):
    """Runs gen on the document set file, writing the models to out; with scan, it also scans that file for calls."""
    args = ORM_GEN + ["gen", "--set", str(set_file), "--out", str(out)]
    if scan is not None:
        args += ["--scan", str(scan)]
    return subprocess.run(args=args, capture_output=True, text=True)


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

    # Requirements: DBS-104, DBS-111, DBS-120, DSL-38, DSL-43.
    # Requirements: SCH-1.
    # Requirements: INT-145, DSL-128, DSL-151, DSL-152.
    def test_generated_module_imports_and_builds_the_model(self):
        import models

        self.assertEqual(
            models.MANIFEST_HASH,
            "sha256:17ab57ea09162c73e601b9636e42d5df436b0a87dce92c0ba786ac3c931f6b9a",
        )
        author = models.Author()
        self.assertEqual(author.entity_def.entity.name, "author")
        self.assertEqual(len(models.model.entities), 27)
        self.assertEqual(list(models.model.entities)[:3], ["author", "user", "service"])
        self.assertTrue(models.SCHEMA.manifest_text.startswith("dbspec 1 bench"))
        self.assertEqual(
            models.MANIFEST_HASH,
            "sha256:"
            + hashlib.sha256(
                (models.SCHEMA.manifest_text + models.SCHEMA.external_text).encode()
            ).hexdigest(),
        )

    def test_generated_external_model_reads_its_table(self):
        # The generated schema value carries the external text at run time: the generated connect registers a set that
        # uses an external document, and the model of a used external table reads a row of that table.
        # Requirements: DBS-110, DBS-173.
        external = ROOT / "contracts" / "fixtures" / "external"
        with tempfile.TemporaryDirectory(prefix="orm-gen-external-") as work:
            work_path = Path(work)
            (work_path / "core").mkdir()
            (work_path / "out").mkdir()
            (work_path / "member.dbs").write_text(
                (external / "member.dbs").read_text(encoding="utf-8"), encoding="utf-8"
            )
            (work_path / "core" / "core.dbs").write_text(
                (external / "core.dbs").read_text(encoding="utf-8"), encoding="utf-8"
            )
            set_file = work_path / "dbspec-set.json"
            set_file.write_text(
                json.dumps(
                    {
                        "schema": 1,
                        "documents": ["member.dbs"],
                        "external": ["core/core.dbs"],
                    }
                ),
                encoding="utf-8",
            )
            subprocess.run(
                args=ORM_GEN
                + ["gen", "--set", str(set_file), "--out", str(work_path / "out")],
                capture_output=True,
                text=True,
                check=True,
            )
            source = work_path / "out" / "models.py"
            module = types.ModuleType("external_models")
            module.__file__ = str(source)
            sys.modules["external_models"] = module
            self.addCleanup(sys.modules.pop, "external_models", None)
            exec(compile(source.read_text(), module.__file__, "exec"), module.__dict__)
            path = work_path / "external.sqlite"
            raw = sqlite3.connect(path)
            try:
                raw.execute(
                    "CREATE TABLE ext_account (seq INTEGER PRIMARY KEY, name TEXT NOT NULL)"
                )
                raw.execute("INSERT INTO ext_account (seq, name) VALUES (1, 'kim')")
                raw.commit()
            finally:
                raw.close()
            db = module.connect(f"sqlite://{path}")
            try:
                row = module.ExtAccount().connect(db).get_by_seq(1)
                self.assertEqual(row.get_name(), "kim")
            finally:
                db.close()

    def test_a_time_setter_takes_the_text_form(self):
        # Requirements: DBS-121.
        import models

        for model, setter, annotation in (
            (models.TimeCell, "set_at", str),
            (models.Author, "set_created_ts", str),
            (models.Author, "set_display_start_dt", str | None),
        ):
            parameter = inspect.signature(getattr(model, setter)).parameters["value"]
            self.assertEqual(
                parameter.annotation,
                annotation,
                f"{model.__name__}.{setter} takes a native value",
            )

    # Requirements: DBS-112, DBS-114, INT-66.
    def test_generated_typed_getter_is_the_public_column_api(self):
        import models
        from polyspec.orm import OrmError, codes

        author = models.Author()
        self.assertEqual(typing.get_type_hints(models.Author.get_seq)["return"], int)
        self.assertEqual(typing.get_type_hints(models.Author.set_seq)["value"], int)
        self.assertTrue(callable(models.Author.get_seq))
        self.assertTrue(callable(models.Author.set_seq))
        self.assertNotIn("seq", models.Author.__annotations__)
        with self.assertRaises(OrmError) as caught:
            author.get_seq()
        self.assertEqual(caught.exception.code, codes.COLUMN_UNSELECTED)

        self.assertIs(author.set_seq(17), author)
        self.assertEqual(author.get_seq(), 17)

    def test_fixed_column_methods(self):
        import models

        user = models.User()
        user.set_name("tester")
        self.assertEqual(user.core.values, {"name": "tester"})
        self.assertEqual(
            [(spec.column, spec.value) for spec in user.core.sets], [("name", "tester")]
        )
        user.get_name  # The generated getter exists
        user.add_column_name().remove_column_name()
        self.assertEqual(user.core.columns_add, ["name"])
        self.assertEqual(user.core.columns_remove, ["name"])
        author = models.Author()
        author.plus_like_count(3)
        self.assertEqual(
            [(spec.column, spec.value, spec.plus) for spec in author.core.sets],
            [("like_count", 3, True)],
        )

    # Requirements: INT-28, PLN-1, PLN-40.
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

    def test_a_restore_or_create_call_is_a_model_method(self):
        # restore_or_create is a public method of Model, so a scanned call to it is accepted.
        result = self._scan(
            "from models import Author\nrow = Author().restore_or_create()\n"
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_an_alias_call_is_a_model_method(self):
        # alias is a public method of Model, so a scanned call to it is accepted.
        result = self._scan(
            "from models import Author\nauthor = Author().alias('author_alias')\n"
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def _scan(self, text):
        """Runs orm-gen with --scan of one source into a new folder; returns the completed process."""
        with tempfile.TemporaryDirectory(prefix="orm-gen-scan-") as out:
            source = Path(out) / "usage.py"
            source.write_text(text, encoding="utf-8")
            return subprocess.run(
                args=ORM_GEN
                + [
                    "gen",
                    "--set",
                    str(ROOT / "contracts" / "fixtures" / "bench" / "dbspec-set.json"),
                    "--out",
                    out,
                    "--scan",
                    str(source),
                ],
                capture_output=True,
                text=True,
            )

    def test_a_name_that_may_hold_two_models_is_checked_against_each(self):
        # No class declares set_ghost_column, so the call on a name that may hold either model is refused.
        # Each construct binds row to a ServiceMember on one path: an if, a match, a try and a loop.
        sources = {
            "branches": (
                "from models import Author, ServiceMember\n"
                "def read(flag):\n"
                "    if flag:\n"
                "        row = ServiceMember()\n"
                "    else:\n"
                "        row = Author()\n"
                "    row.set_ghost_column(True)\n"
            ),
            "match": (
                "from models import Author, ServiceMember\n"
                "def read(k):\n"
                "    match k:\n"
                "        case 1:\n"
                "            row = ServiceMember()\n"
                "        case _:\n"
                "            row = Author()\n"
                "    row.set_ghost_column(True)\n"
            ),
            "try": (
                "from models import Author, ServiceMember\n"
                "def read():\n"
                "    try:\n"
                "        row = ServiceMember()\n"
                "    except ValueError:\n"
                "        row = Author()\n"
                "    row.set_ghost_column(True)\n"
            ),
            "loop": (
                "from models import Author, ServiceMember\n"
                "def read(more):\n"
                "    row = Author()\n"
                "    while more:\n"
                "        row.set_ghost_column(True)\n"
                "        row = ServiceMember()\n"
            ),
        }
        for name, source in sources.items():
            with self.subTest(construct=name):
                result = self._scan(source)
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertIn("is not a model method", result.stderr)

    def _assert_round_three(self, source, expected_code, message=None):
        result = self._scan(source)
        self.assertEqual(result.returncode, expected_code, result.stderr)
        if message is not None:
            self.assertIn(message, result.stderr)

    def test_a_possible_class_with_the_getter_accepts_the_call_after_an_if(self):
        self._assert_round_three(
            "from models import Author, User\n"
            "def read(x):\n"
            "    row = Author()\n"
            "    if x:\n"
            "        row = User()\n"
            "    row.get_is_close()\n",
            0,
        )

    def test_a_branch_that_returns_contributes_nothing(self):
        self._assert_round_three(
            "from models import Author, User\n"
            "def read(x):\n"
            "    row = Author()\n"
            "    if x:\n"
            "        row = User()\n"
            "        return\n"
            "    row.get_is_close()\n",
            0,
        )

    def test_a_finally_block_starts_from_every_outcome_of_the_try(self):
        self._assert_round_three(
            "from models import Author, User\n"
            "def read():\n"
            "    row = Author()\n"
            "    try:\n"
            "        row = User()\n"
            "    finally:\n"
            "        row.get_is_close()\n",
            0,
        )

    def test_a_loop_that_may_run_zero_times_keeps_the_class_before_it(self):
        self._assert_round_three(
            "from models import Author, User\n"
            "def read(xs):\n"
            "    row = Author()\n"
            "    for x in xs:\n"
            "        row = User()\n"
            "    row.get_is_close()\n",
            0,
        )

    def test_an_except_name_is_unknown_after_the_handler(self):
        self._assert_round_three(
            "from models import Author, User\n"
            "def read():\n"
            "    row = User()\n"
            "    try:\n"
            "        pass\n"
            "    except ValueError as row:\n"
            "        pass\n"
            "    row.get_is_close()\n",
            0,
        )

    def test_none_contributes_nothing(self):
        self._assert_round_three(
            "from models import Author, User\n"
            "def read(x):\n"
            "    row = None\n"
            "    if x:\n"
            "        row = User()\n"
            "    row.get_is_close()\n",
            1,
            "User.get_is_close is called",
        )

    def test_a_with_or_except_name_in_a_loop_is_unknown_at_its_entry(self):
        self._assert_round_three(
            "from models import Author, User\n"
            "def read(c, items):\n"
            "    row = User()\n"
            "    while c:\n"
            "        row.get_is_close()\n"
            "        with open(items) as row:\n"
            "            pass\n",
            0,
        )

    def test_a_method_is_refused_only_when_no_possible_class_declares_it(self):
        # Author has is_close and ServiceMember does not: the call after the if or the try is on Author too.
        self._assert_round_three(
            "from models import Author, ServiceMember\n"
            "def read(x):\n"
            "    if x:\n"
            "        row = Author()\n"
            "        exit(1)\n"
            "    else:\n"
            "        row = ServiceMember()\n"
            "    row.set_is_close(True)\n",
            0,
        )
        self._assert_round_three(
            "from models import Author, ServiceMember\n"
            "def read():\n"
            "    try:\n"
            "        row = Author()\n"
            "    except ValueError:\n"
            "        row = ServiceMember()\n"
            "    row.set_is_close(True)\n",
            0,
        )
        # A handler that re-raises contributes nothing, so the call is on Author alone.
        self._assert_round_three(
            "from models import Author, ServiceMember\n"
            "def read():\n"
            "    try:\n"
            "        row = Author()\n"
            "    except ValueError:\n"
            "        row = ServiceMember()\n"
            "        raise\n"
            "    row.set_is_close(True)\n",
            0,
        )

    def test_a_try_leaves_no_outcome_with_the_value_before_it(self):
        self._assert_round_three(
            "from models import Author, ServiceMember\n"
            "def read():\n"
            "    row = Author()\n"
            "    try:\n"
            "        row = ServiceMember()\n"
            "    except ValueError:\n"
            "        row = ServiceMember()\n"
            "    row.set_is_close(True)\n",
            1,
            "ServiceMember.set_is_close is not a model method",
        )

    def test_a_variadic_or_keyword_parameter_binds_its_name(self):
        # module is an Author in the outer scope; the *module and lambda parameters named module are not Author rows.
        self._assert_round_three(
            "from models import Author\n"
            "module = Author()\n"
            "def holds(db, *module, **options):\n"
            "    module.set_ghost_column(True)\n",
            0,
        )
        self._assert_round_three(
            "from models import Author\n"
            "module = Author()\n"
            "holds = lambda *module, **options: module.set_ghost_column(True)\n",
            0,
        )

    def test_a_parameter_annotated_with_another_class_is_not_the_outer_model(self):
        self._assert_round_three(
            "from models import Author\n"
            "module = Author()\n"
            "class Installer:\n"
            "    def _holds(self, db, module: Holder, *rest, **options):\n"
            "        module.set_ghost_column(True)\n",
            0,
        )

    def test_a_parameter_annotated_with_a_model_records_against_that_model(self):
        self._assert_round_three(
            "from models import Author\n"
            "def holds(db, module: Author):\n"
            "    module.set_ghost_column(True)\n",
            1,
            "Author.set_ghost_column is not a model method",
        )

    def test_a_class_named_like_a_model_but_imported_from_another_module_is_not_the_model(
        self,
    ):
        # consumer's harness imports the model Module as ModuleRow and its own class Module from another module; a parameter
        # annotated with the class Module is not a model row, so its call is not checked against the model Author.
        self._assert_round_three(
            "from models import Author as AuthorRow\n"
            "from .calls import Author\n"
            "def call(row: Author):\n"
            "    row.set_ghost_column(True)\n",
            0,
        )
        # The model imported from models still records against its class.
        self._assert_round_three(
            "from models import Author as AuthorRow\n"
            "def call(row: AuthorRow):\n"
            "    row.set_ghost_column(True)\n",
            1,
            "Author.set_ghost_column is not a model method",
        )

    def test_the_removed_document_flags_are_usage_errors(self):
        # Requirements: ORES-21, DBS-5, DBS-98.
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

    # Requirements: DBS-112, DBS-116, DBS-121, INT-2, INT-3, INT-4, INT-5, INT-6, INT-7, INT-8, COD-2.
    def test_generated_field_types_follow_runtime_model(self):
        # Requirements: DBS-112, DBS-121, INT-2, INT-3, INT-4, INT-5, INT-6, INT-7, INT-8.
        from polyspec.orm import StyledValue

        with tempfile.TemporaryDirectory(prefix="orm-gen-field-types-") as tree:
            root = Path(tree)
            (root / "typed.dbs").write_text(
                "dbspec 1 typed\n\ntable item {\n  seq i64 identity\n  ratio f64\n  enabled bool\n  body text\n  payload bytes null\n  day date\n  clock time(3)\n  moment datetime(3) null\n  json_value text null\n  primary key (seq)\n  settings {\n    codec json_value ordered_json\n  }\n}\n",
                encoding="utf-8",
            )
            (root / "dbspec-set.json").write_text(
                '{"schema": 1, "documents": ["typed.dbs"]}', encoding="utf-8"
            )
            out = root / "out"
            result = run_gen(root / "dbspec-set.json", out)
            self.assertEqual(result.returncode, 0, result.stderr)
            source = out / "models.py"
            module = types.ModuleType("generated_field_types")
            module.__file__ = str(source)
            exec(
                compile(source.read_text(encoding="utf-8"), str(source), "exec"),
                module.__dict__,
            )
            for field, expected in (
                ("ratio", float),
                ("enabled", bool),
                ("body", str),
                ("payload", bytes | None),
                ("day", str),
                ("clock", str),
                ("moment", str | None),
                ("json_value", StyledValue),
            ):
                model = module.Item
                self.assertEqual(
                    typing.get_type_hints(getattr(model, f"get_{field}"))["return"],
                    expected,
                    f"{model.__name__}.{field} getter type",
                )
                self.assertEqual(
                    typing.get_type_hints(getattr(model, f"set_{field}"))["value"],
                    expected,
                    f"{model.__name__}.{field} setter type",
                )


# write_text_if_changed (T341-2): a file that holds the text is left as it is, and a changed file is renamed over the old one from its directory.
class WriteTextIfChangedTest(unittest.TestCase):
    def test_same_text_leaves_the_file_without_a_rename(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "models.py")
            write_text_if_changed(path, "a = 1\n")
            with mock.patch("os.replace") as replace:
                write_text_if_changed(path, "a = 1\n")
            replace.assert_not_called()
            with open(path, encoding="utf-8") as handle:
                self.assertEqual(handle.read(), "a = 1\n")

    def test_changed_text_is_renamed_over_the_old_file_from_its_own_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "models.py")
            write_text_if_changed(path, "a = 1\n")
            with mock.patch("os.replace", wraps=os.replace) as replace:
                write_text_if_changed(path, "a = 2\n")
            replace.assert_called_once()
            source, target = replace.call_args.args
            self.assertEqual(os.path.dirname(source), directory)
            self.assertEqual(target, path)
            self.assertEqual(os.listdir(directory), ["models.py"])
            with open(path, encoding="utf-8") as handle:
                self.assertEqual(handle.read(), "a = 2\n")

    def test_missing_file_is_created(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "models.py")
            write_text_if_changed(path, "b = 1\n")
            with open(path, encoding="utf-8") as handle:
                self.assertEqual(handle.read(), "b = 1\n")
            self.assertEqual(os.listdir(directory), ["models.py"])


REGISTRY_DOCUMENT = (
    "dbspec 1 registry\n\ntable note {\n  seq i64\n  primary key (seq)\n}\n"
)


class ModelRegistryTest(unittest.TestCase):
    """A process builds the model of a manifest once (DBS-104): a second registration of the same texts and hash, on any
    connection, and a second load_set of the same texts parse nothing."""

    # Requirements: DBS-104.
    def test_the_same_schema_is_parsed_once(self):
        documents = RuntimeModel.load_set(REGISTRY_DOCUMENT, "")
        manifest, diagnostics = dbspec_manifest(documents)
        self.assertEqual(diagnostics, ())
        schema = Schema(manifest.manifest_text, manifest.manifest_hash)
        parse = mock.patch.object(
            engine_model,
            "parse_document_set",
            wraps=engine_model.parse_document_set,
        )
        folder = tempfile.TemporaryDirectory(prefix="orm-model-registry-")
        self.addCleanup(folder.cleanup)
        connections = [Db(f"sqlite://{folder.name}/{i}.sqlite") for i in range(2)]
        try:
            with parse as parsed:
                first = register_model(schema.manifest_text, schema.manifest_hash)
                built = parsed.call_count
                self.assertLessEqual(built, 1)
                register_model(schema.manifest_text, schema.manifest_hash)
                for db in connections:
                    db.register(schema)
                RuntimeModel.load_set(schema.manifest_text, "")
                RuntimeModel.load_set(schema.manifest_text, "")
                self.assertEqual(
                    parsed.call_count, built, "a registered schema is not parsed again"
                )
        finally:
            for db in connections:
                db.close()
        self.assertIs(
            register_model(schema.manifest_text, schema.manifest_hash).runtime,
            first.runtime,
        )

    # Requirements: DBS-104.
    def test_a_known_text_under_another_hash_is_still_refused(self):
        documents = RuntimeModel.load_set(REGISTRY_DOCUMENT, "")
        manifest, _ = dbspec_manifest(documents)
        register_model(manifest.manifest_text, manifest.manifest_hash)
        with self.assertRaises(OrmError) as caught:
            register_model(manifest.manifest_text, "sha256:" + "0" * 64)
        self.assertEqual(caught.exception.code, "SCHEMA_HASH_MISMATCH")


if __name__ == "__main__":
    testcase.main()
