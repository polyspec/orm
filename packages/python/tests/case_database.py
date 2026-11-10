# A new empty database of a dialect for one case, dropped when the case ends, as packages/ts/tests/case-database.mjs
# gives the TypeScript tests. MySQL and PostgreSQL need ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN (TEST_ENV); a
# missing variable fails the case.
import contextlib
import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
import uuid
from pathlib import Path

from . import testcase
from .server_database import server_database
from .statement_fault import required_dsn


@contextlib.contextmanager
def case_database(dialect: str, directory: str, prefix: str):
    """The DSN of a new empty database named by prefix and a random part: a SQLite file in directory, a MySQL or
    PostgreSQL database on the test server, or a corpus of no table that a flowmark server serves."""
    if dialect == "markdown":
        with case_corpus(None) as (dsn, _):
            yield dsn
        return
    if dialect == "sqlite":
        path = os.path.join(directory, f"{prefix}_{uuid.uuid4().hex}.sqlite3")
        with testcase.ending(f"removal of {path}", lambda: _remove_sqlite(path)):
            yield f"sqlite://{path}"
        return
    dsn = required_dsn(dialect)
    name = f"{prefix}_{uuid.uuid4().hex[:12]}"
    with server_database(dialect, dsn, name) as case_dsn:
        yield case_dsn


def _remove_sqlite(path: str) -> None:
    """Removes the SQLite case database at path and the files beside it that SQLite keeps while it is open."""
    for suffix in ("", "-wal", "-shm", "-journal"):
        with contextlib.suppress(FileNotFoundError):
            os.remove(path + suffix)


def case_server(database: str) -> str:
    """The server of a case database that the public dbspec calls take (DIA-203): the markdown corpus answers in SQLite's
    dialect, as its server; every other case database is its own server, MariaDB among them (DIA-200)."""
    return "sqlite" if database == "markdown" else database


CORPUS = "recipe"
LISTENING = re.compile(
    r"^\[serve\] listening on 127\.0\.0\.1:([0-9]+) for the corpus (.+)$"
)


@contextlib.contextmanager
def case_corpus(set_path: Path | None):
    """The markdown DSN and the directory of a new corpus of the dbspec set at set_path, or of a corpus of no table when
    set_path is None (a recipe of no fixture, or a case whose steps install it), served by the flowmark of FLOWMARK
    (FCV-3). The server stops and the corpus is removed when the block ends."""
    binary = os.environ.get("FLOWMARK", "")
    if not binary:
        raise AssertionError(
            "FLOWMARK is required; make orm-install-flowmark builds the version that tests/markdown/flowmark.version pins"
        )
    with tempfile.TemporaryDirectory(prefix="orm-corpus-") as parent:
        directory = Path(parent) / CORPUS
        dbspec = directory / "dbspec"
        dbspec.mkdir(parents=True)
        if set_path is not None:
            shutil.copyfile(set_path, dbspec / set_path.name)
            listed = json.loads(set_path.read_text(encoding="utf-8"))
            for document in [*listed["documents"], *listed.get("external", [])]:
                shutil.copyfile(set_path.parent / document, dbspec / document)
        subprocess.run(
            [binary, "install", str(directory)], check=True, capture_output=True
        )
        # A corpus of a test is disposable, as a test database server is: a commit does not wait for the disk. The events
        # that serve writes to its stderr go to a file beside the corpus, so they do not split the result line of a
        # test, and an assertion of this block states them.
        stderr = open(Path(parent) / "serve.stderr", "w+", encoding="utf-8")
        server = subprocess.Popen(
            [
                binary,
                "serve",
                str(directory),
                "--port",
                "0",
                "--synchronous",
                "off",
                "--tx-idle-ms",
                "600000",
            ],
            stdout=subprocess.PIPE,
            stderr=stderr,
            text=True,
        )

        def stop() -> None:
            server.kill()
            server.wait()
            shutil.rmtree(parent, ignore_errors=True)

        # A case that the harness ends (testcase.ending) runs no finally block: the server is ended and the corpus removed.
        with testcase.ending(f"stop of the corpus server {server.pid}", stop):
            try:
                line = server.stdout.readline().rstrip("\n")
                match = LISTENING.match(line)
                if match is None or match.group(2) != CORPUS:
                    stderr.seek(0)
                    raise AssertionError(
                        f"flowmark serve printed {line!r}, not its listening line; stderr:\n{stderr.read()}"
                    )
                token = json.loads(
                    (directory / ".flowmark" / "server.json").read_text(
                        encoding="utf-8"
                    )
                )["token"]
                yield (
                    f"markdown://127.0.0.1:{match.group(1)}/{CORPUS}?token={token}",
                    directory,
                )
            finally:
                server.send_signal(signal.SIGINT)
                server.wait()
                server.stdout.close()
                stderr.close()
