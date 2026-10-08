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


class ConnectionAndToolRuleNativesTest(unittest.TestCase):
    """The rules of the connection (Db), the utilities (Utils), the schema tools (SchemaUtils) and the AES
    tools (AesUtils) name a Python method each, with the same snapshot and table checks as the entity rules."""

    PREFIXES = ('Db.', 'Utils.', 'SchemaUtils.', 'AesUtils.')

    def setUp(self):
        self.manifest = json.loads((ROOT / 'contracts' / 'interfaces.json').read_text(encoding='utf-8'))
        self.symbols = json.loads((ROOT / 'contracts' / 'symbols' / 'python.json').read_text(encoding='utf-8'))
        validate = (ROOT / 'contracts' / 'validate.go').read_text(encoding='utf-8')
        self.outputs = python_table(validate, 'outputs')
        self.inputs = python_table(validate, 'inputs')

    def test_every_connection_and_tool_rule_names_a_python_method_of_the_snapshot(self):
        rules = [r for r in self.manifest['rules'] if r['for'] == 'once' and r['id'].startswith(self.PREFIXES)]
        self.assertEqual(len(rules), 13)
        for rule in rules:
            native = rule['native'].get('python')
            self.assertIsNotNone(native, f"{rule['id']} has no python native")
            self.assertIn(native['symbol'], self.symbols, rule['id'])
            self.assertEqual(compact(self.symbols[native['symbol']]), compact(native['signature']), rule['id'])
            params, ret = python_parts(native['signature'])
            self.assertEqual(ret, self.outputs[rule['output']], f"{rule['id']} return type")
            self.assertEqual(params, self.inputs[','.join(rule['inputs'])], f"{rule['id']} parameters")


class DbspecRuleNativesTest(unittest.TestCase):
    """The dbspec rules name a Python function each; the groups are checked in turn."""

    GROUPS = {
        'files_parse_emit_render_introspect': [
            'Dbspec.readFile', 'Dbspec.readBytes', 'Dbspec.parse', 'Dbspec.emit',
            'Dbspec.manifest', 'Dbspec.render', 'Dbspec.introspect', 'Dbspec.externalDifferences'],
        'plans_comparison_upgrade': [
            'Dbspec.parsePlan', 'Dbspec.emitPlan', 'Dbspec.chain', 'Dbspec.diff',
            'Dbspec.compareSchemas', 'Dbspec.installedDifferences', 'Dbspec.addTablesAndColumnsSteps',
            'Dbspec.planSteps'],
        'apply_recovery_rollback_finalize_mermaid': [
            'Dbspec.apply', 'Dbspec.recover', 'Dbspec.rollback', 'Dbspec.finalize',
            'Dbspec.exportMermaid', 'Dbspec.importMermaid'],
    }

    def setUp(self):
        self.manifest = json.loads((ROOT / 'contracts' / 'interfaces.json').read_text(encoding='utf-8'))
        self.symbols = json.loads((ROOT / 'contracts' / 'symbols' / 'python.json').read_text(encoding='utf-8'))
        validate = (ROOT / 'contracts' / 'validate.go').read_text(encoding='utf-8')
        self.outputs = python_table(validate, 'outputs')
        self.inputs = python_table(validate, 'inputs')

    def check_group(self, ids):
        rules = {r['id']: r for r in self.manifest['rules']}
        for rule_id in ids:
            rule = rules[rule_id]
            native = rule['native'].get('python')
            self.assertIsNotNone(native, f'{rule_id} has no python native')
            self.assertIn(native['symbol'], self.symbols, rule_id)
            self.assertEqual(compact(self.symbols[native['symbol']]), compact(native['signature']), rule_id)
            params, ret = python_parts(native['signature'])
            self.assertEqual(ret, self.outputs[rule['output']], f'{rule_id} return type')
            self.assertEqual(params, self.inputs[','.join(rule['inputs'])], f'{rule_id} parameters')

    def test_files_parse_emit_render_introspect_group(self):
        self.check_group(self.GROUPS['files_parse_emit_render_introspect'])

    def test_plans_comparison_upgrade_group(self):
        self.check_group(self.GROUPS['plans_comparison_upgrade'])

    def test_apply_recovery_rollback_finalize_mermaid_group(self):
        self.check_group(self.GROUPS['apply_recovery_rollback_finalize_mermaid'])


class RecordNativesTest(unittest.TestCase):
    """The python native of each record of contracts/interfaces.json is a TypedDict of
    clients/python/src/polyspec/orm/ir.py, and its #wire symbol of the snapshot carries the fields of the
    record, with the fields of its base expanded (the @flatten of the extractor)."""

    PREFIX = 'clients/python/src/polyspec/orm/ir.py::'

    def setUp(self):
        self.manifest = json.loads((ROOT / 'contracts' / 'interfaces.json').read_text(encoding='utf-8'))
        self.symbols = json.loads((ROOT / 'contracts' / 'symbols' / 'python.json').read_text(encoding='utf-8'))
        self.records = {record['id']: record for record in self.manifest['records']}

    def expected(self, record: dict) -> dict:
        fields = dict(self.expected(self.records[record['extends']])) if record.get('extends') else {}
        fields.update(record['fields'])
        return fields

    def actual(self, record: dict) -> dict:
        wire = json.loads(self.symbols[record['native']['python'] + '#wire'])
        base = wire.pop('@flatten', None)
        fields = dict(self.actual(self.records[base])) if base else {}
        fields.update(wire)
        return fields

    def test_every_record_names_a_typed_dict_of_the_snapshot(self):
        self.assertEqual(len(self.records), 19)
        for record in self.manifest['records']:
            native = record['native'].get('python')
            self.assertIsNotNone(native, f"{record['id']} has no python native")
            self.assertEqual(native, self.PREFIX + record['id'], record['id'])
            self.assertIn(native, self.symbols, record['id'])
            self.assertIn(native + '#wire', self.symbols, record['id'])

    def test_every_record_wire_matches_its_fields(self):
        for record in self.manifest['records']:
            self.assertEqual(self.actual(record), self.expected(record), record['id'])


class OwnerNativesTest(unittest.TestCase):
    """The python native of each owner of contracts/interfaces.json names a Python class of the snapshot,
    and its fields equal the #field symbols of that class in the snapshot."""

    GROUPS = {
        'page_and_aes_rotation_status': ('Page', 'AESRotationStatus'),
        'diagnostic_manifest_and_plan': ('DbspecDiagnostic', 'DbspecManifest', 'DbspecPlan', 'DbspecPlanStep',
                                         'DbspecEffect', 'DbspecNullCheck', 'DbspecChange'),
        'differences_renames_and_apply': ('DbspecDifference', 'DbspecUnsupported', 'DbspecTableRename',
                                          'DbspecColumnRename', 'DbspecColumnName', 'DbspecApplyEvent',
                                          'DbspecApplyError'),
    }

    def setUp(self):
        self.manifest = json.loads((ROOT / 'contracts' / 'interfaces.json').read_text(encoding='utf-8'))
        self.symbols = json.loads((ROOT / 'contracts' / 'symbols' / 'python.json').read_text(encoding='utf-8'))
        self.owners = {owner['id']: owner for owner in self.manifest['owners']}

    def check_group(self, ids):
        for owner_id in ids:
            native = self.owners[owner_id]['native'].get('python')
            self.assertIsNotNone(native, f'{owner_id} has no python native')
            symbol = native['symbol']
            self.assertIn(symbol, self.symbols, owner_id)
            prefix = symbol + '#field.'
            actual = sorted(key[len(prefix):] for key in self.symbols if key.startswith(prefix))
            self.assertEqual(actual, sorted(native['fields']), owner_id)

    def test_page_and_aes_rotation_status_group(self):
        self.check_group(self.GROUPS['page_and_aes_rotation_status'])

    def test_diagnostic_manifest_and_plan_group(self):
        self.check_group(self.GROUPS['diagnostic_manifest_and_plan'])

    def test_differences_renames_and_apply_group(self):
        self.check_group(self.GROUPS['differences_renames_and_apply'])


if __name__ == '__main__':
    unittest.main()
