# The chain runner of the ir.answer steps of a recipe (docs/spec/protocol.md section 5, Read): a step runs the chain of the
# markdown conformance case it names on a connection whose listener answers connect with {"ok": true} and the chain's
# requests with the step's answer, or, for answers, each control message by its op and each request by its kind. No
# flowmark server runs, and the models are generated once for the class that runs the steps (see recipe.ChainRecipeCase).
import json
import shutil
import socket
import tempfile
import threading
from pathlib import Path
from typing import Any

from polyspec.orm import OrmError

from .markdown_conformance import CONFORMANCE_DIR, ROOT, Served, conformance_cases
from .test_sqlite import generate

TOKEN = "0123456789abcdef0123456789abcdef"
STATE: dict = {}


def listen_markdown_test_server():
    """A listener on a free loopback port that takes one connection."""
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    return listener


def accept_markdown_test_connection(listener):
    """The one connection of listener, or None when listener closes before one arrives."""
    try:
        conn, _ = listener.accept()
    except OSError:
        return None
    return conn


def start_markdown_test_server_with_answer(answer: str, sent: list):
    """A listener that answers connect with {"ok": true} and the next message with answer. The request line is appended
    to sent, so that a params expect reads the request the chain sends."""
    listener = listen_markdown_test_server()

    def serve():
        conn = accept_markdown_test_connection(listener)
        if conn is None:
            return
        with conn, conn.makefile("rb") as lines:
            for index, reply in enumerate(('{"ok":true}', answer)):
                line = lines.readline()
                if not line:
                    return
                if index == 1:
                    sent.append(line.decode())
                conn.sendall(reply.encode() + b"\n")
            lines.readline()

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    return listener, thread


def start_markdown_test_server_with_keyed_answers(answers: dict):
    """A listener that answers connect with {"ok": true} and every later message with the answer of answers
    keyed by the op of a control message or the kind of a request; a message without an answer is IR_INVALID."""
    listener = listen_markdown_test_server()

    def serve():
        conn = accept_markdown_test_connection(listener)
        if conn is None:
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
                    try:
                        message = json.loads(line)
                        key = (
                            message.get("op")
                            or message.get("request", {}).get("kind")
                            or "unreadable"
                        )
                    except ValueError:
                        # A line that is not JSON has no op or kind; it is answered as "unreadable", which has no answer, so IR_INVALID.
                        key = "unreadable"
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


def prepare() -> None:
    """Generates the models of the conformance corpus and loads the chain functions. Release undoes it."""
    STATE["workdir"] = Path(tempfile.mkdtemp(prefix="orm-ir-answers-"))
    try:
        STATE["models"] = generate(
            str(STATE["workdir"] / "models"),
            CONFORMANCE_DIR / "corpus" / "dbspec" / "dbspec-set.json",
        )
        STATE["bind_models"] = generate(
            str(STATE["workdir"] / "bind_models"),
            ROOT / "tests" / "bind" / "dbspec-set.json",
        )
        STATE["funcs"] = conformance_cases()
    except BaseException:
        release()
        raise


def release() -> None:
    shutil.rmtree(STATE.pop("workdir", Path()), ignore_errors=True)
    STATE.clear()


def _bind_run(bind: dict):
    """The chain of a bind step (T334-3-15-3c, PRT-67): it writes the bind value into the slot column of the bind models through
    its setter and sends the insert, so the request carries the wire value of the slot."""
    setter = f"set_{bind['column'].split('_')[0]}_value"

    def run(s):
        row = STATE["bind_models"].Slots().connect(s.db)
        getattr(row, setter)(bind["value"])
        row.create()
        return None

    return run


def run_chain(name: str, step: dict) -> tuple[Any, list, bool]:
    """Runs the chain name on a listener that answers step, and returns its result as JSON, the request lines the listener
    received after its connect, and whether the chain failed with an orm error, which is the result {"error": CODE}.
    Any other exception of the chain propagates, which fails the case. A step with a bind field runs the slot chain on the
    bind models instead (T334-3-15-3c)."""
    bind = step.get("bind")
    if bind is not None:
        if name != "slot":
            raise AssertionError(f"a bind step names the chain slot, not {name}")
        run, models = _bind_run(bind), STATE["bind_models"]
    else:
        run, models = STATE["funcs"].get(name), STATE["models"]
    if run is None:
        raise AssertionError(f"chain {name} is no markdown conformance case")
    sent: list = []
    failed = False
    if "answers" in step:
        listener, thread = start_markdown_test_server_with_keyed_answers(
            step["answers"]
        )
    else:
        listener, thread = start_markdown_test_server_with_answer(
            json.dumps(step["answer"]), sent
        )
    port = listener.getsockname()[1]
    s = Served(models, STATE["workdir"], str(port), TOKEN)
    s.db = models.connect(s.dsn("conformance", TOKEN))
    try:
        try:
            got = run(s)
        except OrmError as error:
            got = {"error": error.code}
            failed = True
    finally:
        s.db.close()
        listener.close()
        thread.join(5)
    return json.loads(json.dumps(got)), sent, failed
