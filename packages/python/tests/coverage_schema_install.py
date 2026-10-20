# schema_install coverage: the install of the bench manifest, which is installed already, changes nothing; the install of
# a document set whose tables are only partly present is refused with CONFIG and creates no missing table; the install
# of a set that uses an external table checks that table in the database, as the schema_install coverage of Go, PHP,
# TypeScript and Rust does.
from polyspec.orm import Db
from polyspec.orm.engine import model_of_documents, parse_document_set
from polyspec.orm.errors import OrmError
from polyspec.orm.models import models
from polyspec.orm.schema import Schema
from .coverage_case import expect_equal, CoverageCase, coverage_main, table_exists

PARTIAL = """dbspec 1 partial

table user {
  seq i64 identity
  name varchar(191)
  primary key (seq)
}

table coverage_install_missing {
  seq i64 identity
  primary key (seq)
}
"""

# The external document of a set that uses the table user of the bench database.
EXTERNAL_USER = """dbspec 1 bench_user

table user {
  seq i64 identity
  name varchar(191)
  primary key (seq)
}
"""

# A document set that uses user of EXTERNAL_USER and owns only coverage_external_post.
EXTERNAL_MEMBER = """dbspec 1 coverage_external

use bench_user { user }

table coverage_external_post {
  seq i64 identity
  user_seq i64
  primary key (seq)
  index ix_coverage_external_post_user (user_seq)
  foreign key fk_coverage_external_post_user (user_seq) references user (seq)
}
"""


def schema_of(texts, external_texts=()) -> Schema:
    """The generated schema value of a document set: its manifest text, manifest hash and external text."""
    model = model_of_documents(parse_document_set(texts, external_texts))
    return Schema(
        manifest_text=model.manifest_text,
        manifest_hash=model.manifest_hash,
        external_text=model.external_text,
    )


def install_error(db, schema):
    try:
        db.utils().schema().install(schema)
    except OrmError as error:
        return error
    return None


def with_database(item, body):
    """Opens the selected database and runs the case on it."""
    driver, dsn = item
    db = models.connect(dsn, aesKey="bench-salt", blindIndexKey="bench-blind-index")
    try:
        expect_equal(db.driver, driver, "the driver")
        body(db, driver, dsn)
    finally:
        db.close()


def schema_install_existing(item):
    def body(db, driver, dsn):
        db.utils().schema().install(models.SCHEMA)
        expect_equal(
            models.Author().connect(db).get_count(),
            100000,
            "the installed tables keep their rows",
        )

    with_database(item, body)


def schema_install_partial(item):
    def body(db, driver, dsn):
        expect_equal(
            table_exists(driver, dsn, "coverage_install_missing"),
            False,
            "coverage_install_missing before the case",
        )
        error = install_error(db, schema_of([PARTIAL]))
        expect_equal(
            error.code if error else None,
            "CONFIG",
            f"install of a partly present document set: {error}",
        )
        expect_equal(
            table_exists(driver, dsn, "coverage_install_missing"),
            False,
            "the missing table was created",
        )

    with_database(item, body)


# The install of a set that uses an external document checks the external table in the database. A column of the
# external document that the database lacks makes install CONFIG, and it creates no owned table. Registering reads no
# database, so a connection with that set opens.
def schema_install_external_documents(item):
    def body(db, driver, dsn):
        Db.connect_schema(dsn, schema_of([EXTERNAL_MEMBER], [EXTERNAL_USER])).close()
        drifted = schema_of(
            [EXTERNAL_MEMBER],
            [
                EXTERNAL_USER.replace(
                    "  name varchar(191)\n",
                    "  name varchar(191)\n  coverage_missing varchar(8) null\n",
                )
            ],
        )
        Db.connect_schema(dsn, drifted).close()
        want = (
            "the tables that the set uses from external documents differ from the database: "
            "column user.coverage_missing does not exist"
        )
        error = install_error(db, drifted)
        if error is None or error.code != "CONFIG" or want not in str(error):
            raise AssertionError(f"install with a drifted external table: {error}")
        expect_equal(
            table_exists(driver, dsn, "coverage_external_post"),
            False,
            "the rejected install created a table",
        )

    with_database(item, body)


class CoverageTest(CoverageCase):
    # Requirements: SCH-7, DBS-108.
    def test_schema_install_existing(self):
        self.each_item("schema_install_existing", schema_install_existing)

    # Requirements: SCH-7, SCH-10, DBS-108.
    def test_schema_install_partial(self):
        self.each_item("schema_install_partial", schema_install_partial)

    # Requirements: SCH-7, SCH-11, DBS-107.
    def test_schema_install_external_documents(self):
        self.each_item(
            "schema_install_external_documents", schema_install_external_documents
        )


if __name__ == "__main__":
    coverage_main(CoverageTest)
