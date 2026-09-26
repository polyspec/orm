import { readFile } from 'node:fs/promises';
import { decode, encode } from '../../clients/typescript/dist/codec.js';
import * as orm from '../../clients/typescript/dist/index.js';

const fixture = JSON.parse(await readFile(new URL('../../contracts/fixtures/styled_column_states.json', import.meta.url), 'utf8'));
if (typeof orm.StyledValue !== 'function') throw new Error('StyledValue is required');

let tested = 0;
for (const entry of fixture.cases) {
  if (!Object.hasOwn(entry, 'stored_text') && !Object.hasOwn(entry, 'write_text')) {
    if (!['unselected', 'nonnull_sql_null'].includes(entry.id)) throw new Error(`${entry.id}: fixture case has no codec operation`);
    continue;
  }
  tested++;
  const styles = [entry.style];
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
}

console.log(`styled codec fixture: ${tested} cases passed`);
