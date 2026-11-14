# The waiting side of test_was_inserted.py: it updates the row that the parent transaction holds, so it blocks until the
# parent ends its transaction, then prints "done". Its session reports its lock waits (T475): with deadlock_timeout 1 ms,
# log_lock_waits on and client_min_messages log, the server sends it the LOG message "still waiting for" once the update
# has waited 1 ms for the lock, while it still waits, and the child prints "waiting" on that message.
# Usage: python was_inserted_child.py <postgres dsn> <seq>
import sys

import psycopg

dsn, seq = sys.argv[1], int(sys.argv[2])
reported = []


def report(diagnostic):
    if not reported and "still waiting for" in (diagnostic.message_primary or ""):
        reported.append(True)
        print("waiting", flush=True)


with psycopg.connect(dsn) as connection:
    for setting in ("SET deadlock_timeout = '1ms'", "SET log_lock_waits = on", "SET client_min_messages = log"):
        connection.execute(setting)
    connection.add_notice_handler(report)
    connection.execute("UPDATE clock_event SET label = 'child' WHERE seq = %s", [seq])
print("done")
