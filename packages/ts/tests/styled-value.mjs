import { readFile } from 'node:fs/promises';
import { decode, encode } from '../dist/codec.js';
import * as orm from '../dist/index.js';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

const fixture = JSON.parse(await readFile(new URL('../../../contracts/fixtures/styled_column_states.json', import.meta.url), 'utf8'));
if (typeof orm.StyledValue !== 'function') throw new Error('the TypeScript client exports no StyledValue class');

// The fixture names the Mermaid styles; json and jsons are both the ordered_json stage.
const stage = style => (style === 'json' || style === 'jsons' ? 'ordered_json' : style);

// The setter of a styled column (COD-20, COD-73) runs on a column of each value stage, nullable and not.
const stages = ['ordered_json', 'serialize', 'yaml'];
const columnOf = (style, nullable) => `${stage(style)}_${nullable ? 'nullable' : 'required'}`;
const parsed = orm.parseDbspec([
  'dbspec 1 styled_states',
  '',
  'table cell {',
  '  id i64 identity',
  ...stages.flatMap(style => [`  ${columnOf(style, true)} text null`, `  ${columnOf(style, false)} text`]),
  '  primary key (id)',
  '  settings {',
  ...stages.flatMap(style => [true, false].map(nullable => `    codec ${columnOf(style, nullable)} ${style}`)),
  '  }',
  '}',
  '',
].join('\n'), {});
if (parsed.diagnostics.length > 0) throw new Error(`the setter model does not parse: ${JSON.stringify(parsed.diagnostics)}`);
const { manifest } = orm.dbspecManifest([parsed.document]);
const model = orm.registerModel(manifest.manifestText, manifest.manifestHash);
const entity = model.entities.get('cell');
if (entity === undefined) throw new Error('the setter model has no cell entity');
const newCore = () => new orm.Core({ model, entity, create: core => ({ [orm.CORE]: core }) });

/** What f throws, or null when it completes. */
function thrown(f) {
  try {
    f();
    return null;
  } catch (error) {
    return error;
  }
}

// Requirements: COD-17, COD-18, COD-19, COD-20, COD-24, COD-25, COD-26, COD-27, COD-32, COD-70, COD-73.
for (const entry of fixture.cases) caseTest(entry.id, COMPUTE, () => {
  if (!['stored_text', 'input', 'getter_error'].some(key => Object.hasOwn(entry, key))) throw new Error(`${entry.id}: fixture case has no codec operation`);
  const column = columnOf(entry.style, entry.nullable);
  if (Object.hasOwn(entry, 'getter_error')) {
    // A styled column that the row neither selected nor assigned refuses to be read.
    const error = thrown(() => newCore().column(column));
    if (error?.code !== entry.getter_error) throw new Error(`${entry.id}: getter ${error?.message ?? 'returned a value'}, want ${entry.getter_error}`);
  }
  if (Object.hasOwn(entry, 'stored_text')) {
    try {
      const decoded = decode([stage(entry.style)], entry.stored_text);
      if (entry.error) throw new Error(`${entry.id}: decode accepted invalid storage`);
      if (!(decoded instanceof orm.StyledValue) || JSON.stringify(decoded) !== JSON.stringify(entry.getter)) {
        throw new Error(`${entry.id}: decoded state differs from fixture`);
      }
    } catch (error) {
      if (!entry.error || error.code !== entry.error) throw error;
    }
  }
  if (Object.hasOwn(entry, 'input')) {
    const state = entry.input.kind === 'sql-null' ? orm.StyledValue.sqlNull() : orm.StyledValue.value(entry.input.value);
    const error = thrown(() => newCore().setValue(column, state));
    // The error of a case without a stored text is the setter's, with its whole text where the case states a message.
    if (Object.hasOwn(entry, 'error') && !Object.hasOwn(entry, 'stored_text')) {
      if (error === null) throw new Error(`${entry.id}: the setter accepted the value, want ${entry.error}`);
      if (error.code !== entry.error) throw error;
      if (Object.hasOwn(entry, 'message') && error.message !== entry.message) {
        throw new Error(`${entry.id}: setter error ${JSON.stringify(error.message)}, want ${JSON.stringify(entry.message)}`);
      }
    } else if (error !== null) throw error;
    if (Object.hasOwn(entry, 'write_text')) {
      const encoded = encode([stage(entry.style)], state);
      if (encoded !== entry.write_text) throw new Error(`${entry.id}: encoded cell differs from fixture`);
    }
  } else if (Object.hasOwn(entry, 'write_text')) throw new Error(`${entry.id}: fixture case writes a cell without an input`);
});
