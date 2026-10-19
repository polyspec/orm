# markdown IR executor: a markdown:// DSN connection sends IR requests to the flowmark server and assembles the answer rows into models
# (docs/spec/protocol.md §5 "IR executors", docs/spec/dialects.md "Markdown IR executor"). The rules are the same as the Go client's markdown.go.
# The Python client uses one server connection, as SQL connections do.
from __future__ import annotations

import base64
import json
import socket
from dataclasses import dataclass
from urllib.parse import parse_qsl

from polyspec.orm import codes
from polyspec.orm.engine.model import Entity, RuntimeModel, entity_of, field_of
from polyspec.orm.bind_check import check_assign, check_param, use_slot_type
from polyspec.orm.engine.params import ParamUse, function_type, param_uses
from polyspec.orm.engine.validate import validate
from polyspec.orm.errors import OrmError

__all__ = ["MarkdownDsn", "parse_markdown_dsn"]

_FORM = "markdown DSN is markdown://127.0.0.1:<port>/<corpus>?token=<token>"
# Host stage: the client encodes the values and sends them, as with SQL connections.
_HOST_STAGES = ("aes", "hex", "ip")


@dataclass(frozen=True)
class MarkdownDsn:
    """The flowmark server address, corpus name, and token of a markdown:// DSN."""

    address: str
    corpus: str
    token: str


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
    tokens = [value for name, value in parameters if name == "token"]
    if len(tokens) != 1 or tokens[0] == "":
        raise OrmError(
            codes.CONFIG,
            f"{_FORM}; give one token, the token of .flowmark/server.json of the corpus",
        )
    for name, _ in parameters:
        if name != "token":
            raise OrmError(codes.CONFIG, f"{_FORM}; it does not accept {name}")
    return MarkdownDsn(f"127.0.0.1:{port}", corpus, tokens[0])


def unsupported_on_markdown(db, surface: str) -> None:
    """Raises the error that SQL-only surfaces receive on a markdown connection (docs/spec/dialects.md "Markdown IR executor"). On other
    connections it does nothing."""
    if db.driver == "markdown":
        raise OrmError(
            codes.CAPABILITY_UNSUPPORTED,
            f"{surface} is not supported by the markdown IR executor",
        )


def _plain(value) -> str:
    """The JSON form of a value on one line. Non-ASCII characters are not escaped, so the value passes through as is."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


class MdSession:
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
        """Sends one message as one line and reads one line of reply. If the reply is {"error": {code, message}}, it is the error with that code
        error."""
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
        except OSError as error:
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
            raise OrmError(e["code"], message if isinstance(message, str) else "")
        return probe

    def exchange(self, line: bytes) -> bytes:
        self.stream.write(line)
        self.stream.flush()
        answer = self.stream.readline()
        if not answer.endswith(b"\n"):
            raise OSError("the server closed the connection")
        return answer[:-1]


def dial_markdown(dsn: MarkdownDsn) -> MdSession:
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
    s = MdSession(sock)
    try:
        s.call({"op": "connect", "corpus": dsn.corpus, "token": dsn.token})
    except BaseException:
        s.close()
        raise
    return s


def markdown_model(db, manifest_hash: str) -> RuntimeModel:
    """The runtime model of the schema registered on this connection. A manifest that is not registered gives
    SCHEMA_HASH_MISMATCH, as with SQL connections."""
    model = db.schemas.get(manifest_hash)
    if model is None:
        raise OrmError(
            codes.SCHEMA_HASH_MISMATCH,
            f"manifest {manifest_hash} is not registered on this connection: "
            f"connect through its generated package or register it",
        )
    return model


def markdown_call(ex, request: dict, params) -> tuple[dict, RuntimeModel]:
    """Validates the request, runs the request message in the session ex, and returns the answer."""
    db = ex.db
    if db.closed:
        raise OrmError(codes.CONFIG, "database is closed")
    m = markdown_model(db, request["manifest_hash"])
    request["n_params"] = len(params)
    validate(m, request)
    uses = param_uses(m, request)
    for i, value in enumerate(params):
        for use in uses[i]:
            check_assign(i, value, use_slot_type(use))
            if use.column is not None and any(
                s in _HOST_STAGES for s in use.column.stages
            ):
                continue
            check_param(i, value, use_slot_type(use), db.zone)
    msg = {
        "ir_version": request["ir_version"],
        "manifest_hash": request["manifest_hash"],
        "request": request,
        "params": [
            markdown_param(db, i, value, uses[i]) for i, value in enumerate(params)
        ],
        "now": db.now(db.clock_micros(), 6),
    }
    session = ex.frame.connection if ex.frame is not None else db._connection
    if session is None:
        raise OrmError(codes.CONFIG, "transaction already finished")
    return session.call(msg), m


def markdown_param(db, i: int, value, uses: list[ParamUse]):
    """The runtime value model JSON value of parameter i: decimal is a string, bytes are base64, and datetime is UTC
    YYYY-MM-DD HH:MM:SS.ffffff, date is YYYY-MM-DD, and time is HH:MM:SS.ffffff. The form is decided by the type of the slot
    that the parameter fills. The slots of hex and ip style columns are encoded by the client and sent, as with SQL connections."""
    from polyspec.orm.codec import host_encode
    from polyspec.orm.database import time_value

    use = uses[0] if uses else ParamUse("")
    if use.column is not None and value is not None:
        host = [s for s in use.column.stages if s in _HOST_STAGES]
        if host:
            value = host_encode(value, host, db.aes_key)
    if value is None or isinstance(value, bool):
        return value
    if use.type in ("date", "time", "datetime") and isinstance(value, str):
        return time_value(value, use.type, db.zone, 6)
    if isinstance(value, (bytes, bytearray)):
        return base64.b64encode(bytes(value)).decode("ascii")
    if isinstance(value, str) and use.type == "bytes":
        return base64.b64encode(value.encode("utf-8")).decode("ascii")
    if isinstance(value, (str, int, float)):
        return value
    raise OrmError(
        codes.CODEC_ENCODE, f"parameter {i} ({type(value).__name__}) has no JSON form"
    )


def _answer_error(message: str) -> OrmError:
    return OrmError(codes.INTERNAL, f"the flowmark answer: {message}")


class MdLinks:
    """The join and relation values of one answer row. They are placed in the row's last cell."""

    __slots__ = ("joins", "rels")

    def __init__(self):
        self.joins: dict = {}
        self.rels: dict = {}


class MdNode:
    """One node of the answer: root, join, or relation, one each. asm describes the row layout of the node; children are that join and
    relation. The node's first row decides the columns of asm, and later rows must have the same outputs in the same order."""

    def __init__(self, m: RuntimeModel, q: dict, groups: bool):
        self.q = q
        self.ent: Entity = entity_of(m, q["entity"])
        self.m = m
        self.groups = groups
        self.asm = {
            "entity": self.ent.name,
            "alias": "",
            "columns": [],
            "children": [],
            "key": [],
        }
        self.built = False
        self.joins: dict[str, MdNode] = {}
        self.rels: dict[str, MdNode] = {}
        for join in q.get("joins") or []:
            child = MdNode(m, join["query"], False)
            self.joins[join["rel"]] = child
            self.asm["children"].append(
                {
                    "rel": join["rel"],
                    "kind": "join",
                    "step": 0,
                    "parent_keys": [],
                    "child_keys": [],
                    "key": [],
                    "flatten": False,
                    "cascade": False,
                    "assemble": child.asm,
                }
            )
        for relation in q.get("relations") or []:
            child = MdNode(m, relation["query"], False)
            self.rels[relation["rel"]] = child
            target = entity_of(m, relation["query"]["entity"])
            parent_keys = [k["left"] for k in relation.get("keys") or []]
            child_keys = [k["right"] for k in relation.get("keys") or []]
            self.asm["children"].append(
                {
                    "rel": relation["rel"],
                    "kind": relation["kind"],
                    "step": 0,
                    "parent_keys": [],
                    "child_keys": [],
                    "key": [],
                    "flatten": bool(relation["query"].get("flatten")),
                    # If this row is the row that a relation row's foreign key points to, those rows belong to this row (as in the planner).
                    "cascade": not relation["query"].get("no_cascade_delete")
                    and parent_keys == list(self.ent.primary_key)
                    and child_keys != list(target.primary_key),
                    "assemble": child.asm,
                }
            )

    def out_col(self, name: str, index: int) -> dict:
        """The layout of an output name: a subquery, a column function, or a column of the node's entity. The markdown executor leaves
        all codec stages to the client, so the style is the whole stage of the column that decodes."""
        if self.groups and name == "row_count":
            return {
                "index": index,
                "name": name,
                "column": "",
                "type": "i64",
                "styles": [],
                "hidden": False,
            }
        columns = self.q.get("columns") or {}
        if not self.groups:
            sub = (columns.get("sub") or {}).get(name)
            if sub is not None:
                return {
                    "index": index,
                    "name": name,
                    "column": "",
                    "type": sub_type(self.m, sub),
                    "styles": [],
                    "hidden": False,
                }
            cf = (columns.get("fn") or {}).get(name)
            if cf is not None:
                return {
                    "index": index,
                    "name": name,
                    "column": cf["column"],
                    "type": function_type(
                        cf["fn"]["name"], field_of(self.ent, cf["column"])
                    ),
                    "styles": [],
                    "hidden": False,
                }
        f = field_of(self.ent, name)
        if f is None:
            raise _answer_error(
                f"{self.ent.name} answers {name}, which is no output of the request"
            )
        return {
            "index": index,
            "name": name,
            "column": name,
            "type": f.type,
            "styles": list(f.stages),
            "hidden": False,
        }

    def build(self, outputs: list[str]) -> None:
        """The first row of the node's output decides the asm columns and keys."""
        for i, name in enumerate(outputs):
            self.asm["columns"].append(self.out_col(name, i))
        keys = (self.q.get("group_by") or []) if self.groups else self.ent.primary_key
        for key in keys:
            if key not in outputs:
                raise _answer_error(
                    f"{self.ent.name} answers no {key}, a key of its rows"
                )
            self.asm["key"].append({"column": key, "index": outputs.index(key)})
        self.built = True

    def row(self, raw, db) -> list:
        """Reads one answer row as a position row of the node's layout: the output values, and in the last cell, the join and relation
        rows."""
        if not isinstance(raw, dict):
            raise _answer_error(
                f"a row of {self.ent.name}: {_plain(raw)} is not a JSON object"
            )
        outputs = [
            name for name in raw if name not in self.joins and name not in self.rels
        ]
        if not self.built:
            self.build(outputs)
        columns = self.asm["columns"]
        if len(outputs) != len(columns):
            raise _answer_error(
                f"a row of {self.ent.name} answers {outputs}, another output than its first row"
            )
        values: list = []
        links = MdLinks()
        for name, value in raw.items():
            if name in self.joins:
                links.joins[name] = (
                    None if value is None else self.joins[name].row(value, db)
                )
                continue
            if name in self.rels:
                links.rels[name] = self.rels[name].relation_rows(value, db)
                continue
            col = columns[len(values)]
            if col["name"] != name:
                raise _answer_error(
                    f"a row of {self.ent.name} answers {name} where its first row answers "
                    f"{col['name']}"
                )
            values.append(answer_value(col["type"], value, f"{self.ent.name}.{name}"))
        from polyspec.orm.database import _decode_assembly

        # The corpus catalog rejects aes columns, so there is no keyring (docs/spec/dialects.md).
        _decode_assembly(values, {"columns": columns, "children": []}, db)
        values.append(links)
        return values

    def relation_rows(self, raw, db) -> list:
        """Reads a relation's value as a list of rows: a one relation is an object or null, a many relation is an array, and a key_by
        relation is an object grouped by key."""
        if raw is None:
            return []
        if isinstance(raw, list):
            return self.rows(raw, db)
        if self.q.get("key_by"):
            if not isinstance(raw, dict):
                raise _answer_error(
                    f"keyed relation rows of {self.ent.name}: {_plain(raw)} is not a JSON object"
                )
            return self.rows(list(raw.values()), db)
        return [self.row(raw, db)]

    def rows(self, items: list, db) -> list:
        return [self.row(item, db) for item in items]


def sub_type(m: RuntimeModel, sub: dict) -> str:
    """The type of a scalar subquery column."""
    if sub.get("agg") == "count":
        return "i64"
    if sub.get("agg") == "avg":
        return "f64"
    f = field_of(entity_of(m, sub["query"]["entity"]), sub["column"])
    return f.type if f is not None else "text"


def answer_value(type_: str, raw, where: str):
    """Reads one answer value as a Python value of the column's type. The value is in the same runtime value model as the parameters."""
    if raw is None:
        return None

    def bad():
        return OrmError(
            codes.CODEC_DECODE,
            f"{where}: the answer value {_plain(raw)} is not a {type_} value",
        )

    if type_ in ("i16", "i32", "i64"):
        if isinstance(raw, bool) or not isinstance(raw, int):
            raise bad()
        return raw
    if type_ == "f64":
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            raise bad()
        return float(raw)
    if type_ == "bool":
        if not isinstance(raw, bool):
            raise bad()
        return raw
    if type_ == "bytes":
        if not isinstance(raw, str):
            raise bad()
        try:
            return base64.b64decode(raw, validate=True)
        except ValueError:
            raise bad() from None
    if not isinstance(raw, str):
        raise bad()
    return raw


def aggregate_value(raw):
    """The value of sum and avg answers: an integer, a decimal, or a decimal string, or None if there is none."""
    if raw is None or isinstance(raw, str):
        return raw
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise _answer_error(f"the aggregate {_plain(raw)} is no number")
    return raw


def markdown_read(ex, request: dict, params) -> tuple[dict, int]:
    """Reads the answer of a row read (one, all, group_count, paginate) as a positional result. The plan of the result is the layout of the root node,
    and the last cell of each row is that join and relation."""
    answer, m = markdown_call(ex, request, params)
    rows = answer.get("rows")
    if not isinstance(rows, list):
        raise _answer_error(f"a {request['kind']} answer {_plain(answer)} has no rows")
    count = answer.get("count")
    if request["kind"] == "paginate" and (
        isinstance(count, bool) or not isinstance(count, int)
    ):
        raise _answer_error(f"a paginate answer {_plain(answer)} has no count")
    root = MdNode(m, request, request["kind"] == "group_count")
    if root.groups and not rows:
        # An empty group answer has no first row to name the outputs, so they are the group_by keys and
        # row_count, the same outputs every group row answers.
        root.build([*(request.get("group_by") or []), "row_count"])
    main = root.rows(rows, ex.db)
    plan = {
        "manifest_hash": request["manifest_hash"],
        "kind": request["kind"],
        "steps": [{"id": 0, "role": "main", "assemble": root.asm}],
    }
    return {
        "plan": plan,
        "main": main,
        "steps": {},
        "params": params,
        "markdown": True,
    }, count or 0


def markdown_scalar(ex, request: dict, params):
    """The answer for count, sum, and avg."""
    answer, _ = markdown_call(ex, request, params)
    if request["kind"] == "count":
        count = answer.get("count")
        if isinstance(count, bool) or not isinstance(count, int):
            raise _answer_error(f"a count answer {_plain(answer)} has no count")
        return count
    if "value" not in answer:
        raise _answer_error(f"a {request['kind']} answer {_plain(answer)} has no value")
    return aggregate_value(answer["value"])


def markdown_write(ex, request: dict, params) -> tuple[list, int]:
    """The write answer {affected, keys}. keys holds the primary keys of the inserted rows in insert order: an identity is
    an integer; a key_prefix key is text."""
    answer, _ = markdown_call(ex, request, params)
    affected = answer.get("affected")
    if isinstance(affected, bool) or not isinstance(affected, int):
        raise _answer_error(
            f"a {request['kind']} answer {_plain(answer)} has no affected"
        )
    keys = [aggregate_value(key) for key in answer.get("keys") or []]
    if request["kind"] == "update" and request.get("optimistic") and affected == 0:
        raise OrmError(codes.OPTIMISTIC_LOCK, "the row changed after it was read")
    return keys, affected


def markdown_links(row: list) -> MdLinks:
    """The join and relation that the answer row holds in its last cell."""
    links = row[-1] if row else None
    return links if isinstance(links, MdLinks) else MdLinks()


def begin_message(read_only: bool) -> dict:
    """The begin control message of a transaction: a read-only transaction sends read_only true, any other leaves the
    member out (docs/spec/protocol.md section 5 Session, the control cases of tests/bind/vectors.json)."""
    return {"op": "begin", "read_only": True} if read_only else {"op": "begin"}


def begin_markdown(db, frame, options: dict) -> None:
    """Opens a markdown transaction: the frame holds the connection's session until the transaction ends, and sends begin.
    A read-only transaction sends read_only."""
    if options.get("isolation") is not None:
        unsupported_on_markdown(db, "the transaction isolation option")
    frame.connection = db._connection
    try:
        frame.connection.call(begin_message(bool(options.get("readOnly"))))
    except BaseException:
        frame.finished = True
        frame.connection = None
        raise


def end_markdown(frame, op: str) -> None:
    """Ends the transaction with commit or rollback, and returns the session to the connection."""
    try:
        frame.connection.call({"op": op})
    finally:
        frame.connection = None


def savepoint_markdown(frame, op: str, name: str) -> None:
    """Sends one savepoint control message: savepoint, release, or rollback_to."""
    frame.connection.call({"op": op, "name": name})
