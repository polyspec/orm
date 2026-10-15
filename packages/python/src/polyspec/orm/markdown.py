# markdown IR executor: markdown:// DSN의 연결은 flowmark server에 IR request를 보내고 답의 행을 model로 조립한다
# (docs/protocol.md §5 "IR executors", docs/dialects.md "Markdown IR executor"). Go client의 markdown.go와 같은
# 규칙이다. Python client는 SQL 연결처럼 server 연결 하나를 쓴다.
from __future__ import annotations

import base64
import datetime
import json
import socket
from dataclasses import dataclass
from urllib.parse import parse_qsl

from polyspec.orm.engine.model import Entity, RuntimeModel, entity_of, field_of
from polyspec.orm.bind_check import check_param, use_slot_type
from polyspec.orm.engine.params import ParamUse, function_type, param_uses
from polyspec.orm.engine.validate import validate
from polyspec.orm.errors import OrmError

__all__ = ["MarkdownDsn", "parse_markdown_dsn"]

_FORM = "markdown DSN is markdown://127.0.0.1:<port>/<corpus>?token=<token>"
# host 단계: SQL 연결처럼 client가 값을 encode해 보낸다.
_HOST_STAGES = ("aes", "hex", "ip")


@dataclass(frozen=True)
class MarkdownDsn:
    """markdown:// DSN의 flowmark server 주소, corpus 이름, token이다."""

    address: str
    corpus: str
    token: str


def parse_markdown_dsn(url) -> MarkdownDsn:
    """markdown://127.0.0.1:<port>/<corpus>?token=<token>을 읽는다. flowmark server는 127.0.0.1에서만 듣고
    token은 평문으로 가므로 host는 127.0.0.1뿐이다."""
    if url.username is not None or url.password is not None:
        raise OrmError("CONFIG", f"{_FORM}; it takes no user")
    if url.hostname != "127.0.0.1":
        raise OrmError(
            "CONFIG",
            f"{_FORM}; host {url.hostname!r}: a flowmark server listens on 127.0.0.1 only",
        )
    try:
        port = url.port
    except ValueError:
        port = None
    if port is None or not 1 <= port <= 65535:
        given = url.netloc.rpartition(":")[2] if ":" in url.netloc else ""
        raise OrmError(
            "CONFIG",
            f"{_FORM}; port {given!r} is not 1 to 65535: give the port that flowmark serve "
            f"printed",
        )
    corpus = url.path[1:] if url.path.startswith("/") else url.path
    if corpus == "" or "/" in corpus:
        raise OrmError(
            "CONFIG",
            f"{_FORM}; the path {url.path!r} is not one corpus name: give the corpus root's "
            f"directory name",
        )
    parameters = parse_qsl(url.query, keep_blank_values=True)
    tokens = [value for name, value in parameters if name == "token"]
    if len(tokens) != 1 or tokens[0] == "":
        raise OrmError(
            "CONFIG",
            f"{_FORM}; give one token, the token of .flowmark/server.json of the corpus",
        )
    for name, _ in parameters:
        if name != "token":
            raise OrmError("CONFIG", f"{_FORM}; it does not accept {name}")
    return MarkdownDsn(f"127.0.0.1:{port}", corpus, tokens[0])


def unsupported_on_markdown(db, surface: str) -> None:
    """markdown 연결에서 SQL 전용 surface가 받는 오류를 던진다(docs/dialects.md "Markdown IR executor"). 다른
    연결에서는 아무것도 하지 않는다."""
    if db.driver == "markdown":
        raise OrmError(
            "CAPABILITY_UNSUPPORTED",
            f"{surface} is not supported by the markdown IR executor",
        )


def _plain(value) -> str:
    """value의 JSON 한 줄이다. 비ASCII 문자를 escape하지 않아 값이 그대로 간다."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


class MdSession:
    """flowmark server와의 연결 하나, 곧 server session 하나다."""

    def __init__(self, sock: socket.socket):
        self.sock = sock
        self.stream = sock.makefile("rwb")
        # broken은 연결을 더 쓸 수 없음을 뜻한다: 읽기나 쓰기가 실패했거나 server가 연결을 끝낸다고 답했다.
        self.broken = False

    def close(self) -> None:
        self.broken = True
        try:
            self.stream.close()
        finally:
            self.sock.close()

    def call(self, msg: dict) -> dict:
        """message 하나를 한 줄로 보내고 답 한 줄을 읽는다. 답이 {"error": {code, message}}이면 그 code의
        오류다."""
        if self.broken:
            raise OrmError("CONNECTION_LOST", "the flowmark session has ended")
        try:
            line = _plain(msg)
        except (TypeError, ValueError) as error:
            raise OrmError("INTERNAL", f"writing the message: {error}", error) from None
        try:
            answer = self.exchange(line.encode("utf-8") + b"\n")
        except OSError as error:
            self.close()
            raise OrmError(
                "CONNECTION_LOST",
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
                "INTERNAL",
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
                    "INTERNAL",
                    f"the flowmark server answered the error {_plain(e)} without a code",
                )
            # server는 CONNECTION_LOST를 쓴 뒤 연결을 닫는다(idle transaction).
            if e["code"] == "CONNECTION_LOST":
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
    """server에 연결하고 첫 message connect로 corpus와 token을 보낸다."""
    host, _, port = dsn.address.rpartition(":")
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.connect((host, int(port)))
    except OSError as error:
        sock.close()
        raise OrmError(
            "DRIVER",
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
    """이 연결에 등록된 schema의 runtime model이다. 등록되지 않은 manifest는 SQL 연결과 같이
    SCHEMA_HASH_MISMATCH다."""
    model = db.schemas.get(manifest_hash)
    if model is None:
        raise OrmError(
            "SCHEMA_HASH_MISMATCH",
            f"manifest {manifest_hash} is not registered on this connection: "
            f"connect through its generated package or register it",
        )
    return model


def markdown_call(ex, request: dict, params) -> tuple[dict, RuntimeModel]:
    """request를 검증하고 그 request message를 ex의 session에서 실행해 답을 돌려준다."""
    db = ex.db
    if db.closed:
        raise OrmError("CONFIG", "database is closed")
    m = markdown_model(db, request["manifest_hash"])
    request["n_params"] = len(params)
    validate(m, request)
    uses = param_uses(m, request)
    for i, value in enumerate(params):
        for use in uses[i]:
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
        raise OrmError("CONFIG", "transaction already finished")
    return session.call(msg), m


def markdown_param(db, i: int, value, uses: list[ParamUse]):
    """parameter i의 runtime value model JSON 값이다: decimal은 string, bytes는 base64, datetime은 UTC의
    YYYY-MM-DD HH:MM:SS.ffffff, date는 YYYY-MM-DD, time은 HH:MM:SS.ffffff다. 어느 form인지는 parameter가 채우는
    slot의 type이 정한다. hex와 ip style column의 slot은 SQL 연결처럼 client가 값을 encode해 보낸다."""
    from polyspec.orm.codec import host_encode
    from polyspec.orm.database import time_value

    use = uses[0] if uses else ParamUse("")
    if use.column is not None and value is not None:
        host = [s for s in use.column.stages if s in _HOST_STAGES]
        if host:
            value = host_encode(value, host, db.aes_key)
    if value is None or isinstance(value, bool):
        return value
    if use.type in ("date", "time", "datetime") and isinstance(
        value, (str, datetime.date, datetime.time)
    ):
        return time_value(value, use.type, db.zone, 6)
    if isinstance(value, (bytes, bytearray)):
        return base64.b64encode(bytes(value)).decode("ascii")
    if isinstance(value, str) and use.type == "bytes":
        return base64.b64encode(value.encode("utf-8")).decode("ascii")
    if isinstance(value, (str, int, float)):
        return value
    raise OrmError(
        "CODEC_ENCODE", f"parameter {i} ({type(value).__name__}) has no JSON form"
    )


def _answer_error(message: str) -> OrmError:
    return OrmError("INTERNAL", f"the flowmark answer: {message}")


class MdLinks:
    """answer 행 하나의 join과 relation 값이다. 행의 마지막 칸에 둔다."""

    __slots__ = ("joins", "rels")

    def __init__(self):
        self.joins: dict = {}
        self.rels: dict = {}


class MdNode:
    """답의 한 node다: root, join, relation 하나가 하나씩이다. asm은 node의 행 배치를 적고 children은 그 join과
    relation이다. asm의 column은 node의 첫 행이 정하고 그 뒤 행은 같은 output을 같은 순서로 가져야 한다."""

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
                    # 이 행이 relation 행의 외래 key가 가리키는 행이면 그 행들은 이 행에 속한다(planner와 같다).
                    "cascade": not relation["query"].get("no_cascade_delete")
                    and parent_keys == list(self.ent.primary_key)
                    and child_keys != list(target.primary_key),
                    "assemble": child.asm,
                }
            )

    def out_col(self, name: str, index: int) -> dict:
        """output name의 배치다: subquery, column 함수, 아니면 node entity의 column이다. markdown executor는
        모든 codec stage를 client에 맡기므로 column의 stage 전체가 decode할 style이다."""
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
        """node의 첫 행의 output으로 asm의 column과 key를 정한다."""
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
        """답의 행 하나를 node 배치의 위치 행으로 읽는다: output 값, 그리고 마지막 칸에 join과 relation의
        행이다."""
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

        # corpus catalog은 aes column을 거절하므로 keyring이 없다(docs/dialects.md).
        _decode_assembly(values, {"columns": columns, "children": []}, db)
        values.append(links)
        return values

    def relation_rows(self, raw, db) -> list:
        """relation의 값을 행 목록으로 읽는다: one relation은 object나 null, many relation은 array, key_by
        relation은 key로 묶은 object다."""
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
    """scalar subquery column의 type이다."""
    if sub.get("agg") == "count":
        return "i64"
    if sub.get("agg") == "avg":
        return "f64"
    f = field_of(entity_of(m, sub["query"]["entity"]), sub["column"])
    return f.type if f is not None else "text"


def answer_value(type_: str, raw, where: str):
    """답의 값 하나를 column type의 Python 값으로 읽는다. 값은 parameter와 같은 runtime value model이다."""
    if raw is None:
        return None

    def bad():
        return OrmError(
            "CODEC_DECODE",
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
    """sum과 avg 답의 값이다: 정수, 소수, decimal string, 없으면 None이다."""
    if raw is None or isinstance(raw, str):
        return raw
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise _answer_error(f"the aggregate {_plain(raw)} is no number")
    return raw


def markdown_read(ex, request: dict, params) -> tuple[dict, int]:
    """row read(one, all, group_count, paginate)의 답을 위치 result로 읽는다. result의 plan은 root node의 배치
    하나이고, 각 행의 마지막 칸이 그 join과 relation이다."""
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
    """count, sum, avg의 답이다."""
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
    """write의 답 {affected, keys}이다. keys는 insert한 행의 primary key를 insert 순서로 담는다: identity는
    정수, key_prefix key는 text다."""
    answer, _ = markdown_call(ex, request, params)
    affected = answer.get("affected")
    if isinstance(affected, bool) or not isinstance(affected, int):
        raise _answer_error(
            f"a {request['kind']} answer {_plain(answer)} has no affected"
        )
    keys = [aggregate_value(key) for key in answer.get("keys") or []]
    if request["kind"] == "update" and request.get("optimistic") and affected == 0:
        raise OrmError("OPTIMISTIC_LOCK", "the row changed after it was read")
    return keys, affected


def markdown_links(row: list) -> MdLinks:
    """markdown 답의 행이 마지막 칸에 가진 join과 relation이다."""
    links = row[-1] if row else None
    return links if isinstance(links, MdLinks) else MdLinks()


def begin_markdown(db, frame, options: dict) -> None:
    """markdown transaction을 연다: 연결의 session을 transaction이 끝날 때까지 frame이 잡고 begin을 보낸다.
    읽기 전용 transaction은 read_only를 보낸다."""
    if options.get("isolation") is not None:
        unsupported_on_markdown(db, "the transaction isolation option")
    frame.connection = db._connection
    msg = {"op": "begin"}
    if options.get("readOnly"):
        msg["read_only"] = True
    try:
        frame.connection.call(msg)
    except BaseException:
        frame.finished = True
        frame.connection = None
        raise


def end_markdown(frame, op: str) -> None:
    """transaction을 commit이나 rollback으로 끝내고 session을 연결에 돌려준다."""
    try:
        frame.connection.call({"op": op})
    finally:
        frame.connection = None


def savepoint_markdown(frame, op: str, name: str) -> None:
    """savepoint control message 하나를 보낸다: savepoint, release, rollback_to."""
    frame.connection.call({"op": op, "name": name})
