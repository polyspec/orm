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

from .server_database import server_database
from .statement_fault import required_dsn


@contextlib.contextmanager
def case_database(dialect: str, directory: str, prefix: str):
    """The DSN of a new empty database named by prefix and a random part: a SQLite file in directory, or a MySQL or
    PostgreSQL database on the test server."""
    if dialect == "sqlite":
        yield f"sqlite://{os.path.join(directory, f'{prefix}_{uuid.uuid4().hex}.sqlite3')}"
        return
    dsn = required_dsn(dialect)
    name = f"{prefix}_{uuid.uuid4().hex[:12]}"
    with server_database(dialect, dsn, name) as case_dsn:
        yield case_dsn


CORPUS = "recipe"
LISTENING = re.compile(
    r"^\[serve\] listening on 127\.0\.0\.1:([0-9]+) for the corpus (.+)$"
)


@contextlib.contextmanager
def case_corpus(set_path: Path):
    """The markdown DSN of a new corpus of the dbspec set at set_path, served by the flowmark of FLOWMARK (FCV-3). The
    server stops and the corpus is removed when the block ends."""
    binary = os.environ.get("FLOWMARK", "")
    if not binary:
        raise AssertionError(
            "FLOWMARK is required; make orm-install-flowmark builds the version that tests/markdown/flowmark.version pins"
        )
    with tempfile.TemporaryDirectory(prefix="orm-corpus-") as parent:
        directory = Path(parent) / CORPUS
        dbspec = directory / "dbspec"
        dbspec.mkdir(parents=True)
        shutil.copyfile(set_path, dbspec / set_path.name)
        for document in json.loads(set_path.read_text(encoding="utf-8"))["documents"]:
            shutil.copyfile(set_path.parent / document, dbspec / document)
        subprocess.run(
            [binary, "install", str(directory)], check=True, capture_output=True
        )
        server = subprocess.Popen(
            [binary, "serve", str(directory), "--port", "0"],
            stdout=subprocess.PIPE,
            text=True,
        )
        try:
            line = server.stdout.readline().rstrip("\n")
            match = LISTENING.match(line)
            if match is None or match.group(2) != CORPUS:
                raise AssertionError(
                    f"flowmark serve printed {line!r}, not its listening line"
                )
            token = json.loads(
                (directory / ".flowmark" / "server.json").read_text(encoding="utf-8")
            )["token"]
            yield f"markdown://127.0.0.1:{match.group(1)}/{CORPUS}?token={token}"
        finally:
            server.send_signal(signal.SIGINT)
            server.wait()
            server.stdout.close()
