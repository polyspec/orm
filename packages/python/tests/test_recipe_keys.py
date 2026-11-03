# The refusal unit test of the Python recipe loader's key check (FCV-2 to FCV-4, T334-3-5-6): each unknown file, case, op or
# step key is refused by name, and a recipe whose keys the table holds is accepted.
import json
import unittest

from .recipe_keys import check_keys
from .recipe_model import connect_dsn

# A recipe at a path whose $schema is the recipe schema of this checkout, so the key table beside it is read.
PATH = "contracts/fixtures/model_writes/model_writes.json"
SCHEMA = "../../../scripts/features/schema/recipe.schema.json"


def recipe(file=None, case=None, step=None):
    step = {"op": "dsn.connect", "dsn": "case"} if step is None else step
    body = {
        "$schema": SCHEMA,
        **(file or {}),
        "cases": [{"id": "case-under-test", "steps": [step], **(case or {})}],
    }
    return json.dumps(body)


class CheckKeysTest(unittest.TestCase):
    def test_a_recipe_whose_keys_the_table_holds_is_accepted(self):
        check_keys(PATH, recipe())

    def test_an_unknown_file_key_is_refused_by_name(self):
        with self.assertRaisesRegex(ValueError, r"unknown key bogus$"):
            check_keys(PATH, recipe(file={"bogus": 1}))

    def test_an_unknown_case_key_is_refused_by_name_with_its_case(self):
        with self.assertRaisesRegex(
            ValueError, r"case case-under-test: unknown key bogus$"
        ):
            check_keys(PATH, recipe(case={"bogus": 1}))

    def test_an_unknown_op_is_refused_by_name_with_its_step(self):
        with self.assertRaisesRegex(ValueError, r"step 0: unknown op no\.such\.op$"):
            check_keys(PATH, recipe(step={"op": "no.such.op"}))

    def test_a_step_key_another_op_holds_is_refused_on_the_op_that_does_not_hold_it(
        self,
    ):
        with self.assertRaisesRegex(
            ValueError, r"\(dsn\.connect\): unknown key pool_size$"
        ):
            check_keys(
                PATH, recipe(step={"op": "dsn.connect", "dsn": "case", "pool_size": 2})
            )

    def test_a_recipe_with_no_schema_is_refused_since_it_names_no_key_table(self):
        with self.assertRaisesRegex(
            ValueError, r"no \$schema names the recipe key table"
        ):
            check_keys(PATH, json.dumps({"cases": []}))

    def test_model_connect_opens_the_case_database_the_socket_or_the_text(self):
        case = "mysql://root@127.0.0.1:3306/orm_case_17"
        self.assertEqual(connect_dsn(None, "mysql", case), case)
        self.assertEqual(connect_dsn("case", "mysql", case), case)
        self.assertEqual(connect_dsn("sqlite://x", "sqlite", case), "sqlite://x")
        self.assertEqual(
            connect_dsn("case-socket", "mysql", case, "/s/mysql.sock"),
            "mysql://root@localhost/orm_case_17?socket=/s/mysql.sock",
        )
        with self.assertRaisesRegex(ValueError, "needs mysql, not postgres"):
            connect_dsn("case-socket", "postgres", case, "/s/mysql.sock")
        with self.assertRaisesRegex(ValueError, "is unset"):
            connect_dsn("case-socket", "mysql", case, "")
