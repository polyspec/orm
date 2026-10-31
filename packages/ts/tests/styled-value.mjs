import { readFile } from 'node:fs/promises';
import { decode, encode } from '../dist/codec.js';
import * as orm from '../dist/index.js';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

const fixture = JSON.parse(await readFile(new URL('../../../contracts/fixtures/styled_column_states.json', import.meta.url), 'utf8'));
if (typeof orm.StyledValue !== 'function') throw new Error('the TypeScript client exports no StyledValue class');

// Requirements: COD-17, COD-18, COD-19, COD-20, COD-24, COD-25, COD-26, COD-27, COD-32.
for (const entry of fixture.cases) caseTest(entry.id, COMPUTE, () => {
  if (!Object.hasOwn(entry, 'stored_text') && !Object.hasOwn(entry, 'write_text')) {
    if (!['unselected', 'nonnull_sql_null'].includes(entry.id)) throw new Error(`${entry.id}: fixture case has no codec operation`);
    return;
  }
  // The fixture names the Mermaid styles; json and jsons are both the ordered_json stage.
  const styles = [entry.style === 'json' || entry.style === 'jsons' ? 'ordered_json' : entry.style];
  if (Object.hasOwn(entry, 'stored_text')) {
    try {
      const decoded = decode(styles, entry.stored_text);
      if (entry.error) throw new Error(`${entry.id}: decode accepted invalid storage`);
      if (!(decoded instanceof orm.StyledValue) || JSON.stringify(decoded) !== JSON.stringify(entry.getter)) {
        throw new Error(`${entry.id}: decoded state differs from fixture`);
      }
    } catch (error) {
      if (!entry.error || error.code !== entry.error) throw error;
    }
  }
  if (Object.hasOwn(entry, 'write_text')) {
    const state = entry.input.kind === 'sql-null' ? orm.StyledValue.sqlNull() : orm.StyledValue.value(entry.input.value);
    const encoded = encode(styles, state);
    if (encoded !== entry.write_text) throw new Error(`${entry.id}: encoded cell differs from fixture`);
  }
});
