import tempfile
import unittest
from pathlib import Path

from polyspec.orm import codes
from polyspec.orm.errors import OrmError
from polyspec.orm.models import models
from .coverage_case import CoverageCase, coverage_main


def duplicate_relation_name():
    with tempfile.TemporaryDirectory(prefix="orm-cpx5-") as directory:
        db = models.connect(f"sqlite://{Path(directory) / 'cpx5.sqlite3'}")
        try:
            query = (
                models.Author().connect(db)
                .relation(models.User().match_user_seq_with_seq())
                .relation(models.User().match_user_seq_with_seq())
            )
            try:
                query.get_query()
            except OrmError as error:
                if error.code != codes.CONFIG:
                    raise AssertionError(f"expected CONFIG, got {error.code}") from error
                if "user_model" not in str(error) or "alias<Name>()" not in str(error):
                    raise AssertionError(f"duplicate relation error lacks result name or alias hint: {error}") from error
            else:
                raise AssertionError("duplicate relation result name was accepted")
        finally:
            db.close()


class Cpx5DuplicateRelationTest(CoverageCase):
    # Requirements: CPX-5, DSL-128.
    def test_duplicate_relation_name(self):
        self.each_item("duplicate_relation_name", duplicate_relation_name)


if __name__ == "__main__":
    coverage_main(Cpx5DuplicateRelationTest)
