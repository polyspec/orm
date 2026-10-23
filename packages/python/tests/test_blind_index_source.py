"""Pure planner regressions for source-specific derived blind-index assignments."""

import unittest

from polyspec.orm.engine import Engine, model_of_documents, parse_document_set
from polyspec.orm.errors import OrmError
from . import testcase

SCHEMA = """dbspec 1 shared
table t {
  id i64
  version i32
  name varchar(191)
  email_a bytes null
  email_b bytes null
  hash varchar(64) null
  primary key (id)
  index ix_t_hash (hash)
  settings {
    codec email_a aes
    codec email_b aes
    aes_version version
    blind_index email_a hash
    blind_index email_b hash
  }
}
"""


def model():
    return model_of_documents(parse_document_set([SCHEMA]))


def assignment(column, parameter):
    return {"column": column, "p": parameter}


class BlindIndexSourceTest(unittest.TestCase):
    deadline = testcase.COMPUTE

    def test_multi_row_index_binds_the_assigned_source_column_position(self):
        runtime = model()
        plan = Engine(runtime, "mysql").compile(
            {
                "ir_version": 1,
                "manifest_hash": runtime.manifest_hash,
                "kind": "insert",
                "entity": "t",
                "n_params": 6,
                "set": [
                    assignment("id", 0),
                    assignment("name", 1),
                    assignment("email_b", 2),
                ],
                "rows": [[3, 4, 5]],
            }
        )
        slots = plan["steps"][0]["bind_slots"]
        self.assertEqual(
            [
                slot["param"]
                for slot in slots
                if "blind_index" in slot.get("host_styles", [])
            ],
            [2, 5],
        )

    def test_ordinary_insert_has_no_blind_index_assignment(self):
        runtime = model()
        plan = Engine(runtime, "mysql").compile(
            {
                "ir_version": 1,
                "manifest_hash": runtime.manifest_hash,
                "kind": "insert",
                "entity": "t",
                "n_params": 2,
                "set": [assignment("id", 0), assignment("name", 1)],
            }
        )
        self.assertFalse(
            any(
                "blind_index" in slot.get("host_styles", [])
                for slot in plan["steps"][0]["bind_slots"]
            )
        )

    def test_two_sources_of_one_derived_target_are_invalid_even_when_null(self):
        runtime = model()
        with self.assertRaises(OrmError) as raised:
            Engine(runtime, "mysql").compile(
                {
                    "ir_version": 1,
                    "manifest_hash": runtime.manifest_hash,
                    "kind": "insert",
                    "entity": "t",
                    "n_params": 2,
                    "set": [
                        assignment("id", 0),
                        assignment("name", 1),
                        {"column": "email_a", "null": True},
                        {"column": "email_b", "null": True},
                    ],
                }
            )
        self.assertEqual(raised.exception.code, "IR_INVALID")
        self.assertIn("hash", str(raised.exception))
        self.assertIn("email_a", str(raised.exception))
        self.assertIn("email_b", str(raised.exception))

    def test_two_sources_with_equal_parameter_are_invalid(self):
        runtime = model()
        with self.assertRaises(OrmError) as raised:
            Engine(runtime, "mysql").compile(
                {
                    "ir_version": 1,
                    "manifest_hash": runtime.manifest_hash,
                    "kind": "insert",
                    "entity": "t",
                    "n_params": 3,
                    "set": [
                        assignment("id", 0),
                        assignment("name", 1),
                        assignment("email_a", 2),
                        assignment("email_b", 2),
                    ],
                }
            )
        self.assertEqual(raised.exception.code, "IR_INVALID")
        self.assertIn("hash", str(raised.exception))
        self.assertIn("email_a", str(raised.exception))
        self.assertIn("email_b", str(raised.exception))

    def test_explicit_target_assignment_wins_for_shared_schema(self):
        runtime = model()
        plan = Engine(runtime, "mysql").compile(
            {
                "ir_version": 1,
                "manifest_hash": runtime.manifest_hash,
                "kind": "insert",
                "entity": "t",
                "n_params": 5,
                "set": [
                    assignment("id", 0),
                    assignment("name", 1),
                    assignment("email_a", 2),
                    assignment("email_b", 3),
                    assignment("hash", 4),
                ],
            }
        )
        self.assertEqual(plan["steps"][0]["sql"].count("`hash`"), 1)

    def test_on_duplicate_rejects_two_sources_independently(self):
        runtime = model()
        cases = [
            (
                "different parameters",
                [assignment("email_a", 2), assignment("email_b", 3)],
                4,
            ),
            ("same parameter", [assignment("email_a", 2), assignment("email_b", 2)], 3),
            (
                "null values",
                [
                    {"column": "email_a", "null": True},
                    {"column": "email_b", "null": True},
                ],
                2,
            ),
        ]
        for label, on_duplicate, n_params in cases:
            with self.subTest(label=label):
                with self.assertRaises(OrmError) as raised:
                    Engine(runtime, "mysql").compile(
                        {
                            "ir_version": 1,
                            "manifest_hash": runtime.manifest_hash,
                            "kind": "insert",
                            "entity": "t",
                            "n_params": n_params,
                            "set": [assignment("id", 0), assignment("name", 1)],
                            "on_duplicate": on_duplicate,
                        }
                    )
                self.assertEqual(raised.exception.code, "IR_INVALID")
                self.assertIn("hash", str(raised.exception))
                self.assertIn("email_a", str(raised.exception))
                self.assertIn("email_b", str(raised.exception))

    def test_explicit_target_wins_in_on_duplicate(self):
        runtime = model()
        plan = Engine(runtime, "mysql").compile(
            {
                "ir_version": 1,
                "manifest_hash": runtime.manifest_hash,
                "kind": "insert",
                "entity": "t",
                "n_params": 5,
                "set": [assignment("id", 0), assignment("name", 1)],
                "on_duplicate": [
                    assignment("email_a", 2),
                    assignment("email_b", 3),
                    assignment("hash", 4),
                ],
            }
        )
        self.assertEqual(plan["steps"][0]["sql"].count("`hash`"), 1)


if __name__ == "__main__":
    testcase.main()
