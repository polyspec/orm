# Generated models declare the query methods that the schema enumerates, each typed to return the model (T161-1): the
# condition method of every column, the tuple method of every key prefix of two or more columns and the column methods,
# so a type checker reads their result as the model; each builds the same query as the chain name it declares.
import types
import subprocess
import sys
import tempfile
import typing
import unittest
from pathlib import Path
from . import testcase

ROOT = Path(__file__).resolve().parents[3]
ORM_GEN = [sys.executable, "-m", "polyspec.orm.bin_orm_gen"]
SCHEMA = (
    "dbspec 1 methods\n\ntable item {\n  seq i64\n  account_seq i64\n  project_seq i64\n  name varchar(32)\n"
    "  primary key (seq)\n  unique uq_item_name (name)\n  index ix_item_account (account_seq, project_seq)\n}\n"
)


class QueryMethodsTest(unittest.TestCase):
    deadline = testcase.PROCESS

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="orm-query-methods-")
        root = Path(cls.tmp.name)
        (root / "set").mkdir()
        (root / "set" / "methods.dbs").write_text(SCHEMA)
        (root / "set" / "dbspec-set.json").write_text(
            '{"schema":1,"documents":["methods.dbs"]}\n'
        )
        (root / "empty.py").write_text("")
        result = subprocess.run(
            ORM_GEN
            + [
                "gen",
                "--set",
                str(root / "set" / "dbspec-set.json"),
                "--out",
                str(root / "out"),
                "--scan",
                str(root / "empty.py"),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stderr
        # The generated module is compiled from its source and registered by name.
        source = root / "out" / "models.py"
        cls.models = types.ModuleType("query_methods_models")
        cls.models.__file__ = str(source)
        sys.modules["query_methods_models"] = cls.models
        exec(
            compile(source.read_text(), cls.models.__file__, "exec"),
            cls.models.__dict__,
        )

    @classmethod
    def tearDownClass(cls):
        sys.modules.pop("query_methods_models", None)
        cls.tmp.cleanup()

    def test_every_query_method_is_declared_and_typed(self):
        item = self.models.Item
        for name in [
            "seq",
            "account_seq",
            "name",
            "tuple_account_seq_with_project_seq",
            "order_by_seq_asc",
            "add_column_name",
            "plus_seq",
            "force_index_ix_item_account",
        ]:
            self.assertIn(
                name, item.__dict__, f"{name} is not declared on the generated class"
            )
            self.assertIs(
                typing.get_type_hints(item.__dict__[name]).get("return"),
                typing.Self,
                name,
            )

    def test_a_declared_method_builds_the_query_of_its_chain(self):
        declared = (
            self.models.Item()
            .account_seq(3)
            .tuple_account_seq_with_project_seq([[1, 2]])
        )
        resolved = self.models.Item()
        resolved = type(resolved).__mro__[1].__getattr__(resolved, "account_seq")(3)
        resolved = (
            type(resolved)
            .__mro__[1]
            .__getattr__(resolved, "tuple_account_seq_with_project_seq")([[1, 2]])
        )
        self.assertEqual(
            repr(declared.core.where.items), repr(resolved.core.where.items)
        )
        self.assertTrue(declared.core.where.items)


if __name__ == "__main__":
    testcase.main()
