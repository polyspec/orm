# The client of a flowmark server that serves markdown:// connections (docs/spec/protocol.md §5 "Markdown connections",
# docs/spec/dialects.md "Markdown"). A flowmark server runs a statement of SQL in SQLite's dialect on the corpus (DIA-185),
# so a markdown connection is a SQLite connection whose statements the server answers: the connection below sends each
# statement in a statement message and reads its answer as sqlite3 reads a row. The rules are the same as the Go client's
# markdown.go and markdown_sql.go.
from __future__ import annotations

import base64
import json
import math
import re
import socket
from dataclasses import dataclass, field
from urllib.parse import parse_qsl

from polyspec.orm import codes
from polyspec.orm.errors import OrmError

__all__ = ["MarkdownDsn", "parse_markdown_dsn"]

_FORM = "markdown DSN is markdown://127.0.0.1:<port>/<corpus>?token=<token>"
_PRAGMA = re.compile(r"([a-z_]+)\(([A-Za-z0-9_]+)\)")


@dataclass(frozen=True)
class MarkdownDsn:
    """The flowmark server address, corpus name, and token of a markdown:// DSN. pragmas are the _pragma values of the
    DSN, name and value, which each session states first, as on a SQLite DSN."""

    address: str
    corpus: str
    token: str
    pragmas: tuple = field(default=())


def parse_markdown_dsn(url) -> MarkdownDsn:
    """Reads markdown://127.0.0.1:<port>/<corpus>?token=<token>. The flowmark server listens only on 127.0.0.1, and
    the token travels in plain text, so the host is only 127.0.0.1."""
    if url.username is not None or url.password is not None:
        raise OrmError(codes.CONFIG, f"{_FORM}; it takes no user")
    if url.hostname != "127.0.0.1":
        raise OrmError(
            codes.CONFIG,
            f"{_FORM}; host {url.hostname!r}: a flowmark server listens on 127.0.0.1 only",
        )
    try:
        port = url.port
    except ValueError:
        port = None
    if port is None or not 1 <= port <= 65535:
        given = url.netloc.rpartition(":")[2] if ":" in url.netloc else ""
        raise OrmError(
            codes.CONFIG,
            f"{_FORM}; port {given!r} is not 1 to 65535: give the port that flowmark serve "
            f"printed",
        )
    corpus = url.path[1:] if url.path.startswith("/") else url.path
    if corpus == "" or "/" in corpus:
        raise OrmError(
            codes.CONFIG,
            f"{_FORM}; the path {url.path!r} is not one corpus name: give the corpus root's "
            f"directory name",
        )
    parameters = parse_qsl(url.query, keep_blank_values=True)
    for name, _ in parameters:
        # timezone is the rule of every scheme, which parse_dsn has already checked (a corpus keeps datetime in UTC).
        if name not in ("token", "timezone", "_pragma"):
            raise OrmError(codes.CONFIG, f"{_FORM}; it does not accept {name}")
    tokens = [value for name, value in parameters if name == "token"]
    if len(tokens) != 1 or tokens[0] == "":
        raise OrmError(
            codes.CONFIG,
            f"{_FORM}; give one token, the token of .flowmark/server.json of the corpus",
        )
    pragmas = []
    for name, value in parameters:
        if name != "_pragma":
            continue
        match = _PRAGMA.fullmatch(value)
        if match is None or (
            match.group(1) == "busy_timeout" and not match.group(2).isdigit()
        ):
            raise OrmError(codes.CONFIG, f"{_FORM}; _pragma {value} is invalid")
        pragmas.append((match.group(1), match.group(2)))
    return MarkdownDsn(f"127.0.0.1:{port}", corpus, tokens[0], tuple(pragmas))


def _plain(value) -> str:
    """The JSON form of a value on one line. Non-ASCII characters are not escaped, so the value passes through as is."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


class MarkdownServerError(Exception):
    """The refusal the flowmark server answered, as the cause a SQLite driver's error is: sqlite_errorcode is the SQLite
    result code it states, since the statements of a flowmark connection are in SQLite's dialect (PRT-71)."""

    def __init__(self, code: str, message: str, result_code: int | None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.sqlite_errorcode = result_code


class MarkdownSession:
    """One connection to the flowmark server, that is, one server session."""

    def __init__(self, sock: socket.socket):
        self.sock = sock
        self.stream = sock.makefile("rwb")
        # broken means the connection can no longer be used: a read or write failed, or the server said it ends the connection.
        self.broken = False

    def close(self) -> None:
        self.broken = True
        try:
            self.stream.close()
        finally:
            self.sock.close()

    def call(self, msg: dict) -> dict:
        """Sends one message as one line and reads one line of reply. If the reply is {"error": {code, message}}, it is
        the error with that code, whose cause holds the SQLite result code the server states."""
        if self.broken:
            raise OrmError(codes.CONNECTION_LOST, "the flowmark session has ended")
        try:
            line = _plain(msg)
        except (TypeError, ValueError) as error:
            raise OrmError(
                codes.INTERNAL, f"writing the message: {error}", error
            ) from None
        try:
            answer = self.exchange(line.encode("utf-8") + b"\n")
        except (OSError, ValueError) as error:
            self.close()
            raise OrmError(
                codes.CONNECTION_LOST,
                f"the flowmark server connection broke: {error}",
                error,
            ) from None
        try:
            probe = json.loads(answer)
        except ValueError:
            probe = None
        if not isinstance(probe, dict):
            self.close()
            raise OrmError(
                codes.INTERNAL,
                f"the flowmark server answered {answer!r}, not a JSON object",
            )
        if "error" in probe:
            e = probe["error"]
            if (
                not isinstance(e, dict)
                or not isinstance(e.get("code"), str)
                or e["code"] == ""
            ):
                self.close()
                raise OrmError(
                    codes.INTERNAL,
                    f"the flowmark server answered the error {_plain(e)} without a code",
                )
            # The server writes CONNECTION_LOST and then closes the connection (idle transaction).
            if e["code"] == codes.CONNECTION_LOST:
                self.close()
            message = e.get("message")
            text = message if isinstance(message, str) else ""
            result = e.get("result_code")
            if isinstance(result, bool) or not isinstance(result, int):
                result = None
            cause = MarkdownServerError(e["code"], text, result)
            raise OrmError(e["code"], text, cause) from cause
        return probe

    def exchange(self, line: bytes) -> bytes:
        self.stream.write(line)
        self.stream.flush()
        answer = self.stream.readline()
        if not answer.endswith(b"\n"):
            raise OSError("the server closed the connection")
        return answer[:-1]

    def statement(self, sql: str, values, text=None) -> dict:
        """Runs one statement in the session (PRT-65) and returns its answer, its rows read as sqlite3 reads them; text
        reads the bytes of a text that is not UTF-8, as the text_factory of a sqlite3 connection does."""
        answer = self.call(
            {
                "op": "statement",
                "sql": sql,
                "params": [statement_param(value) for value in values],
            }
        )
        return _read_answer("statement", answer, None, text)

    def fetch(self, columns: list, text=None) -> dict:
        """The rows that go on after an answer whose more is true, which the server holds until a fetch reads the last
        of them (PRT-66)."""
        return _read_answer("fetch", self.call({"op": "fetch"}), columns, text)


def dial_markdown(dsn: MarkdownDsn) -> MarkdownSession:
    """Connects to the server and sends connect as the first message, carrying the corpus and token."""
    host, _, port = dsn.address.rpartition(":")
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.connect((host, int(port)))
    except OSError as error:
        sock.close()
        raise OrmError(
            codes.DRIVER,
            f"connecting to the flowmark server {dsn.address}: {error}; start flowmark serve "
            f"for the corpus",
            error,
        ) from None
    s = MarkdownSession(sock)
    try:
        s.call({"op": "connect", "corpus": dsn.corpus, "token": dsn.token})
    except BaseException:
        s.close()
        raise
    return s


def statement_param(value):
    """The wire form of a bound value (PRT-67): a JSON value, and the form that an answer writes for a value that JSON
    cannot hold: {"bytes": base64} for bytes, {"text": base64} for a text that is not UTF-8 and {"float": "+Inf"} or
    {"float": "-Inf"} for an infinity. A boolean binds as 1 or 0, as sqlite3 binds it."""
    if value is None:
        return None
    if isinstance(value, str):
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            raw = value.encode("utf-8", "surrogatepass")
            return {"text": base64.b64encode(raw).decode("ascii")}
        return value
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if math.isnan(value):
            raise OrmError(
                codes.CONFIG, "a statement parameter of NaN has no JSON form"
            )
        if math.isinf(value):
            return {"float": "+Inf" if value > 0 else "-Inf"}
        return value
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"bytes": base64.b64encode(bytes(value)).decode("ascii")}
    raise OrmError(
        codes.CONFIG,
        f"a statement parameter of {type(value).__name__} has no form on a SQLite connection",
    )


def _answer_error(what: str, raw) -> OrmError:
    return OrmError(codes.INTERNAL, f"the answer of a {what}: {_plain(raw)}")


def _base64(text: str, what: str, raw) -> bytes:
    try:
        return base64.b64decode(text, validate=True)
    except ValueError:
        # binascii.Error, the error of a text that is no base64, is a ValueError.
        raise _answer_error(what, raw) from None


def _replaced(data: bytes) -> str:
    """A text that is not UTF-8, each invalid sequence a replacement character."""
    return data.decode("utf-8", "replace")


def statement_cell(raw, what: str = "statement", text=None):
    """Reads one cell of an answer as sqlite3 reads it on a SQLite connection: an integer as an int, a fraction as a
    float, a text as a str, a blob as bytes, or None. text reads the bytes of a text that is not UTF-8."""
    if raw is None or isinstance(raw, str):
        return raw
    if isinstance(raw, bool):
        raise _answer_error(what, raw)
    if isinstance(raw, (int, float)):
        return raw
    if isinstance(raw, dict) and len(raw) == 1:
        if raw.get("float") in ("+Inf", "-Inf"):
            return math.inf if raw["float"] == "+Inf" else -math.inf
        if isinstance(raw.get("text"), str):
            return (text or _replaced)(_base64(raw["text"], what, raw))
        if isinstance(raw.get("bytes"), str):
            return _base64(raw["bytes"], what, raw)
    raise _answer_error(what, raw)


def _read_answer(what: str, answer: dict, columns: list | None, text=None) -> dict:
    """Reads a statement or fetch answer; columns holds the column names of the statement for a fetch, whose answer
    names none."""
    rows = answer.get("rows", [])
    if not isinstance(rows, list) or not all(isinstance(row, list) for row in rows):
        raise _answer_error(what, answer)
    numbers = {}
    for name in ("affected", "last_insert_id"):
        value = answer.get(name, 0)
        if isinstance(value, bool) or not isinstance(value, int):
            raise _answer_error(what, answer)
        numbers[name] = value
    more = answer.get("more", False)
    if not isinstance(more, bool):
        raise _answer_error(what, answer)
    if columns is None:
        listed = answer.get("columns", [])
        if not isinstance(listed, list):
            raise _answer_error(what, answer)
        columns = []
        for column in listed:
            if not isinstance(column, dict) or not isinstance(column.get("name"), str):
                raise _answer_error(what, answer)
            columns.append(column["name"])
    return {
        "columns": columns,
        "rows": [[statement_cell(cell, what, text) for cell in row] for row in rows],
        "affected": numbers["affected"],
        "last_insert_id": numbers["last_insert_id"],
        "more": more,
    }


class MarkdownCursor:
    """A cursor of a flowmark session, the methods of a sqlite3 cursor that a catalog session calls: it reads the rows of
    a statement batch by batch and closes the rows the server still holds when it stops early (PRT-66)."""

    def __init__(self, connection: "MarkdownDbapi"):
        self._connection = connection
        self._answer: dict | None = None
        self._next = 0
        self.description = None
        self.rowcount = -1
        self.lastrowid = None

    def execute(self, sql: str, args=()):
        self._end()
        session = self._connection.session
        answer = session.statement(sql, list(args), self._connection.text_factory)
        self._connection.track(sql)
        self._answer, self._next = answer, 0
        self.description = (
            [(name, None, None, None, None, None, None) for name in answer["columns"]]
            if answer["columns"]
            else None
        )
        self.rowcount = answer["affected"]
        self.lastrowid = answer["last_insert_id"]
        return self

    def fetchone(self):
        answer = self._answer
        if answer is None:
            return None
        while self._next == len(answer["rows"]):
            if not answer["more"]:
                return None
            answer["more"] = False
            batch = self._connection.session.fetch(
                answer["columns"], self._connection.text_factory
            )
            answer["rows"], answer["more"], self._next = batch["rows"], batch["more"], 0
        row = answer["rows"][self._next]
        self._next += 1
        return tuple(row)

    def fetchall(self) -> list:
        rows = []
        for row in iter(self.fetchone, None):
            rows.append(row)
        return rows

    def _end(self) -> None:
        """Ends the rows the server still holds."""
        answer, self._answer = self._answer, None
        if answer is not None and answer["more"]:
            answer["more"] = False
            self._connection.session.call({"op": "close"})

    def close(self) -> None:
        self._end()


class MarkdownDbapi:
    """A flowmark session as the sqlite3 connection that a catalog session holds: cursor, text_factory and
    in_transaction. in_transaction is the state of the transaction statements the session ran: BEGIN opens it, and
    COMMIT and ROLLBACK end it."""

    def __init__(self, session: MarkdownSession):
        self.session = session
        self.text_factory = None
        self.in_transaction = False

    def cursor(self) -> MarkdownCursor:
        return MarkdownCursor(self)

    def track(self, sql: str) -> None:
        word = sql.lstrip().split(None, 2)
        head = word[0].upper() if word else ""
        if head == "BEGIN":
            self.in_transaction = True
        elif head in ("COMMIT", "END") or (
            head == "ROLLBACK" and (len(word) == 1 or word[1].upper() != "TO")
        ):
            self.in_transaction = False


class MarkdownConnection:
    """One flowmark session as a connection of the pool: the statements of the SQLite dialect run on it, so the
    connection is a SQLite connection to every surface of the Db (PRT-72). connection is the session as a sqlite3
    connection, which a catalog session reads."""

    def __init__(self, dsn: MarkdownDsn):
        self.session = dial_markdown(dsn)
        try:
            for name, value in dsn.pragmas:
                self.session.statement(f"PRAGMA {name} = {value}", [])
        except BaseException:
            self.session.close()
            raise
        self.connection = MarkdownDbapi(self.session)

    def execute(self, sql: str, values):
        """Runs one statement and reads all its rows, fetching the batches that go on."""
        answer = self.session.statement(sql, list(values))
        rows = answer["rows"]
        last = answer
        while last["more"]:
            last = self.session.fetch(answer["columns"])
            rows.extend(last["rows"])
        return {
            "rows": rows,
            "insert_id": answer["last_insert_id"],
            "affected": answer["affected"],
        }

    def in_transaction(self) -> bool | None:
        """None: a flowmark session keeps its transaction open after a failed statement, so the client has no rollback
        of its own to learn of, and the state after a failed COMMIT is unknown (PRT-71)."""
        return None

    def is_alive(self) -> bool:
        return not self.session.broken

    def cancel_query(self) -> None:
        """Cuts the connection: the call that waits is CANCELED, and the server rolls back the transaction of the closed
        connection and releases its locks (PRT-71)."""
        self.session.broken = True
        self.session.sock.shutdown(socket.SHUT_RDWR)

    def close(self) -> None:
        self.session.close()
