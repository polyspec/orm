# The AES rotation case of packages/php/tests/ModelTest.php: stale rows are
# re-encrypted with the current key on SQLite, MySQL and PostgreSQL.
# Requirements: COD-8, PLN-44, INT-60, INT-75, INT-131.
# Usage: python -m packages.python.tests.aes_rotation
import tempfile
import unittest

from polyspec.orm.aes import AesKeyring
from .models import models

from . import testcase
from .bench_set import install_bench
from .case_database import case_database

DIALECTS = ("sqlite", "mysql", "postgres")
TEMP = {}


def setUpModule():
    TEMP["dir"] = tempfile.TemporaryDirectory(prefix="orm-aes-rotation-")


def tearDownModule():
    TEMP["dir"].cleanup()


class AesRotationPhysicalTest(unittest.TestCase):
    deadline = testcase.DATABASE

    def test_aes_rotation_on_each_database(self):
        for dialect in DIALECTS:
            with (
                self.subTest(dialect=dialect),
                case_database(dialect, TEMP["dir"].name, "orm_aes_rotation") as dsn,
            ):
                setup = models.connect(dsn)
                try:
                    install_bench(setup)
                finally:
                    setup.close()

                db = models.connect(
                    dsn, aesKey="test-aes-key", blindIndexKey="test-blind-key"
                )
                current = None
                try:
                    service = (
                        models.Service()
                        .connect(db)
                        .set_name("rotation-service")
                        .create()
                    )
                    user = models.User().connect(db).set_name("rotation-user").create()
                    region = (
                        models.ServiceRegion()
                        .connect(db)
                        .set_service_seq(service.get_seq())
                        .set_name("rotation-region")
                        .create()
                    )
                    member = (
                        models.ServiceMember()
                        .connect(db)
                        .set_service_seq(service.get_seq())
                        .set_user_seq(user.get_seq())
                        .create()
                    )
                    authors = []
                    for index, name in enumerate(("alpha", "beta", "gamma", "delta")):
                        author = (
                            models.Author()
                            .connect(db)
                            .set_name(name)
                            .set_user_seq(user.get_seq())
                            .set_service_seq(service.get_seq())
                            .set_service_region_seq(region.get_seq())
                            .set_service_member_seq(member.get_seq())
                            .set_start_dt(f"2026-06-01 0{index}:00:00")
                            .set_end_dt("2026-06-03 00:00:00")
                        )
                        if index == 0:
                            author.set_aes_hex_email("person@example.com")
                            author.set_aes_hex_phone("01012345678")
                        authors.append(author.create())

                    keyring = AesKeyring({1: "test-aes-key", 2: "next-aes-key"}, 2)
                    status = db.utils().aes().status(models.Author(), keyring)
                    self.assertEqual(
                        (status.current, status.total, status.pending, status.versions),
                        (2, 4, 4, {1: 4}),
                        "status",
                    )
                    self.assertEqual(
                        db.utils().aes().rotate(models.Author(), keyring), 4
                    )
                    status = db.utils().aes().status(models.Author(), keyring)
                    self.assertEqual(
                        (status.current, status.total, status.pending, status.versions),
                        (2, 4, 0, {2: 4}),
                        "after rotation",
                    )
                    self.assertEqual(
                        db.utils().aes().rotate(models.Author(), keyring), 0
                    )

                    # COD-8: write with the active key; read with that version alone.
                    versioned = models.connect(
                        dsn,
                        aesVersion=2,
                        aesKeyring=AesKeyring(
                            {1: "test-aes-key", 2: "next-aes-key"}, 2
                        ),
                        blindIndexKey="test-blind-key",
                    )
                    current = models.connect(
                        dsn,
                        aesVersion=2,
                        aesKeyring=AesKeyring({2: "next-aes-key"}, 2),
                        blindIndexKey="test-blind-key",
                    )
                    try:
                        (
                            models.Author()
                            .connect(versioned)
                            .get_by_seq(authors[1].get_seq())
                            .set_aes_hex_email("version-two@example.com")
                            .update()
                        )
                        self.assertEqual(
                            models.Author()
                            .connect(current)
                            .get_by_seq(authors[1].get_seq())
                            .get_aes_hex_email(),
                            "version-two@example.com",
                            "write with the key of aesVersion",
                        )
                    finally:
                        current.close()
                        versioned.close()

                    current = models.connect(
                        dsn,
                        aesVersion=2,
                        aesKeyring=AesKeyring({2: "next-aes-key"}, 2),
                        blindIndexKey="test-blind-key",
                    )
                    rotated = (
                        models.Author()
                        .connect(current)
                        .get_by_seq(authors[0].get_seq())
                    )
                    self.assertEqual(
                        rotated.get_aes_hex_email(),
                        "person@example.com",
                        "rotated email uses only the current key",
                    )
                    self.assertEqual(
                        rotated.get_aes_hex_phone(),
                        "01012345678",
                        "rotated phone uses only the current key",
                    )
                finally:
                    if current is not None:
                        current.close()
                    db.close()


if __name__ == "__main__":
    testcase.main()
