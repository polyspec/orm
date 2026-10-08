"""Placeholders of the SQL that the engine writes for the Python drivers.

The engine writes `?` for MySQL and `$n` for PostgreSQL. PyMySQL formats a statement with `%s`, and psycopg with
`%s` or `%(name)s`. A marker inside a quoted string, a quoted identifier or a comment is text. The driver formats the
whole statement, so every `%` is written `%%`. A statement without values is passed unchanged with no arguments,
which the driver does not format.
"""

MYSQL_QUOTES = "'\"`"
POSTGRES_QUOTES = "'\""


def _scan(sql, quotes, mysql, marker):
    """Returns the statement with its markers replaced by marker(index) and the list of indexes in their order."""
    out = []
    found = []
    i = 0
    n = len(sql)
    while i < n:
        c = sql[i]
        if c in quotes:
            j = i + 1
            while j < n:
                if sql[j] == c:
                    if j + 1 < n and sql[j + 1] == c:
                        j += 2
                        continue
                    break
                j += 1
            out.append(sql[i:j + 1].replace('%', '%%'))
            i = j + 1
        elif sql.startswith('--', i) or (mysql and c == '#'):
            j = sql.find('\n', i)
            j = n if j < 0 else j
            out.append(sql[i:j].replace('%', '%%'))
            i = j
        elif sql.startswith('/*', i):
            j = sql.find('*/', i + 2)
            j = n if j < 0 else j + 2
            out.append(sql[i:j].replace('%', '%%'))
            i = j
        elif mysql and c == '?':
            found.append(len(found) + 1)
            out.append(marker(len(found)))
            i += 1
        elif not mysql and c == '$' and i + 1 < n and sql[i + 1].isdigit():
            j = i + 1
            while j < n and sql[j].isdigit():
                j += 1
            index = int(sql[i + 1:j])
            found.append(index)
            out.append(marker(index))
            i = j
        else:
            out.append('%%' if c == '%' else c)
            i += 1
    return ''.join(out), found


def for_mysql(sql, values):
    """Returns the statement for PyMySQL with its arguments tuple, or None when the statement has no values."""
    if not values:
        text, found = _scan(sql, MYSQL_QUOTES, True, lambda index: '?')
        if found:
            raise ValueError(f'the statement has {len(found)} markers and no values')
        return sql, None
    text, found = _scan(sql, MYSQL_QUOTES, True, lambda index: '%s')
    if len(found) != len(values):
        raise ValueError(f'the statement has {len(found)} markers and {len(values)} values')
    return text, tuple(values)


def for_postgres(sql, values):
    """Returns the statement for psycopg with its named arguments, or None when the statement has no values."""
    if not values:
        text, found = _scan(sql, POSTGRES_QUOTES, False, lambda index: '$%d' % index)
        if found:
            raise ValueError(f'the statement has markers {found} and no values')
        return sql, None
    text, found = _scan(sql, POSTGRES_QUOTES, False, lambda index: '%%(p%d)s' % index)
    if not found:
        raise ValueError(f'the statement has no markers for {len(values)} values')
    for index in found:
        if index < 1 or index > len(values):
            raise ValueError(f'the statement names value ${index}; it has {len(values)} values')
    return text, {f'p{index}': values[index - 1] for index in sorted(set(found))}
