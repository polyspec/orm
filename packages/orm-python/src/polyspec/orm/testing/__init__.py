# Python client의 test entry point다(docs/protocol.md "Test faults"). pyproject.toml의
# [tool.setuptools.packages.find]가 이 package를 배포에서 빼므로, process는 client의 source
# tree(packages/orm-python/src)를 path에 둘 때만 이것을 import한다. package entry point
# polyspec.orm은 이것을 export하지 않는다.
from polyspec.orm.database import Db, _arm_rollback_fault

__all__ = ['fail_next_rollback']


def fail_next_rollback(db: Db) -> None:
    """db의 connection에 test fault를 설정한다: callback이 실패한 다음 transaction의
    rollback은 실행된 뒤 rollback 오류로 FAULT 오류를 보고하므로, transaction은
    callback 오류와 fault를 가진 ROLLBACK 오류를 던진다. fault는 그런 rollback이
    소비할 때까지 남는다."""
    _arm_rollback_fault(db)
