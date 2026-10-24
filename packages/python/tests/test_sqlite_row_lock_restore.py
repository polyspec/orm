import unittest

from polyspec.orm import codes
from polyspec.orm.database import Db
from polyspec.orm.errors import OrmError


class Stop(BaseException):
    pass


class Frame:
    def __init__(self, primary=None, set_zero=None, restore=None):
        self.primary = primary
        self.set_zero = set_zero
        self.restore = restore
        self.calls = []

    def run(
        self, sql, values=None, kind="utility", binds=None, tables=(), faultable=True
    ):
        self.calls.append(sql)
        if sql == "PRAGMA busy_timeout":
            return {"rows": [[375]]}
        if sql == "PRAGMA busy_timeout=0" and self.set_zero is not None:
            raise self.set_zero
        if sql == "PRAGMA busy_timeout=375" and self.restore is not None:
            raise self.restore
        if sql.startswith("INSERT") and self.primary is not None:
            raise self.primary
        return {"rows": []}


class SqliteRowLockRestoreTest(unittest.TestCase):
    def test_production_row_lock_preserves_primary_and_restore_outcomes(self):
        db = Db.__new__(Db)
        db.driver = "sqlite"
        busy_cause = type(
            "Busy",
            (),
            {"sqlite_errorcode": 5, "__str__": lambda self: "database is locked"},
        )()
        restore = OrmError(codes.DRIVER, "restore rejected")

        for primary_fails, restore_fails in (
            (False, False),
            (False, True),
            (True, False),
            (True, True),
        ):
            primary = (
                OrmError(codes.DRIVER, "busy", busy_cause) if primary_fails else None
            )
            frame = Frame(primary, restore=restore if restore_fails else None)
            if not primary_fails and not restore_fails:
                db.row_lock(frame, "update_nowait")
            else:
                with self.assertRaises(Exception) as caught:
                    db.row_lock(frame, "update_nowait")
                error = caught.exception
                if primary_fails:
                    self.assertEqual(error.code, codes.LOCK_NOT_AVAILABLE)
                    if restore_fails:
                        self.assertIsInstance(error.cause, ExceptionGroup)
                        self.assertIs(error.cause.exceptions[0].cause, busy_cause)
                        self.assertIs(error.cause.exceptions[1], restore)
                    else:
                        self.assertIs(error.cause, busy_cause)
                else:
                    self.assertIs(error, restore)
            self.assertEqual(frame.calls[0], "PRAGMA busy_timeout")
            self.assertEqual(frame.calls[1], "PRAGMA busy_timeout=0")
            self.assertEqual(frame.calls[-1], "PRAGMA busy_timeout=375")

        busy_setup_cause = type(
            "Busy",
            (),
            {
                "sqlite_errorcode": 5,
                "__str__": lambda self: "busy while setting NOWAIT",
            },
        )()
        setup = OrmError(codes.CANCELED, "setting NOWAIT failed", busy_setup_cause)
        frame = Frame(set_zero=setup, restore=restore)
        with self.assertRaises(OrmError) as caught:
            db.row_lock(frame, "update_nowait")
        self.assertEqual(caught.exception.code, codes.CANCELED)
        self.assertEqual(caught.exception.cause.exceptions, (setup, restore))
        self.assertEqual(
            frame.calls,
            ["PRAGMA busy_timeout", "PRAGMA busy_timeout=0", "PRAGMA busy_timeout=375"],
        )

    def test_production_row_lock_restores_after_base_exception(self):
        db = Db.__new__(Db)
        db.driver = "sqlite"
        stop = Stop("interrupt")
        frame = Frame(set_zero=stop)
        with self.assertRaises(Stop) as caught:
            db.row_lock(frame, "update_nowait")
        self.assertIs(caught.exception, stop)
        self.assertEqual(
            frame.calls,
            ["PRAGMA busy_timeout", "PRAGMA busy_timeout=0", "PRAGMA busy_timeout=375"],
        )

        restore_stop = Stop("restore interrupt")
        frame = Frame(set_zero=stop, restore=restore_stop)
        with self.assertRaises(BaseExceptionGroup) as caught:
            db.row_lock(frame, "update_nowait")
        self.assertIs(caught.exception.exceptions[0], stop)
        self.assertIs(caught.exception.exceptions[1], restore_stop)
        self.assertEqual(
            frame.calls,
            ["PRAGMA busy_timeout", "PRAGMA busy_timeout=0", "PRAGMA busy_timeout=375"],
        )


if __name__ == "__main__":
    from .testcase import main

    main()
