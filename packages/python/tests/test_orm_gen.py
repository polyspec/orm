# orm-gen generator check: builds models.py from the document set of contracts/fixtures/bench/dbspec-set.json,
# and checks that the generated module interprets the chain syntax (unittest).
import json
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

    # Requirements: DBS-120, DSL-43.
    def test_generated_module_imports_and_builds_the_model(self):
        import models

        self.assertEqual(
            models.MANIFEST_HASH,
            "sha256:fc2ebdd35e5070cdba0955d280f0faafb3300afc268e449f01b5f482071dd030",
        )
        author = models.Author()
        self.assertEqual(author.entity_def.entity.name, "author")
        self.assertEqual(len(models.model.entities), 25)
        self.assertTrue(models.SCHEMA.manifest_text.startswith("dbspec 1 bench"))

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

    def _scan_external(self, text):
        """Runs orm-gen with --scan of one source, for the set of member.dbs that uses core.dbs as an external document."""
        external = ROOT / "contracts" / "fixtures" / "external"
        with tempfile.TemporaryDirectory(prefix="orm-gen-scan-external-") as work:
            work_path = Path(work)
            (work_path / "app").mkdir()
            (work_path / "core").mkdir()
            (work_path / "out").mkdir()
            (work_path / "app" / "member.dbs").write_text(
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
                        "documents": ["app/member.dbs"],
                        "external": ["core/core.dbs"],
                    }
                ),
                encoding="utf-8",
            )
            source = work_path / "usage.py"
            source.write_text(text, encoding="utf-8")
            return subprocess.run(
                args=ORM_GEN
                + [
                    "gen",
                    "--set",
                    str(set_file),
                    "--out",
                    str(work_path / "out"),
                    "--scan",
                    str(source),
                ],
                capture_output=True,
                text=True,
            )

    def test_an_alias_named_match_is_accepted_with_its_getter(self):
        result = self._scan(
            "from models import Author, User\n"
            "a = Author().relation(User().match_user_seq_with_seq().alias_match())"
            ".relation(User().match_user_seq_with_seq().alias_join()).get()\n"
            "a.get_match()\n"
            "a.get_join()\n"
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_nested_relation_alias_attaches_its_getter(self):
        # The alias of a relation nested in a relation names the getter of the model it aliases on, and a receiver
        # annotated through a getter's result resolves to that model.
        result = self._scan(
            "from typing import Iterable\n"
            "from models import Author, User\n"
            "Author().relation(User().match_user_seq_with_seq().alias_writer()"
            ".relation(Author().match_seq_with_user_seq().alias_match())).gets()\n"
            "def read(rows: Iterable[Author]):\n"
            "    for row in rows:\n"
            "        writer: User | None = row.get_writer()\n"
            "        writer.get_match()\n"
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_getter_call_that_nothing_attaches_stops_generation(self):
        result = self._scan(
            "from typing import Iterable\n"
            "from models import Author, User\n"
            "Author().relation(User().match_user_seq_with_seq().alias_writer()).gets()\n"
            "def read(rows: Iterable[Author]):\n"
            "    for row in rows:\n"
            "        writer: User | None = row.get_writer()\n"
            "        writer.get_ghost()\n"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "User.get_ghost is called, but no alias_ghost, new_ghost or add_column call attaches it",
            result.stderr,
        )

    def test_a_call_on_a_class_of_another_set_is_not_this_sets_call(self):
        # Requirements: DSL-151.
        # This set writes model/requests/models.py; model/models.py is another set's output, which shares the class name
        # Author. A call on that Author, imported absolutely or relatively, is not a call of this set.
        with tempfile.TemporaryDirectory(prefix="orm-gen-scan-import-") as work:
            work_path = Path(work)
            (work_path / "src").mkdir()
            source = work_path / "src" / "usage.py"
            source.write_text(
                "from model.models import Author\n"
                "from ..model.models import Author as Main\n"
                "from model.requests.models import User\n"
                "Author().get_ghost()\n"
                "Main().get_phantom()\n"
                "User().ne_name('x')\n",
                encoding="utf-8",
            )
            result = subprocess.run(
                args=ORM_GEN
                + [
                    "gen",
                    "--set",
                    str(ROOT / "contracts" / "fixtures" / "bench" / "dbspec-set.json"),
                    "--out",
                    str(work_path / "model" / "requests"),
                    "--scan",
                    str(source),
                ],
                capture_output=True,
                text=True,
            )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_call_on_a_class_of_this_set_is_checked(self):
        # Requirements: DSL-151.
        # The same calls on the Author of this set's output, imported absolutely or relatively, are this set's calls.
        for line in (
            "from model.requests.models import Author\n",
            "from ..model.requests.models import Author\n",
        ):
            with (
                self.subTest(line=line),
                tempfile.TemporaryDirectory(prefix="orm-gen-scan-import-") as work,
            ):
                work_path = Path(work)
                (work_path / "src").mkdir()
                source = work_path / "src" / "usage.py"
                source.write_text(line + "Author().get_ghost()\n", encoding="utf-8")
                result = subprocess.run(
                    args=ORM_GEN
                    + [
                        "gen",
                        "--set",
                        str(
                            ROOT
                            / "contracts"
                            / "fixtures"
                            / "bench"
                            / "dbspec-set.json"
                        ),
                        "--out",
                        str(work_path / "model" / "requests"),
                        "--scan",
                        str(source),
                    ],
                    capture_output=True,
                    text=True,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Author.get_ghost is called", result.stderr)

    def test_a_file_that_does_not_parse_fails_the_scan(self):
        # Requirements: DSL-152.
        # An unparsable file of a scanned directory stops the generation, writes nothing, and names the file and position.
        with tempfile.TemporaryDirectory(prefix="orm-gen-scan-parse-") as work:
            work_path = Path(work)
            (work_path / "src").mkdir()
            (work_path / "src" / "usage.py").write_text("x = 1\n", encoding="utf-8")
            (work_path / "src" / "broken.py").write_text("x = 1\ndef (:\n", encoding="utf-8")
            out = work_path / "model"
            result = subprocess.run(
                args=ORM_GEN
                + [
                    "gen",
                    "--set",
                    str(ROOT / "contracts" / "fixtures" / "bench" / "dbspec-set.json"),
                    "--out",
                    str(out),
                    "--scan",
                    str(work_path / "src"),
                ],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0, result.stderr)
            self.assertIn("broken.py:2:", result.stderr)
            self.assertFalse(out.exists())

    def test_a_receiver_held_in_a_reassigned_name_resolves_to_its_class(self):
        # Requirements: DSL-151.
        # A name bound from a chain on an imported class and rebound from its own chain in a conditional expression still
        # holds that class, as the checker types it, so a getter called on it after each rebinding is checked as its call.
        result = self._scan(
            "from models import Author\n"
            "def page(db, limit):\n"
            "    page = Author().connect(db).add_all_columns()\n"
            "    conditions = 0\n"
            "    if limit is not None:\n"
            "        page = page.gt_read_count(limit) if conditions == 0 else page.and_gt_read_count(limit)\n"
            "        conditions += 1\n"
            "    if limit is not None: page = page.lt_seq(limit) if conditions == 0 else page.and_lt_seq(limit)\n"
            "    page.get_ghost()\n"
        )
        self.assertNotEqual(
            result.returncode, 0, "a getter called on a reassigned name was not checked"
        )
        self.assertIn("Author.get_ghost is called", result.stderr)

    def test_a_relation_to_an_entity_of_a_used_document_attaches_its_getter(self):
        # ext_post of member.dbs uses ext_audit of core.dbs, an external document: the relation to ExtAudit attaches
        # get_ext_audit_model as it does for a local entity.
        result = self._scan_external(
            "from typing import Iterable\n"
            "from models import ExtPost\n"
            "ExtPost().relation(ExtAudit().connect(db).match_audit_seq_with_seq()).gets()\n"
            "def read(rows: Iterable[ExtPost]):\n"
            "    for row in rows:\n"
            "        row.get_ext_audit_model()\n"
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_name_is_typed_by_its_binding_in_its_own_scope(self):
        # The outer row is a ServiceMember. The nested function rebinds row to a value the scan cannot type, so its
        # set_is_close call is not the outer ServiceMember's; the call on an Author row in another nested function is
        # attributed to Author.
        result = self._scan(
            "from models import Author, ServiceMember\n"
            "def read(db):\n"
            "    row = ServiceMember().connect(db).get()\n"
            "    def write(db):\n"
            "        row = db.load_author(2)\n"
            "        row.set_is_close(True)\n"
            "    def write_author(db):\n"
            "        row = Author().connect(db).get()\n"
            "        row.set_is_close(False)\n"
            "    write(db)\n"
            "    write_author(db)\n"
            "    row.set_user_seq(4)\n"
        )
        self.assertEqual(result.returncode, 0, result.stderr)

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

    # Requirements: ORES-21.
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
