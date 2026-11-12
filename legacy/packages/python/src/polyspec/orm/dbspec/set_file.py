# The dbspec set reader (docs/spec/dbspec.md "Document sets"). Every tool that takes a document set reads
# its set file `dbspec-set.json` with read_dbspec_set, which checks the file, its JSON and every listed
# path in four steps and gives the listed files with their joined paths and bytes.
from __future__ import annotations

import json
import ntpath
import os
import stat
from dataclasses import dataclass

from polyspec.orm.message import quote as quote_message

__all__ = [
    "DBSPEC_SET_NAME",
    "DbspecSet",
    "DbspecSetError",
    "DbspecSetFile",
    "read_dbspec_set",
]

# The name of every set file.
DBSPEC_SET_NAME = "dbspec-set.json"

_WINDOWS = os.name == "nt"
_KEYS = ("schema", "documents", "external")
_MAX_DEPTH = 64
_BOM = b"\xef\xbb\xbf"
# The characters that no segment of a normal path holds: the separators, the characters Windows
# reserves, NUL and U+0001 to U+001F.
_FORBIDDEN = frozenset('/\\:<>"|?*') | frozenset(chr(c) for c in range(0x20))
# The device names of Windows, compared ignoring ASCII case with the part of a segment before its
# first `.`, its trailing spaces removed.
_DEVICES = frozenset(
    ["con", "prn", "aux", "nul"]
    + [
        f"{name}{digit}"
        for name in ("com", "lpt")
        for digit in "0123456789\u00b9\u00b2\u00b3"
    ]
)
_ASCII_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")
# FILE_ATTRIBUTE_REPARSE_POINT, and the name surrogate bit of a reparse tag (IsReparseTagNameSurrogate).
_REPARSE_POINT = 0x400
_NAME_SURROGATE = 0x20000000
_LOW_64 = (1 << 64) - 1


@dataclass(frozen=True)
class DbspecSetFile:
    """A listed file: its joined path (the set file's prefix followed by the written path) and its
    bytes, which the byte check reads with that path."""

    path: str
    data: bytes


@dataclass(frozen=True)
class DbspecSet:
    """The files of a set file in written order: the documents the set owns and its external
    documents."""

    documents: tuple[DbspecSetFile, ...]
    external: tuple[DbspecSetFile, ...]


@dataclass(frozen=True)
class DbspecSetError:
    """One error of a set file: its `set.*` rule, the path it concerns and a message that names it."""

    rule: str
    path: str
    message: str


class _Failure(Exception):
    """The first error of one step or one path."""

    def __init__(self, rule: str, path: str, message: str):
        super().__init__(message)
        self.error = DbspecSetError(rule, path, message)


def read_dbspec_set(path: str) -> tuple[DbspecSet | None, tuple[DbspecSetError, ...]]:
    """Reads the set file at `path` and every file it lists. It gives the set and no errors, or no set
    and every error by step, then by path, `documents` first and then `external`, in written order.
    It never follows a symbolic link in a tree that does not change while it runs and does not check
    the bytes of a listed file."""
    if not isinstance(path, str):
        raise TypeError("dbspec set path must be a string")
    prefix, name = _split(path)
    try:
        data = _read_set_file(path, prefix, name)
        documents, external = _parse(path, data)
    except _Failure as failure:
        return None, (failure.error,)
    entries = [(written, False) for written in documents] + [
        (written, True) for written in external
    ]
    errors = []
    passed = []
    for written, is_external in entries:
        try:
            passed.append(
                (_check_path(path, prefix, written, is_external), is_external)
            )
        except _Failure as failure:
            errors.append(failure.error)
    seen = {}
    read = ([], [])
    for joined, is_external in passed:
        try:
            data, identity = _read_listed(joined)
        except _Failure as failure:
            errors.append(failure.error)
            continue
        if identity in seen:
            errors.append(
                DbspecSetError(
                    "set.duplicate",
                    joined,
                    f"{joined}: names the file that {seen[identity]} names",
                )
            )
            continue
        seen[identity] = joined
        read[1 if is_external else 0].append(DbspecSetFile(joined, data))
    if errors:
        return None, tuple(errors)
    return DbspecSet(tuple(read[0]), tuple(read[1])), ()


def _split(path: str) -> tuple[str, str]:
    """The prefix (the path with its last segment removed) and the last segment. A segment ends at
    `/`, and on Windows also at `\\` or after the drive."""
    drive = ""
    rest = path
    if _WINDOWS:
        drive, rest = ntpath.splitdrive(path)
        end = max(rest.rfind("/"), rest.rfind("\\"))
    else:
        end = rest.rfind("/")
    return drive + rest[: end + 1], rest[end + 1 :]


def _root(prefix: str) -> str:
    """The root as it is examined: the prefix, or `.` when it is empty, without trailing separators,
    which would make lstat follow a symbolic link, unless they are all that names it (`/`, `C:\\`)."""
    if prefix == "":
        return "."
    separators = "/\\" if _WINDOWS else "/"
    stripped = prefix.rstrip(separators)
    if stripped == "" or (_WINDOWS and stripped == ntpath.splitdrive(prefix)[0]):
        return prefix
    return stripped


def _os_path(path: str):
    """The path given to the platform: on POSIX its bytes, so that a segment is looked up by its
    UTF-8 bytes; on Windows the text, which the platform takes as UTF-16."""
    return path if _WINDOWS else os.fsencode(path)


def _listed(directory: str, segment: str, report: str, root: bool = False) -> None:
    """Checks that `segment` equals a name that `directory` lists: on POSIX its UTF-8 bytes equal the
    listed bytes, on Windows its UTF-16 code units the listed ones."""
    subject = f"the root {directory}" if root else directory
    try:
        names = os.listdir(_os_path(directory))
    except OSError as error:
        raise _Failure(
            "set.file", report, f"{report}: {subject} cannot be listed: {error}"
        ) from None
    want = segment if _WINDOWS else segment.encode("utf-8")
    if want not in names:
        lists = DBSPEC_SET_NAME if root else f"name {quote_message(segment)}"
        raise _Failure("set.file", report, f"{report}: {subject} lists no {lists}")


def _is_link(status: os.stat_result) -> bool:
    """A symbolic link; on Windows any reparse point whose tag is a name surrogate, a symbolic link
    or a junction."""
    if _WINDOWS:
        return bool(getattr(status, "st_file_attributes", 0) & _REPARSE_POINT) and bool(
            getattr(status, "st_reparse_tag", 0) & _NAME_SURROGATE
        )
    return stat.S_ISLNK(status.st_mode)


def _lstat(
    path: str, report: str, subject: str, follow: bool = False
) -> os.stat_result:
    """The status of `path` without following a symbolic link at its last component, or, with
    `follow`, the status of the entry that it names (stat). `subject` names it in the message."""
    try:
        return (os.stat if follow else os.lstat)(_os_path(path))
    except OSError as error:
        raise _Failure(
            "set.file", report, f"{report}: {subject} cannot be examined: {error}"
        ) from None


def _read_set_file(path: str, prefix: str, name: str) -> bytes:
    """Step 1: the set file and its root (DBS-12), in the order of DBS-18a."""
    if name != DBSPEC_SET_NAME:
        raise _Failure(
            "set.file", path, f"{path}: the set file is not named {DBSPEC_SET_NAME}"
        )
    if "\0" in path:
        raise _Failure("set.file", path, f"{path}: the path contains a NUL byte")
    root = _root(prefix)
    status = _lstat(root, path, f"the root {root}")
    if _is_link(status):
        raise _Failure(
            "set.symlink", path, f"{path}: the root {root} is a symbolic link"
        )
    if not stat.S_ISDIR(status.st_mode):
        raise _Failure("set.file", path, f"{path}: the root {root} is not a directory")
    _listed(root, name, path, root=True)
    status = _lstat(path, path, "the set file")
    if _is_link(status):
        raise _Failure("set.symlink", path, f"{path}: the set file is a symbolic link")
    if not stat.S_ISREG(status.st_mode):
        raise _Failure("set.file", path, f"{path}: the set file is not a regular file")
    try:
        with open(_os_path(path), "rb") as handle:
            return handle.read()
    except OSError as error:
        raise _Failure(
            "set.file", path, f"{path}: the set file cannot be read: {error}"
        ) from None


def _parse(path: str, data: bytes) -> tuple[list[str], list[str]]:
    """Step 2: the JSON of the set file."""

    def invalid(reason):
        return _Failure("set.json", path, f"{path}: the set file {reason}")

    if data.startswith(_BOM):
        raise invalid("starts with a byte order mark")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise invalid("is not valid UTF-8") from None

    def pairs(items):
        return {key: value for key, value in items} | {
            _KeyList: [key for key, _ in items]
        }

    def constant(name):
        raise ValueError(f"{name} is not a JSON number")

    try:
        value = json.loads(
            text,
            object_pairs_hook=pairs,
            parse_constant=constant,
            parse_int=float,
            parse_float=float,
        )
    except RecursionError:
        raise invalid(f"nests deeper than {_MAX_DEPTH} levels") from None
    except ValueError as error:
        raise invalid(f"is not JSON: {error}") from None
    if not isinstance(value, dict):
        raise invalid("is not one JSON object")
    depth, surrogate = _walk(value)
    if depth > _MAX_DEPTH:
        raise invalid(f"nests deeper than {_MAX_DEPTH} levels")
    if surrogate:
        raise invalid("escapes a lone surrogate")

    def key_error(message):
        return _Failure("set.key", path, f"{path}: {message}")

    repeated = _first_repeated_key(text)
    if repeated is not None:
        raise key_error(f"the key {quote_message(repeated)} appears twice")
    del value[_KeyList]
    unknown = sorted(key for key in value if key not in _KEYS)
    if unknown:
        raise key_error(
            ("unknown key " if len(unknown) == 1 else "unknown keys ")
            + ", ".join(quote_message(key) for key in unknown)
        )
    # DBS-13: schema, then documents, then external.
    if "schema" not in value:
        raise _Failure("set.schema", path, f"{path}: schema is missing")
    schema = value["schema"]
    if not isinstance(schema, float) or schema != 1:
        raise _Failure("set.schema", path, f"{path}: schema is not the number 1")
    if "documents" not in value:
        raise key_error("documents is missing")
    documents = value["documents"]
    if not _strings(documents):
        raise key_error("documents is not an array of strings")
    if not documents:
        raise _Failure("set.empty", path, f"{path}: documents is empty")
    external = value.get("external", [])
    if not _strings(external):
        raise key_error("external is not an array of strings")
    return documents, external


def _first_repeated_key(text: str) -> str | None:
    """The first key, in text order, that an object of the parsed JSON text already holds, at any depth, or None. The
    text is valid JSON, so each string ends at the first quote that no backslash escapes."""
    objects: list[tuple[set, list]] = []
    stack: list[bool] = []
    i = 0
    while i < len(text):
        c = text[i]
        if c == "{":
            stack.append(True)
            objects.append((set(), [True]))
        elif c == "[":
            stack.append(False)
        elif c in "}]":
            if stack.pop():
                objects.pop()
        elif c == "," and stack and stack[-1]:
            objects[-1][1][0] = True
        elif c == '"':
            end = i + 1
            while text[end] != '"':
                end += 2 if text[end] == "\\" else 1
            if stack and stack[-1] and objects[-1][1][0]:
                key = json.loads(text[i : end + 1])
                keys, expecting = objects[-1]
                if key in keys:
                    return key
                keys.add(key)
                expecting[0] = False
            i = end
        i += 1
    return None


class _KeyList:
    """The key under which a parsed object keeps its written keys, so that the walk sees the keys of
    every object, repeated ones included."""


def _strings(value) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _walk(value) -> tuple[int, bool]:
    """The nesting depth of a parsed value, an object or array counting as one level, and whether a
    key or string holds a lone surrogate. The bytes were valid UTF-8, so a surrogate code point came
    from an escape."""
    depth = 0
    surrogate = False
    stack = [(value, 1)]
    while stack:
        item, level = stack.pop()
        if isinstance(item, dict):
            depth = max(depth, level)
            surrogate = surrogate or any(_has_surrogate(key) for key in item[_KeyList])
            stack.extend(
                (child, level + 1) for key, child in item.items() if key is not _KeyList
            )
        elif isinstance(item, list):
            depth = max(depth, level)
            stack.extend((child, level + 1) for child in item)
        elif isinstance(item, str):
            surrogate = surrogate or _has_surrogate(item)
    return depth, surrogate


def _has_surrogate(text: str) -> bool:
    return any("\ud800" <= c <= "\udfff" for c in text)


def _path_problem(written: str, is_external: bool) -> str | None:
    """The first problem of DBS-18a that keeps `written` from the normal form of a set path, checking the segments from
    the first and then the suffix, or None."""
    segments = written.split("/")
    leading = is_external
    for segment in segments:
        if segment == "":
            return "has an empty segment"
        if segment == "..":
            if not leading:
                return (
                    "has a .. segment after another segment"
                    if is_external
                    else "has a .. segment"
                )
            continue
        leading = False
        if segment == ".":
            return "has a . segment"
        held = next((c for c in segment if c in _FORBIDDEN), None)
        if held is not None:
            return f"has the character {quote_message(held)} that a segment cannot hold"
        if segment[-1] in ". ":
            return "has a segment that ends in . or a space"
        if segment.split(".", 1)[0].rstrip(" ").translate(_ASCII_LOWER) in _DEVICES:
            return (
                f"has the segment {quote_message(segment)} that names a Windows device"
            )
    if not segments[-1].endswith(".dbs"):
        return "does not end in .dbs"
    return None


def _check_path(path: str, prefix: str, written: str, is_external: bool) -> str:
    """Step 3 for one written path: its normal form, then every component of its joined path. It
    gives the joined path."""
    problem = _path_problem(written, is_external)
    if problem is not None:
        kind = "external" if is_external else "documents"
        raise _Failure(
            "set.path",
            path,
            f"{path}: the {kind} path {quote_message(written)} {problem}",
        )
    joined = prefix + written
    segments = written.split("/")
    directory = _root(prefix)
    for index, segment in enumerate(segments):
        component = prefix + "/".join(segments[: index + 1])
        last = index == len(segments) - 1
        if segment != "..":
            _listed(directory, segment, joined)
        status = _lstat(component, joined, component)
        if _is_link(status) and is_external and not last:
            # An intermediate component of an external path may be a link to a directory: it is followed.
            status = _lstat(component, joined, component, follow=True)
        if _is_link(status):
            raise _Failure(
                "set.symlink", joined, f"{joined}: {component} is a symbolic link"
            )
        if last and not stat.S_ISREG(status.st_mode):
            raise _Failure(
                "set.file", joined, f"{joined}: {component} is not a regular file"
            )
        if not last and not stat.S_ISDIR(status.st_mode):
            raise _Failure(
                "set.file", joined, f"{joined}: {component} is not a directory"
            )
        directory = component
    return joined


def _read_listed(joined: str) -> tuple[bytes, tuple[int, int]]:
    """Step 4 for one path: its bytes and its identity, both from one handle."""
    try:
        with open(_os_path(joined), "rb") as handle:
            status = os.fstat(handle.fileno())
            data = handle.read()
    except OSError as error:
        raise _Failure(
            "set.file", joined, f"{joined}: the file cannot be read: {error}"
        ) from None
    return data, (status.st_dev, status.st_ino & _LOW_64)
