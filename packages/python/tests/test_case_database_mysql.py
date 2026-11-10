# The drop of a case database on MySQL (docs/spec/dialects.md DIA-212): the case DropDiscardsItsSessionCase of
# server_database.
import unittest

from . import testcase
from .server_database import DropDiscardsItsSessionCase


class DropDiscardsItsSessionMysqlTest(DropDiscardsItsSessionCase, unittest.TestCase):
    dialect = "mysql"


if __name__ == "__main__":
    testcase.main()
