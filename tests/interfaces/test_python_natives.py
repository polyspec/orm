# The python native entries of the entity rules of contracts/interfaces.json: each names a symbol of
# the Python snapshot (contracts/symbols/python.json), its signature equals that snapshot value
# without spaces, and its parameters and return type are the python entries of the common input and
# output tables of contracts/validate.go, as contracts/validate.go and tests/interfaces/check require
# of the native entries of the other clients.
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def compact(text: str) -> str:
    return ''.join(text.split())


def python_table(validate: str, name: str) -> dict:
    """The python entry of each key of a table of contracts/validate.go (outputs or inputs)."""
    start = validate.index(f'var {name} = map[string]map[string]string{{')
    end = validate.index('\n}\n', start)
    table = {}
    for match in re.finditer(r'^\s*"([^"]*)":\s*\{(.*)\},?\s*$', validate[start:end], re.M):
        python = re.search(r'"python":\s*"((?:[^"\\]|\\.)*)"', match.group(2))
        table[match.group(1)] = python.group(1) if python else None
    return table


def python_parts(signature: str):
    """The parameters and return type of a python native signature, as validate.go reads them."""
    sig = compact(signature)
    begin = sig.index('(')
    end = sig.rindex(')')
    params, ret = sig[begin + 1:end], sig[end + 1:].replace('->', '', 1)
    if params.startswith('self,'):
        params = params[len('self,'):]
    elif params == 'self':
        params = ''
    return params, ret


class EntityRuleNativesTest(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((ROOT / 'contracts' / 'interfaces.json').read_text(encoding='utf-8'))
        self.symbols = json.loads((ROOT / 'contracts' / 'symbols' / 'python.json').read_text(encoding='utf-8'))
        validate = (ROOT / 'contracts' / 'validate.go').read_text(encoding='utf-8')
        self.outputs = python_table(validate, 'outputs')
        self.inputs = python_table(validate, 'inputs')

    def test_every_entity_rule_names_a_python_method_of_the_snapshot(self):
        rules = [r for r in self.manifest['rules'] if r['for'] == 'entity']
        self.assertEqual(len(rules), 22)
        for rule in rules:
            native = rule['native'].get('python')
            self.assertIsNotNone(native, f"{rule['id']} has no python native")
            self.assertIn(native['symbol'], self.symbols, rule['id'])
            self.assertEqual(compact(self.symbols[native['symbol']]), compact(native['signature']), rule['id'])
            params, ret = python_parts(native['signature'])
            self.assertEqual(ret, self.outputs[rule['output']], f"{rule['id']} return type")
            self.assertEqual(params, self.inputs[','.join(rule['inputs'])], f"{rule['id']} parameters")


if __name__ == '__main__':
    unittest.main()
