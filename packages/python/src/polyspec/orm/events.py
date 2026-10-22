# Statement events (docs/operations/usage.md "Statement events"). The connection publishes
# one event per statement to the subscribers registered for every statement.
import time

from polyspec.orm import codes
from polyspec.orm.errors import OrmError

__all__ = ["StatementEvent", "Subscribers", "statement_kind"]


def statement_kind(sql: str) -> str:
    """The statement kind the planner wrote: the first word of the SQL. ALTER is the schema
    statement of a MySQL identity restart."""
    verb = sql.lstrip().split(" ", 1)[0].upper()
    if verb == "ALTER":
        return "schema"
    if verb == "INSERT":
        return "insert"
    if verb == "UPDATE":
        return "update"
    if verb == "DELETE":
        return "delete"
    return "select"


class StatementEvent:
    """One statement that the connection sent to the database."""

    __slots__ = ("sql", "binds", "kind", "tables", "elapsed", "transaction", "error")

    def __init__(
        self, sql: str, binds, kind: str, tables, elapsed: float, transaction, error
    ):
        self.sql = sql
        self.binds = binds
        self.kind = kind
        self.tables = tables
        self.elapsed = elapsed
        self.transaction = transaction
        self.error = error


class Subscribers:
    """The connection's subscriber list and transaction number. The list is made anew each time it changes,
    so a subscriber registered or removed during a publish does not change that publish's list."""

    def __init__(self):
        self.list: list = []
        self.transactions = 0

    def subscribe(self, subscriber):
        """Registers a subscriber and returns the removal function."""
        if not callable(subscriber):
            raise OrmError(
                codes.CONFIG,
                "subscribe takes a function that receives a statement event",
            )

        # Even if the same function is registered twice, removal removes only its own registration.
        def entry(event):
            return subscriber(event)

        self.list = [*self.list, entry]

        def unsubscribe():
            self.list = [s for s in self.list if s is not entry]

        return unsubscribe

    def next_transaction(self) -> int:
        """The number of the new outer transaction."""
        self.transactions += 1
        return self.transactions

    def send(self, kind: str, tables, transaction, binds, sql: str, run):
        """Runs one statement and publishes its event. If a subscriber throws,
        that error is passed on as SUBSCRIBER, not INTERNAL, in place of the earlier execution error."""
        start = time.perf_counter()
        error = None
        try:
            return run()
        except BaseException as failure:
            error = failure
            raise
        finally:
            if self.list:
                self._publish(
                    StatementEvent(
                        sql,
                        list(binds),
                        kind,
                        list(tables),
                        time.perf_counter() - start,
                        transaction,
                        error,
                    )
                )

    def _publish(self, event: StatementEvent) -> None:
        """Calls the subscribers in registration order. If one throws, the rest are not called
        and SUBSCRIBER is raised."""
        for subscriber in self.list:
            try:
                subscriber(event)
            except OrmError as failure:
                if failure.code == codes.SUBSCRIBER:
                    raise
                raise _subscriber_error(failure) from None
            except Exception as failure:  # noqa: BLE001 - a subscriber failure of any type is wrapped as the subscriber error
                raise _subscriber_error(failure) from None


def _subscriber_error(failure: Exception) -> OrmError:
    """A SUBSCRIBER error that carries the subscriber error's text in its message, with that error as its cause. The text of an OrmError is
    `<code>: <message>`, the same text the TypeScript client uses as `error.message`."""
    return OrmError(
        codes.SUBSCRIBER, f"statement event subscriber failed: {failure}", failure
    )
