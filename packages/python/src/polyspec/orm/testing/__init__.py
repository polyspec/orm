# Python client의 test entry point다(docs/protocol.md "Test faults"). pyproject.toml의
# [tool.setuptools.packages.find]가 이 package를 배포에서 빼므로, process는 client의 source
# tree(packages/python/src)를 path에 둘 때만 이것을 import한다. package entry point
# polyspec.orm은 이것을 export하지 않는다.
from polyspec.orm.database import Db, _arm_rollback_fault, _arm_statement_fault

__all__ = ['fail_next_rollback', 'fail_next_statement']


def fail_next_rollback(db: Db) -> None:
    """db의 connection에 test fault를 설정한다: callback이 실패한 다음 transaction의
    rollback은 실행된 뒤 rollback 오류로 FAULT 오류를 보고하므로, transaction은
    callback 오류와 fault를 가진 ROLLBACK 오류를 던진다. fault는 그런 rollback이
    소비할 때까지 남는다."""
    _arm_rollback_fault(db)


def fail_next_statement(db: Db, code: str, message: str) -> None:
    """db의 connection에 statement fault를 설정한다: 다음 statement runner의 statement는 database에
    보내지 않고 code와 message의 OrmError로 실패한다. transaction control statement는 소비하지 않는다.
    code나 message가 비어 있으면 ValueError이며 아무것도 설정하지 않는다."""
    if not isinstance(code, str) or not code:
        raise ValueError('fail_next_statement needs a nonempty code')
    if not isinstance(message, str) or not message:
        raise ValueError('fail_next_statement needs a nonempty message')
    _arm_statement_fault(db, code, message)
