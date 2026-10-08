# statement event다 (docs/usage.md "Statement events"). 연결은 자기가 보내는
# 모든 statement마다 event 하나를 등록한 subscriber에게 publish한다.
import time

from polyspec.orm.errors import OrmError

__all__ = ['StatementEvent', 'Subscribers', 'statement_kind']


def statement_kind(sql: str) -> str:
    """planner가 쓴 statement의 kind다: SQL의 첫 단어다."""
    verb = sql.lstrip().split(' ', 1)[0].upper()
    if verb == 'INSERT':
        return 'insert'
    if verb == 'UPDATE':
        return 'update'
    if verb == 'DELETE':
        return 'delete'
    return 'select'


class StatementEvent:
    """연결이 database에 보낸 statement 하나."""

    __slots__ = ('sql', 'binds', 'kind', 'tables', 'elapsed', 'transaction', 'error')

    def __init__(self, sql: str, binds, kind: str, tables, elapsed: float,
                 transaction, error):
        self.sql = sql
        self.binds = binds
        self.kind = kind
        self.tables = tables
        self.elapsed = elapsed
        self.transaction = transaction
        self.error = error


class Subscribers:
    """연결의 subscriber 목록과 transaction 번호다. 목록은 바꿀 때마다 새로
    만들므로 publish 중에 등록하거나 해제해도 그 publish의 목록은 그대로다."""

    def __init__(self):
        self.list: list = []
        self.transactions = 0

    def subscribe(self, subscriber):
        """subscriber를 등록하고 해제 함수를 돌려준다."""
        if not callable(subscriber):
            raise OrmError('CONFIG', 'subscribe takes a function that receives a '
                                     'statement event')
        # 같은 함수를 두 번 등록해도 해제는 자기 등록 하나만 지운다.
        def entry(event):
            return subscriber(event)
        self.list = [*self.list, entry]

        def unsubscribe():
            self.list = [s for s in self.list if s is not entry]
        return unsubscribe

    def next_transaction(self) -> int:
        """새 바깥 transaction의 번호다."""
        self.transactions += 1
        return self.transactions

    def send(self, kind: str, tables, transaction, binds, sql: str, run):
        """statement 하나를 실행하고 그 event를 publish한다. subscriber가 던지면
        그 오류를 앞선 실행 오류 대신 INTERNAL이 아닌 SUBSCRIBER로 넘긴다."""
        start = time.perf_counter()
        error = None
        try:
            return run()
        except BaseException as failure:  # noqa: BLE001
            error = failure
            raise
        finally:
            if self.list:
                self._publish(StatementEvent(sql, list(binds), kind, list(tables),
                                             time.perf_counter() - start, transaction,
                                             error))

    def _publish(self, event: StatementEvent) -> None:
        """subscriber를 등록 순서로 부른다. 하나가 던지면 나머지는 부르지 않고
        SUBSCRIBER를 던진다."""
        for subscriber in self.list:
            try:
                subscriber(event)
            except OrmError as failure:
                if failure.code == 'SUBSCRIBER':
                    raise
                raise _subscriber_error(failure) from None
            except Exception as failure:  # noqa: BLE001
                raise _subscriber_error(failure) from None


def _subscriber_error(failure) -> OrmError:
    message = failure.message if isinstance(failure, OrmError) else str(failure)
    return OrmError('SUBSCRIBER', f'statement event subscriber failed: {message}')
