# The waiting side of test_was_inserted.py: it updates the row that the parent transaction holds, so it blocks until the
# parent ends its transaction, then prints "done". Usage: python was_inserted_child.py <postgres dsn> <seq>
import sys

import psycopg

dsn, seq = sys.argv[1], int(sys.argv[2])
with psycopg.connect(dsn) as connection:
    connection.execute("UPDATE clock_event SET label = 'child' WHERE seq = %s", [seq])
print("done")
