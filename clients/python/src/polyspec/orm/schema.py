# 생성 code가 담는 schema 값: install이 table을 만들고 집합을 등록한다.
from dataclasses import dataclass

__all__ = ['Schema']


@dataclass(frozen=True)
class Schema:
    """생성된 model 집합의 manifest."""

    manifest_text: str
    manifest_hash: str
    external_text: str = ''
