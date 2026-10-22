# render_dbspec refuses a dialect it does not know with a TypeError, beyond the cases of tests/dbspec/ddl.json.
import unittest

from polyspec.orm.dbspec.render import render_dbspec
from .dbspec_ddl import DATA, parse_set
from . import testcase


# DBS-174: render_dbspec refuses a dialect it does not know with a TypeError.
class RenderDialectTest(unittest.TestCase):
    # Requirements: DBS-174.
    def test_unknown_dialect_is_a_type_error(self):
        documents = parse_set(DATA["cases"][-1]["documents"])
        with self.assertRaises(TypeError):
            render_dbspec(documents, "oracle")


if __name__ == "__main__":
    testcase.main()
