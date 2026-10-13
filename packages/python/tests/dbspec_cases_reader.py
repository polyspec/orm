# Reads tests/dbspec/cases.json strictly, as the Go reader does (engine/dbspec/vectors_test.go decodeCaseVectors):
# every section and every field of the format must be present with its type, and a section or field the format does
# not name is refused. A refusal is a CasesError with the message "<file>: <location> <problem>". The client tests and
# the compare runner tests/dbspec/compare/python.py read cases.json with it.
import json
from pathlib import Path

NAME = 'tests/dbspec/cases.json'

# A field type is a scalar name, [type] for an array of type, or an object schema whose keys are the fields; a key
# ending in "?" is an optional field.
_ERROR = {'line': 'integer', 'column': 'integer', 'rule': 'string'}
_DOCUMENT = {'id': 'string', 'documents': 'linesMap', 'main': 'string', 'crlf?': 'boolean', 'mixed?': 'boolean'}
SCHEMA = {
    'version': 'integer',
    'note': 'string',
    'canonical': [_DOCUMENT],
    'normalize': [{**_DOCUMENT, 'canonical': 'lines'}],
    'invalid': [{**_DOCUMENT, 'errors': [_ERROR]}],
    'hashes': [{'id': 'string', 'documents': 'linesMap', 'manifestText': 'lines', 'schemaText': 'lines',
                'manifestHash': 'string', 'schemaHash': 'string'}],
    'sets': [{
        'id': 'string', 'documents': ['lines'], 'parsing': 'linesMap', 'errors': [_ERROR], 'external?': ['lines'],
        'manifest?': {'manifestText': 'lines', 'externalText': 'lines', 'schemaText': 'lines', 'created': 'lines',
                      'manifestHash': 'string', 'schemaHash': 'string'},
    }],
    'files': [{'id': 'string', 'path': 'string', 'errors': [_ERROR]}],
    'positions': [{'id': 'string', 'documents': 'linesMap', 'main': 'string',
                   'positions': [{'kind': 'string', 'path': 'lines', 'line': 'integer', 'column': 'integer'}]}],
}

_SCALARS = {'string': str, 'boolean': bool, 'integer': int}


class CasesError(ValueError):
    """A value of cases.json that the format refuses."""


def _at(location, key):
    return key if location == '' else f'{location}.{key}'


def _refuse(name, location, problem):
    raise CasesError(f'{name}: {location or "$"} {problem}')


def _check(name, value, kind, location):
    if isinstance(kind, str) and kind in _SCALARS:
        # bool is an int in Python, so the type is compared exactly.
        if type(value) is not _SCALARS[kind]:
            _refuse(name, location, 'is not an integer' if kind == 'integer' else f'is not a {kind}')
    elif kind == 'lines':
        _check(name, value, ['string'], location)
    elif kind == 'linesMap':
        if not isinstance(value, dict):
            _refuse(name, location, 'is not an object')
        for key, lines in value.items():
            _check(name, lines, 'lines', _at(location, key))
    elif isinstance(kind, list):
        if not isinstance(value, list):
            _refuse(name, location, 'is not an array')
        for i, item in enumerate(value):
            _check(name, item, kind[0], f'{location}[{i}]')
    else:
        if not isinstance(value, dict):
            _refuse(name, location, 'is not an object')
        fields = {key.removesuffix('?'): (field, key.endswith('?')) for key, field in kind.items()}
        for key, (_, optional) in fields.items():
            if not optional and key not in value:
                _refuse(name, _at(location, key), 'is missing')
        for key in sorted(value):
            if key not in fields:
                _refuse(name, _at(location, key), 'is not a known field')
        for key, (field, _) in fields.items():
            if key in value:
                _check(name, value[key], field, _at(location, key))
        if 'main' in fields and value['main'] not in value['documents']:
            _refuse(name, _at(_at(location, 'documents'), value['main']), 'is missing')


def check_cases(value, name=NAME):
    """Checks the parsed cases.json value and returns it; name names it in the errors."""
    _check(name, value, SCHEMA, '')
    if value['version'] != 1:
        _refuse(name, 'version', 'is not 1')
    for key, kind in SCHEMA.items():
        if isinstance(kind, list) and not value[key]:
            _refuse(name, key, 'is empty')
    return value


def read_cases():
    """Reads tests/dbspec/cases.json of the repository strictly."""
    with open(Path(__file__).resolve().parents[3] / 'tests' / 'dbspec' / 'cases.json', encoding='utf-8') as handle:
        return check_cases(json.load(handle))
