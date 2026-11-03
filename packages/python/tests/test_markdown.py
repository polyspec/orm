# The markdown bind cases of tests/bind/vectors.json (docs/spec/protocol.md §5), and the fake server that records the messages
# of one connection in place of the flowmark server, which the tests of a markdown connection share.
import queue
import socket
import threading
import math
import unittest


from polyspec.orm.errors import OrmError
from . import testcase

TOKEN = "0123456789abcdef0123456789abcdef"


class MarkdownTestServer:
    """Receives and records the messages of one connection instead of the flowmark server, and writes the script's replies in order."""

    def __init__(self, test: unittest.TestCase, *answers: str):
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(1)
        self._received_messages: queue.Queue = queue.Queue(1)
        self.thread = threading.Thread(target=self._serve, args=(answers,), daemon=True)
        self.thread.start()
        test.addCleanup(self.close)

    def _serve(self, answers) -> None:
        got: list = []
        try:
            conn, _ = self.listener.accept()
        except OSError:
            self._received_messages.put(None)
            return
        with conn, conn.makefile("rwb") as stream:
            for answer in answers:
                line = stream.readline()
                if not line:
                    break
                got.append(line.decode("utf-8").rstrip("\n"))
                stream.write(answer.encode("utf-8") + b"\n")
                stream.flush()
        self._received_messages.put(got)

    def dsn(self) -> str:
        host, port = self.listener.getsockname()
        return f"markdown://{host}:{port}/tracker?token={TOKEN}"

    def received_messages(self) -> list:
        # Deadline of one case: if the fake server does not finish the script, the case fails.
        return self._received_messages.get(timeout=10)

    def close(self) -> None:
        self.listener.close()
        self.thread.join(10)


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
        # Requirements: PRT-67, DIA-31.
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
