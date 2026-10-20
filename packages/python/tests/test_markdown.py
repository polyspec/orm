# The markdown IR executor's DSN, connect and control messages, error lines, and the surfaces it rejects (docs/spec/protocol.md §5,
# docs/spec/dialects.md "Markdown IR executor"). Uses a fake server that records the messages of one connection instead of the flowmark server.
import queue
import socket
import threading
import math
import unittest


from polyspec.orm.database import Db, parse_dsn  # noqa: E402
from polyspec.orm.errors import OrmError  # noqa: E402
from polyspec.orm.markdown import MarkdownDsn  # noqa: E402
from . import testcase

TOKEN = "0123456789abcdef0123456789abcdef"
CONNECT_LINE = (
    '{"op":"connect","corpus":"tracker","token":"0123456789abcdef0123456789abcdef"}'
)


class FakeServer:
    """Receives and records the messages of one connection instead of the flowmark server, and writes the script's replies in order."""

    def __init__(self, test: unittest.TestCase, *answers: str):
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(1)
        self.received: queue.Queue = queue.Queue(1)
        self.thread = threading.Thread(target=self._serve, args=(answers,), daemon=True)
        self.thread.start()
        test.addCleanup(self.close)

    def _serve(self, answers) -> None:
        got: list = []
        try:
            conn, _ = self.listener.accept()
        except OSError:
            self.received.put(None)
            return
        with conn, conn.makefile("rwb") as stream:
            for answer in answers:
                line = stream.readline()
                if not line:
                    break
                got.append(line.decode("utf-8").rstrip("\n"))
                stream.write(answer.encode("utf-8") + b"\n")
                stream.flush()
        self.received.put(got)

    def dsn(self) -> str:
        host, port = self.listener.getsockname()
        return f"markdown://{host}:{port}/tracker?token={TOKEN}"

    def messages(self) -> list:
        # Deadline of one case: if the fake server does not finish the script, the case fails.
        return self.received.get(timeout=10)

    def close(self) -> None:
        self.listener.close()
        self.thread.join(10)


def raised(run):
    try:
        run()
    except BaseException as error:  # noqa: BLE001
        return error
    return None


class MarkdownTest(unittest.TestCase):
    def test_parse_markdown_dsn(self):
        # Requirements: PRT-63.
        parsed = parse_dsn(f"markdown://127.0.0.1:4100/tracker?token={TOKEN}")
        self.assertEqual(parsed.driver, "markdown")
        self.assertEqual(parsed.zone, "+00:00")
        self.assertEqual(
            parsed.markdown, MarkdownDsn("127.0.0.1:4100", "tracker", TOKEN)
        )
        for dsn in (
            "markdown://127.0.0.1:4100/tracker",
            "markdown://127.0.0.1:4100/tracker?token=",
            "markdown://127.0.0.1:4100/tracker?token=a&token=b",
            "markdown://127.0.0.1:4100/tracker?token=a&mode=ro",
            "markdown://127.0.0.1/tracker?token=a",
            "markdown://127.0.0.1:0/tracker?token=a",
            "markdown://127.0.0.1:port/tracker?token=a",
            "markdown://localhost:4100/tracker?token=a",
            "markdown://10.0.0.1:4100/tracker?token=a",
            "markdown://user@127.0.0.1:4100/tracker?token=a",
            "markdown://127.0.0.1:4100/?token=a",
            "markdown://127.0.0.1:4100/a/b?token=a",
        ):
            error = raised(lambda: parse_dsn(dsn))
            self.assertIsInstance(error, OrmError, dsn)
            self.assertEqual(error.code, "CONFIG", f"{dsn}: {error}")

    def test_markdown_session_messages(self):
        # Requirements: PRT-64.
        server = FakeServer(
            self,
            '{"ok":true}',
            '{"ok":true}',
            '{"ok":true}',
            '{"ok":true}',
            '{"ok":true}',
            '{"ok":true}',
            '{"error":{"code":"WRITE_CONFLICT","message":"people.flowmark.md:3 changed since it '
            'was read"}}',
        )
        db = Db.connect(server.dsn())
        self.addCleanup(db.close)
        db.transaction(lambda: db.transaction(lambda: None), {"readOnly": True})
        error = raised(lambda: db.transaction(lambda: None))
        self.assertIsInstance(error, OrmError)
        self.assertEqual(error.code, "WRITE_CONFLICT")
        self.assertEqual(
            str(error), "WRITE_CONFLICT: people.flowmark.md:3 changed since it was read"
        )
        db.close()
        self.assertEqual(
            server.messages(),
            [
                CONNECT_LINE,
                '{"op":"begin","read_only":true}',
                '{"op":"savepoint","name":"orm_sp_1"}',
                '{"op":"release","name":"orm_sp_1"}',
                '{"op":"commit"}',
                '{"op":"begin"}',
                '{"op":"commit"}',
            ],
        )

    def test_markdown_connect_refused(self):
        # Requirements: PRT-64.
        server = FakeServer(
            self,
            '{"error":{"code":"CONFIG","message":"connect: the token is not the corpus\'s '
            'token"}}',
        )
        error = raised(lambda: Db.connect(server.dsn()).close())
        self.assertIsInstance(error, OrmError)
        self.assertEqual(error.code, "CONFIG")
        self.assertEqual(
            str(error), "CONFIG: connect: the token is not the corpus's token"
        )
        self.assertEqual(server.messages(), [CONNECT_LINE])

    def test_markdown_rejected_surfaces(self):
        server = FakeServer(self, '{"ok":true}')
        db = Db.connect(server.dsn())
        self.addCleanup(db.close)
        for name, run in {
            "isolation": lambda: db.transaction(
                lambda: None, {"isolation": "serializable"}
            ),
            "timeoutMs": lambda: db.transaction(lambda: None, {"timeoutMs": 100}),
            "lock": lambda: db.utils().lock("k"),
            "setLocal": lambda: db.utils().set_local("k", "v"),
            "subscribe": lambda: db.subscribe(lambda event: None),
        }.items():
            error = raised(run)
            self.assertIsInstance(error, OrmError, name)
            self.assertEqual(error.code, "CAPABILITY_UNSUPPORTED", f"{name}: {error}")


class BindMessageVectors(unittest.TestCase):
    """Message case of tests/bind/vectors.json: the runtime value model JSON of an IR executor message parameter
    (docs/spec/protocol.md §5 "Parameters"). It is the same case as Go's TestBindMessageVectors."""

    def test_message_cases(self):
        # Requirements: PRT-67.
        import json
        import pathlib
        import types

        from polyspec.orm.engine.params import ParamUse
        from polyspec.orm.markdown import begin_message, markdown_param

        root = pathlib.Path(__file__).resolve().parents[3]
        vectors = json.loads((root / "tests/bind/vectors.json").read_text())
        self.assertTrue(
            vectors.get("control"), "tests/bind/vectors.json has no control cases"
        )
        for case in vectors["control"]:
            with self.subTest("control/" + case["name"]):
                self.assertEqual(begin_message(case["read_only"]), case["json"])
        db = types.SimpleNamespace(zone=vectors["zone"], aes_key="")
        for case in vectors["message"]:
            with self.subTest(case["name"]):
                uses = [ParamUse(case["type"])]
                if "code" in case:
                    with self.assertRaises(OrmError) as caught:
                        markdown_param(db, 0, case["value"], uses)
                    self.assertEqual(caught.exception.code, case["code"])
                else:
                    self.assertEqual(
                        markdown_param(db, 0, case["value"], uses), case["json"]
                    )


def vector_value(value):
    """A value of a bind case as the host value a Python program passes: {"int": text} an int, {"f64": text} a
    non-finite float, {"bytes": base64} bytes."""
    import base64

    if not isinstance(value, dict):
        return value
    if "native" in value:
        # A native value of the tagged kind: the host object a Python program passes for it.
        import datetime

        return {
            "date": datetime.date(2024, 1, 2),
            "time": datetime.time(10, 0, 0),
            "datetime": datetime.datetime(2024, 1, 2, 3, 4, 5),
        }[value["native"]]
    if "int" in value:
        return int(value["int"])
    if "f64" in value:
        return {"NaN": math.nan, "Infinity": math.inf, "-Infinity": -math.inf}[
            value["f64"]
        ]
    if "bytes" in value:
        return base64.b64decode(value["bytes"])
    raise AssertionError(f"value {value!r} has no host form")


class BindVectors(unittest.TestCase):
    """Bind case of tests/bind/vectors.json: checks the parameter value against the logical type of its slot (docs/spec/protocol.md §5
    "Parameters"). It is the same case as Go's TestBindVectors."""

    def test_bind_cases(self):
        import json
        import pathlib

        from polyspec.orm.bind_check import (
            ParamSlot,
            check_assign,
            check_param,
            transform_param,
        )

        root = pathlib.Path(__file__).resolve().parents[3]
        vectors = json.loads((root / "tests/bind/vectors.json").read_text())
        for case in vectors["bind"]:
            with self.subTest(case["name"]):
                slot = ParamSlot(
                    case["slot"]["type"],
                    case["slot"].get("precision", 0),
                    case["slot"].get("scale", 0),
                    case["slot"].get("length", 0),
                )
                value = vector_value(case["value"])
                transform = case["slot"].get("transform")

                def bind(value=value, slot=slot, transform=transform):
                    if transform:
                        return transform_param(transform, value)
                    check_assign(
                        0,
                        value,
                        ParamSlot(
                            slot.type,
                            not_null=bool(case["slot"].get("not_null")),
                            column="column",
                        ),
                    )
                    check_param(0, value, slot, vectors["zone"])
                    return value

                if "code" in case:
                    with self.assertRaises(OrmError) as caught:
                        bind()
                    self.assertEqual(caught.exception.code, case["code"])
                else:
                    self.assertEqual(bind(), vector_value(case["bound"]))


if __name__ == "__main__":
    testcase.main()
