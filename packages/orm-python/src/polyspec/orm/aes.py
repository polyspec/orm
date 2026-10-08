# AES column의 key 관리: version마다 key를 두고 row 단위로 갱신한다 (docs/codec.md "AES").
from typing import Callable, Mapping

from polyspec.orm.errors import OrmError

__all__ = ['AesKeyring']


def _is_safe_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) \
        and -9007199254740991 <= value <= 9007199254740991


class _RowCodec:
    """encode와 decode: codec의 host_encode/host_decode와 같은 contract다."""

    def encode(self, value, styles, key: str):
        from polyspec.orm.codec import host_encode
        return host_encode(value, styles, key)

    def decode(self, value, styles, key: str):
        from polyspec.orm.codec import host_decode
        return host_decode(value, styles, key)


class AesKeyring:
    """저장된 AES 값을 여는 key들을 version별로 담는다."""

    def __init__(self, keys: Mapping[int, str], current_version: int):
        if not _is_safe_integer(current_version) or current_version < 1 \
                or current_version not in keys:
            raise OrmError('CONFIG', f'AES version {current_version} is not declared')
        for version, key in keys.items():
            if not _is_safe_integer(version) or version < 1 or len(key) == 0:
                raise OrmError('CONFIG', f'AES version {version} has no key')
        self._keys = dict(keys)
        self.current_version = current_version

    def versions(self) -> list:
        return sorted(self._keys)

    def key(self, version: int) -> str:
        key = self._keys.get(version)
        if key is None:
            raise OrmError('CONFIG', f'AES version {version} is not declared')
        return key

    def rotate_row(self, row: dict, version_column: str, columns, target_version: int,
                   codec: object = None) -> dict:
        """row의 모든 AES column을 대상 version으로 다시 암호화한다."""
        codec = codec or _RowCodec()
        old_version = row.get(version_column)
        if not _is_safe_integer(old_version):
            raise OrmError('CODEC_DECODE', 'AES row version must be an integer')
        old_key = self.key(old_version)
        new_key = self.key(target_version)
        out = dict(row)
        for column in columns:
            if column.name not in row:
                raise OrmError('CONFIG', f'AES column {column.name} is missing')
            out[column.name] = codec.encode(
                codec.decode(row[column.name], column.styles, old_key),
                column.styles, new_key)
        out[version_column] = target_version
        return out
