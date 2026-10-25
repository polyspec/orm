import unittest
from unittest.mock import patch

from packages.python.tests.testcase import COMPUTE, main
from polyspec.orm.dbspec.introspect_catalog import Catalog
from polyspec.orm.dbspec.mermaid import import_mermaid


DIAGRAM = "erDiagram\n    account {\n        i64 id PK\n    }\n"


class MermaidErrorBoundaryTest(unittest.TestCase):
    deadline = COMPUTE

    def test_unexpected_catalog_error_keeps_identity(self):
        cause = RuntimeError("unexpected catalog failure")

        def fail_document(_catalog, _name):
            raise cause

        with patch.object(Catalog, "document", fail_document):
            with self.assertRaises(RuntimeError) as caught:
                import_mermaid(DIAGRAM, "valid")
        self.assertIs(caught.exception, cause)


if __name__ == "__main__":
    main()
