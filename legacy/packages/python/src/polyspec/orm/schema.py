# The schema values that the generated code holds: install creates the tables and registers the set.
from dataclasses import dataclass

__all__ = ["Schema"]


@dataclass(frozen=True)
class Schema:
    """The manifest of the generated model set."""

    manifest_text: str
    manifest_hash: str
    external_text: str = ""
