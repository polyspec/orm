# The read answers of an IR executor (docs/spec/protocol.md section 5, Read): each case of
# contracts/fixtures/ir_answers.json runs the chain of the markdown conformance case it names on a
# connection whose listener answers connect with {"ok": true} and the chain's one request with the
# case's answer, and the chain's result equals expect. No flowmark server runs.
import json
import shutil
import socket
import tempfile
import threading
import unittest
from pathlib import Path

from . import testcase
from .markdown_conformance import CONFORMANCE_DIR, Served, conformance_cases, same
from .test_sqlite import generate
from .vector_case import VectorCase, vector_tests

from polyspec.orm import OrmError

ROOT = Path(__file__).resolve().parents[3]
TOKEN = "0123456789abcdef0123456789abcdef"
STATE: dict = {}


def load_cases() -> list:
    return json.loads(
        (ROOT / "contracts" / "fixtures" / "ir_answers.json").read_text()
    )["cases"]


def answering_server(answer: str):
    """A listener that answers connect with {"ok": true} and the next message with answer."""
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)

    def serve():
        try:
            conn, _ = listener.accept()
        except OSError:
            return
        with conn, conn.makefile("rb") as lines:
            for reply in ('{"ok":true}', answer):
                if not lines.readline():
                    return
                conn.sendall(reply.encode() + b"\n")
            lines.readline()

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    return listener, thread


def keyed_server(answers: dict):
    """A listener that answers connect with {"ok": true} and every later message with the answer of answers
    keyed by the op of a control message or the kind of a request; a message without an answer is IR_INVALID."""
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)

    def serve():
        try:
            conn, _ = listener.accept()
        except OSError:
            return
        with conn, conn.makefile("rb") as lines:
            first = True
            while True:
                line = lines.readline()
                if not line:
                    return
                if first:
                    first = False
                    reply = {"ok": True}
                else:
                    key = "unreadable"
                    try:
                        message = json.loads(line)
                        key = (
                            message.get("op")
                            or message.get("request", {}).get("kind")
                            or key
                        )
                    except ValueError:
                        pass
                    reply = answers.get(
                        key,
                        {
                            "error": {
                                "code": "IR_INVALID",
                                "message": f"the case has no answer for {key}",
                            }
                        },
                    )
                try:
                    conn.sendall(json.dumps(reply).encode() + b"\n")
                except OSError:
                    return

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    return listener, thread


def setUpModule():
    STATE["workdir"] = Path(tempfile.mkdtemp(prefix="orm-ir-answers-"))
    STATE["models"] = generate(
        str(STATE["workdir"] / "models"),
        CONFORMANCE_DIR / "corpus" / "dbspec" / "dbspec-set.json",
    )
    STATE["funcs"] = conformance_cases()


def tearDownModule():
    shutil.rmtree(STATE["workdir"], ignore_errors=True)


def check_case(test: unittest.TestCase, case: dict) -> None:
    run = STATE["funcs"].get(case["chain"])
    if run is None:
        test.fail(f"chain {case['chain']} is no markdown conformance case")
    if "answers" in case:
        listener, thread = keyed_server(case["answers"])
    else:
        listener, thread = answering_server(json.dumps(case["answer"]))
    port = listener.getsockname()[1]
    s = Served(STATE["models"], STATE["workdir"], str(port), TOKEN)
    s.db = STATE["models"].connect(s.dsn("conformance", TOKEN))
    try:
        try:
            got = run(s)
        except OrmError as error:
            got = {"error": error.code}
    finally:
        s.db.close()
        listener.close()
        thread.join(5)
    actual = json.loads(json.dumps(got))
    if not same(actual, case["expect"]):
        test.fail(f"got {json.dumps(actual)}, want {json.dumps(case['expect'])}")


class Case(VectorCase):
    """A case of contracts/fixtures/ir_answers.json."""

    deadline = testcase.COMPUTE


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    tests.addTests(vector_tests(Case, load_cases(), check_case))
    return tests


if __name__ == "__main__":
    testcase.main()
