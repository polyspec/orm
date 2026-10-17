# The dbspec set reader (docs/dbspec.md "Document sets"). Every tool that takes a document set reads
# its set file `dbspec-set.json` with read_dbspec_set, which checks the file, its JSON and every listed
# path in four steps and gives the listed files with their joined paths and bytes.
from __future__ import annotations

import json
import ntpath
import os
import stat
from dataclasses import dataclass

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
                    f"{joined} names the file that {seen[identity]} names",
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


def _listed(directory: str, segment: str, subject: str, report: str) -> None:
    """Checks that `segment` equals a name that `directory` lists: on POSIX its UTF-8 bytes equal the
    listed bytes, on Windows its UTF-16 code units the listed ones."""
    try:
        names = os.listdir(_os_path(directory))
    except OSError as error:
        raise _Failure(
            "set.file", report, f"{report}: {directory} cannot be listed: {error}"
        ) from None
    want = segment if _WINDOWS else segment.encode("utf-8")
    if want not in names:
        raise _Failure(
            "set.file",
            report,
            f"{report}: {subject} is not a name that {directory} lists",
        )


def _is_link(status: os.stat_result) -> bool:
    """A symbolic link; on Windows any reparse point whose tag is a name surrogate, a symbolic link
    or a junction."""
    if _WINDOWS:
        return bool(getattr(status, "st_file_attributes", 0) & _REPARSE_POINT) and bool(
            getattr(status, "st_reparse_tag", 0) & _NAME_SURROGATE
        )
    return stat.S_ISLNK(status.st_mode)


def _lstat(path: str, report: str, follow: bool = False) -> os.stat_result:
    """The status of `path` without following a symbolic link at its last component, or, with
    `follow`, the status of the entry that it names (stat)."""
    try:
        return (os.stat if follow else os.lstat)(_os_path(path))
    except FileNotFoundError:
        raise _Failure("set.file", report, f"{report}: {path} is missing") from None
    except OSError as error:
        raise _Failure(
            "set.file", report, f"{report}: {path} cannot be examined: {error}"
        ) from None


def _read_set_file(path: str, prefix: str, name: str) -> bytes:
    """Step 1: the set file and its root."""
    if name != DBSPEC_SET_NAME:
        raise _Failure("set.file", path, f"{path} is not named {DBSPEC_SET_NAME}")
    root = _root(prefix)
    status = _lstat(root, path)
    if _is_link(status):
        raise _Failure(
            "set.symlink", path, f"{path}: its root {root} is a symbolic link"
        )
    if not stat.S_ISDIR(status.st_mode):
        raise _Failure("set.file", path, f"{path}: its root {root} is not a directory")
    _listed(root, name, name, path)
    status = _lstat(path, path)
    if _is_link(status):
        raise _Failure("set.symlink", path, f"{path} is a symbolic link")
    if not stat.S_ISREG(status.st_mode):
        raise _Failure("set.file", path, f"{path} is not a regular file")
    try:
        with open(_os_path(path), "rb") as handle:
            return handle.read()
    except OSError as error:
        raise _Failure("set.file", path, f"{path} cannot be read: {error}") from None


def _parse(path: str, data: bytes) -> tuple[list[str], list[str]]:
    """Step 2: the JSON of the set file."""

    def invalid(reason):
        return _Failure("set.json", path, f"{path} {reason}")

    if data.startswith(_BOM):
        raise invalid("starts with a byte order mark")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise invalid("is not valid UTF-8") from None
    repeated = []

    def pairs(items):
        keys = set()
        for key, _ in items:
            if key in keys:
                repeated.append(key)
            keys.add(key)
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
        raise invalid(f"is nested more than {_MAX_DEPTH} levels deep") from None
    except ValueError as error:
        raise invalid(f"is not JSON: {error}") from None
    if not isinstance(value, dict):
        raise invalid("is not a JSON object")
    depth, surrogate = _walk(value)
    if depth > _MAX_DEPTH:
        raise invalid(f"is nested more than {_MAX_DEPTH} levels deep")
    if surrogate:
        raise invalid("escapes a lone surrogate")

    def key_error(message):
        return _Failure("set.key", path, f"{path} {message}")

    if repeated:
        raise key_error(
            "repeats the key "
            + ", ".join(
                json.dumps(key, ensure_ascii=False) for key in sorted(set(repeated))
            )
        )
    del value[_KeyList]
    unknown = sorted(key for key in value if key not in _KEYS)
    if unknown:
        raise key_error(
            "has the unknown key "
            + ", ".join(json.dumps(key, ensure_ascii=False) for key in unknown)
        )
    schema = value.get("schema")
    if not isinstance(schema, float) or schema != 1:
        raise _Failure(
            "set.schema",
            path,
            f"{path} has no schema 1" if "schema" in value else f"{path} has no schema",
        )
    if "documents" not in value:
        raise key_error("has no documents")
    documents = value["documents"]
    if not _strings(documents):
        raise key_error("has documents that are not an array of strings")
    if not documents:
        raise _Failure("set.empty", path, f"{path} has no documents")
    external = value.get("external", [])
    if not _strings(external):
        raise key_error("has external that is not an array of strings")
    return documents, external


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


def _normal(written: str, is_external: bool) -> bool:
    """Whether `written` is in the normal form of a set path."""
    segments = written.split("/")
    if not segments[-1].endswith(".dbs"):
        return False
    leading = is_external
    for segment in segments:
        if segment == "..":
            if not leading:
                return False
            continue
        leading = False
        if segment == "" or segment == "." or segment[-1] in ". ":
            return False
        if any(c in _FORBIDDEN for c in segment):
            return False
        if segment.split(".", 1)[0].rstrip(" ").translate(_ASCII_LOWER) in _DEVICES:
            return False
    return True


def _check_path(path: str, prefix: str, written: str, is_external: bool) -> str:
    """Step 3 for one written path: its normal form, then every component of its joined path. It
    gives the joined path."""
    if not _normal(written, is_external):
        kind = "external" if is_external else "documents"
        raise _Failure(
            "set.path",
            path,
            f"{path}: the {kind} path {json.dumps(written, ensure_ascii=False)} "
            f"has no normal form",
        )
    joined = prefix + written
    segments = written.split("/")
    directory = _root(prefix)
    for index, segment in enumerate(segments):
        component = prefix + "/".join(segments[: index + 1])
        last = index == len(segments) - 1
        if segment != "..":
            _listed(directory, segment, component, joined)
        status = _lstat(component, joined)
        if _is_link(status) and is_external and not last:
            # An intermediate component of an external path may be a link to a directory: it is followed.
            status = _lstat(component, joined, follow=True)
        if _is_link(status):
            raise _Failure(
                "set.symlink", joined, f"{joined}: {component} is a symbolic link"
            )
        if last and not stat.S_ISREG(status.st_mode):
            raise _Failure("set.file", joined, f"{joined} is not a regular file")
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
            "set.file", joined, f"{joined} cannot be read: {error}"
        ) from None
    return data, (status.st_dev, status.st_ino & _LOW_64)
