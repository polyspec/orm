# orm-gen: Python model 생성기.
#
#   orm-gen gen --schema <document.dbs>... [--use <document.dbs>...] --out <directory>
#               [--scan <file or directory>]... [--check]
import os
import sys

from polyspec.orm.dbspec import read_dbspec_file
from polyspec.orm.engine import model_of_documents, parse_document_set
from polyspec.orm.errors import OrmError
from polyspec.orm.generate.python import generate_models, render_models

USAGE = ('usage: orm-gen gen --schema <document.dbs>... [--use <document.dbs>...] '
         '--out <directory> [--scan <file or directory>]... [--check]')


class _UsageError(Exception):
    pass


def _read_document(path: str) -> str:
    """--schema 파일을 읽는다. signature가 없는 파일은 그 diagnostic의
    SCHEMA_INVALID이다."""
    text, diagnostics = read_dbspec_file(path)
    if text is None:
        d = diagnostics[0]
        raise OrmError('SCHEMA_INVALID', f'{d.line}:{d.column} {d.rule}: {d.message}')
    return text


def _gen(args) -> int:
    schemas = []
    uses = []
    out = ''
    scan = []
    check = False
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ('--schema', '-schema'):
            schemas.append(args[i + 1])
            i += 2
        elif arg in ('--use', '-use'):
            uses.append(args[i + 1])
            i += 2
        elif arg in ('--out', '-out'):
            out = args[i + 1]
            i += 2
        elif arg in ('--scan', '-scan'):
            scan.append(args[i + 1])
            i += 2
        elif arg in ('--check', '-check'):
            check = True
            i += 1
        elif arg in ('--help', '-h'):
            raise _UsageError(USAGE)
        else:
            raise _UsageError(f'orm-gen: unknown argument {arg}\n{USAGE}')
    if not schemas or not out:
        raise _UsageError(USAGE)
    model = model_of_documents(
        parse_document_set([_read_document(path) for path in schemas],
                           [_read_document(path) for path in uses]))
    if check:
        path = os.path.join(out, 'models.py')
        try:
            with open(path, encoding='utf-8') as handle:
                current = handle.read()
        except FileNotFoundError:
            print(f'missing: {path}')
            return 1
        if current == render_models(model, out, scan):
            return 0
        print(f'differs: {path}')
        return 1
    generate_models(model, out, scan)
    print(f"orm-gen: {len(model.entities)} models (manifest {model.manifest_hash}) "
          f"-> {out}/models.py", file=sys.stderr)
    return 0


def main(argv=None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args and args[0] == 'gen':
        try:
            return _gen(args[1:])
        except _UsageError as error:
            print(str(error), file=sys.stderr)
            return 2
        except IndexError:
            print(f'orm-gen: a flag is missing its value\n{USAGE}', file=sys.stderr)
            return 2
        except OrmError as error:
            print(f'orm-gen: {error}', file=sys.stderr)
            return 1
    print(USAGE, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main())
