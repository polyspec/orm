# dbspec document file reader (docs/spec/dbspec.md "Files"). Every tool that reads a file does so with this,
# and rejects a file without the signature before parsing.
from __future__ import annotations

from polyspec.orm.dbspec.model import DbspecDiagnostic

__all__ = ["DBSPEC_SIGNATURE", "read_dbspec_bytes", "read_dbspec_file"]

# The first byte of every dbspec document file. The header `dbspec 1 <document>` starts with it.
DBSPEC_SIGNATURE = b"dbspec "


def read_dbspec_file(path: str) -> tuple[str | None, list[DbspecDiagnostic]]:
    """Reads the dbspec document file at `path` to be parsed, and checks its bytes with path as the name
    in read_dbspec_bytes. A file that cannot be read raises OSError."""
    if not isinstance(path, str):
        raise TypeError("dbspec file path must be a string")
    with open(path, "rb") as handle:
        return read_dbspec_bytes(path, handle.read())


def read_dbspec_bytes(
    name: str, data: bytes
) -> tuple[str | None, list[DbspecDiagnostic]]:
    """Checks, before parsing, the bytes of a dbspec document file that the caller read under its own rules.
    `name` is the name the message uses to refer to the file. Bytes that do not start with DBSPEC_SIGNATURE
    give no text, only one `signature` diagnostic at line 1, column 1, with the message `<name> is
    not a dbspec document`; bytes that are not UTF-8 give one `encoding` diagnostic at the line and column of the first invalid byte
    with the message `<name> is not valid UTF-8`. Other
    bytes become text as they are, with no diagnostic."""
    if not isinstance(name, str):
        raise TypeError("dbspec file name must be a string")
    if not isinstance(data, (bytes, bytearray)):
        raise TypeError("dbspec file bytes must be bytes")
    # The signature is checked as bytes before decoding. A file of another format, or an empty file, gives a signature
    # diagnostic, not a header diagnostic.
    if (
        len(data) < len(DBSPEC_SIGNATURE)
        or data[: len(DBSPEC_SIGNATURE)] != DBSPEC_SIGNATURE
    ):
        return None, (
            DbspecDiagnostic("signature", 1, 1, f"{name} is not a dbspec document"),
        )
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        line, column = _invalid_utf8_position(data)
        return None, (
            DbspecDiagnostic("encoding", line, column, f"{name} is not valid UTF-8"),
        )
    return text, ()


def _invalid_utf8_position(data: bytes):
    """The line and column (in code points) of the first invalid UTF-8 byte. Lines are split on LF."""
    line = 1
    column = 1
    i = 0
    while i < len(data):
        size = _utf8_size(data, i)
        if size == 0:
            break
        if data[i] == 0x0A:
            line += 1
            column = 1
        else:
            column += 1
        i += size
    return line, column


def _utf8_size(data: bytes, i: int) -> int:
    """The number of bytes of the valid UTF-8 character starting at `i`, or 0 if the byte is invalid."""
    b = data[i]
    if b < 0x80:
        return 1
    if 0xC2 <= b <= 0xDF:
        size, low, high = 2, 0x80, 0xBF
    elif b == 0xE0:
        size, low, high = 3, 0xA0, 0xBF
    elif b == 0xED:
        size, low, high = 3, 0x80, 0x9F
    elif 0xE1 <= b <= 0xEF:
        size, low, high = 3, 0x80, 0xBF
    elif b == 0xF0:
        size, low, high = 4, 0x90, 0xBF
    elif 0xF1 <= b <= 0xF3:
        size, low, high = 4, 0x80, 0xBF
    elif b == 0xF4:
        size, low, high = 4, 0x80, 0x8F
    else:
        return 0
    if i + size > len(data):
        return 0
    if not low <= data[i + 1] <= high:
        return 0
    for k in range(2, size):
        if not 0x80 <= data[i + k] <= 0xBF:
            return 0
    return size
