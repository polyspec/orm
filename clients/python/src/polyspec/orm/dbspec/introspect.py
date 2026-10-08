# connection의 database를 dbspec 문서로 읽는다 (docs/dialects.md "Introspection").
# dialect reader가 고정된 수의 catalog query로 중립 catalog을 채우고, catalog이
# 문서를 만들어 parse한다.
from polyspec.orm.dbspec.introspect_catalog import Catalog, CatalogRow
from polyspec.orm.dbspec.introspect_mysql import read_mysql
from polyspec.orm.dbspec.introspect_postgres import read_postgres
from polyspec.orm.dbspec.introspect_sqlite import read_sqlite

__all__ = ['introspect_catalog', 'introspect_dbspec']

_READERS = {'mysql': read_mysql, 'postgres': read_postgres, 'sqlite': read_sqlite}


def introspect_dbspec(connection, dialect: str, name: str) -> dict:
    """연결의 현재 database(MySQL), 현재 schema(PostgreSQL) 또는 main
    database(SQLite)를 `name`의 dbspec 문서 하나로 읽는다. catalog query의 수는
    table 수에 의존하지 않는다. connection은 execute(sql, values)로 rows의 list를
    돌려주는 이 client의 연결이다."""
    if dialect not in _READERS:
        raise TypeError(f'unknown dbspec dialect {dialect}')
    if not isinstance(name, str):
        raise TypeError('dbspec document name must be a string')

    def query(sql: str) -> list:
        return [CatalogRow(sql, row) for row in connection.execute(sql, [])['rows']]

    return introspect_catalog(query, dialect, name)


def introspect_catalog(query, dialect: str, name: str) -> dict:
    """catalog query를 query로 보내 introspect_dbspec과 같은 문서를 읽는다."""
    if dialect not in _READERS:
        raise TypeError(f'unknown dbspec dialect {dialect}')
    catalog: Catalog = _READERS[dialect](query)
    document, unsupported = catalog.document(name)
    return {'document': document,
            'unsupported': [dict(u) for u in unsupported]}
