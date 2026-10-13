"""Driver conversions of the Python client for DECIMAL and NUMERIC cells.

The TypeScript and PHP clients receive these cells as the exact text of the database. PyMySQL and psycopg return
decimal.Decimal, which the codec does not read. The conversions here return the text of the cell instead.
"""


def _text(value):
    return value.decode('ascii') if isinstance(value, (bytes, bytearray)) else value


def mysql_conversions():
    """Returns the PyMySQL conversions with DECIMAL and NEWDECIMAL cells as text."""
    from pymysql.constants import FIELD_TYPE
    from pymysql.converters import conversions

    table = dict(conversions)
    table[FIELD_TYPE.DECIMAL] = _text
    table[FIELD_TYPE.NEWDECIMAL] = _text
    return table


NUMERIC_OID = 1700


def postgres_loaders(adapters):
    """Registers the psycopg text loader for NUMERIC cells on the adapters of a connection."""
    from psycopg.postgres import types
    from psycopg.types.string import TextLoader

    adapters.register_loader(types['numeric'].oid, TextLoader)
    return adapters
