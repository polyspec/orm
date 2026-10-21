# Key management for AES columns: one key per version, updated per row (docs/spec/codec.md "AES").
import re
from typing import Mapping

from polyspec.orm import codes
from polyspec.orm.errors import OrmError

__all__ = ["AesKeyring"]


def _is_safe_integer(value: object) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and -9007199254740991 <= value <= 9007199254740991
    )


def _stored_version(value) -> int:
    """The key version a stored row holds: a positive 32-bit integer, as an int or as its decimal text. Any other
    value is CODEC_DECODE; it is never coerced."""
    if isinstance(value, str) and re.fullmatch(r"[0-9]+", value):
        value = int(value)
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or not 1 <= value <= 2147483647
    ):
        raise OrmError(
            codes.CODEC_DECODE,
            f"aes version {value!r} is not a positive 32-bit integer",
        )
    return value


class _RowCodec:
    """encode and decode: same contract as codec's host_encode/host_decode."""

    def encode(self, value, styles, key: str):
        from polyspec.orm.codec import host_encode

        return host_encode(value, styles, key)

    def decode(self, value, styles, key: str):
        from polyspec.orm.codec import host_decode

        return host_decode(value, styles, key)


class AesKeyring:
    """Holds, per version, the keys that open stored AES values."""

    def __init__(self, keys: Mapping[int, str], current_version: int):
        if (
            not _is_safe_integer(current_version)
            or current_version < 1
            or current_version not in keys
        ):
            raise OrmError(
                codes.CONFIG, f"AES version {current_version} is not declared"
            )
        for version, key in keys.items():
            if not _is_safe_integer(version) or version < 1 or len(key) == 0:
                raise OrmError(codes.CONFIG, f"AES version {version} has no key")
        self._keys = dict(keys)
        self.current_version = current_version

    def versions(self) -> list:
        return sorted(self._keys)

    def key(self, version: int) -> str:
        key = self._keys.get(version)
        if key is None:
            raise OrmError(codes.CONFIG, f"AES version {version} is not declared")
        return key

    def rotate_row(
        self,
        row: dict,
        version_column: str,
        columns,
        target_version: int,
        codec: object = None,
    ) -> dict:
        """Re-encrypts every AES column of the row to the target version. A NULL AES value has no stored bytes: it is left
        as it is, and no version is read for it (COD-44). The version column is set only when a value was re-encrypted."""
        codec = codec or _RowCodec()
        if version_column not in row:
            raise OrmError(
                codes.INTERNAL, f"AES version column {version_column} is missing"
            )
        out = dict(row)
        old_key = None
        new_key = None
        for column in columns:
            if column.name not in row:
                raise OrmError(codes.INTERNAL, f"AES column {column.name} is missing")
            value = row[column.name]
            if value is None:
                continue
            if old_key is None:
                old_key = self.key(_stored_version(row[version_column]))
                new_key = self.key(target_version)
            out[column.name] = codec.encode(
                codec.decode(value, column.styles, old_key),
                column.styles,
                new_key,
            )
        if old_key is not None:
            out[version_column] = target_version
        return out
