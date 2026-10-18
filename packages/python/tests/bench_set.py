# The install of the bench set for the tests: the bench set (contracts/fixtures/bench/dbspec-set.json) uses the table
# shared_note of its external document bench_shared.dbs, which must exist before the set installs (docs/dbspec.md
# "External documents"), so the external document is installed first as its own set, as scripts/bench-db.mts does.
from pathlib import Path

from polyspec.orm import Schema
from polyspec.orm.dbspec import dbspec_manifest, parse_dbspec, read_dbspec_file
from polyspec.orm.models import models

_PATH = Path(__file__).resolve().parents[3] / "contracts" / "fixtures" / "bench" / "bench_shared.dbs"


def bench_shared() -> Schema:
    """The schema value of bench_shared.dbs, as the set that owns it would generate it."""
    text, diagnostics = read_dbspec_file(str(_PATH))
    if text is None:
        raise AssertionError(f"{_PATH}: {diagnostics}")
    document, _positions, diagnostics = parse_dbspec(text, {})
    if document is None:
        raise AssertionError(f"{_PATH}: {diagnostics}")
    manifest, diagnostics = dbspec_manifest([document])
    if manifest is None:
        raise AssertionError(f"{_PATH}: {diagnostics}")
    return Schema(manifest.manifest_text, manifest.manifest_hash)


def install_bench(db) -> None:
    """Installs the external document of the bench set, then the bench set, on the database of db."""
    db.utils().schema().install(bench_shared())
    db.utils().schema().install(models.SCHEMA)
