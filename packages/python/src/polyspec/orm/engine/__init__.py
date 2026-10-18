# engine: planner, dialect, schema, and checking behavior shared by all clients
# (docs/protocol.md).
from polyspec.orm import codes
from polyspec.orm.engine.dialect import dialect_of
from polyspec.orm.engine.model import (
    Entity,
    Field,
    RuntimeModel,
    entity_of,
    field_of,
    model_of_documents,
    model_of_manifest,
    parse_document_set,
    split_documents,
)
from polyspec.orm.engine.planner import Planner
from polyspec.orm.engine.validate import validate
from polyspec.orm.errors import OrmError

__all__ = [
    "Engine",
    "Entity",
    "Field",
    "RuntimeModel",
    "entity_of",
    "field_of",
    "model_of_documents",
    "model_of_manifest",
    "parse_document_set",
    "split_documents",
]


class Engine:
    """The statement compiler of one runtime model and one database (dialect mysql, postgres or
    sqlite): compile validates a request and returns its plan."""

    def __init__(self, model: RuntimeModel, dialect: str):
        d = dialect_of(dialect)
        if d is None:
            raise OrmError(codes.DIALECT_UNKNOWN, dialect)
        self.model = model
        self.dialect = dialect
        self._planner = Planner(model, d())

    @property
    def manifest_hash(self) -> str:
        return self.model.manifest_hash

    def compile(self, request: dict) -> dict:
        """Validates a request and returns its plan."""
        validate(self.model, request)
        return self._planner.compile(request)
