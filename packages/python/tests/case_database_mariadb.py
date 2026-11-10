# The drop of a case database on MariaDB, a server of the MySQL dialect (docs/spec/dialects.md DIA-212, DIA-200): the case
# DropDiscardsItsSessionCase of server_database, as test_case_database_mysql runs it on MySQL. make
# mariadb-recipes-check/python runs this entry, since no test_*.py discovery finds it.
import unittest

from . import testcase
from .server_database import DropDiscardsItsSessionCase


class DropDiscardsItsSessionMariadbTest(DropDiscardsItsSessionCase, unittest.TestCase):
    dialect = "mariadb"


if __name__ == "__main__":
    testcase.main()
