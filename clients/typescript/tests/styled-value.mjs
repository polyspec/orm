import { readFile } from 'node:fs/promises';
import { decode, encode } from '../dist/codec.js';
import * as orm from '../dist/index.js';

const fixture = JSON.parse(await readFile(new URL('../../../contracts/fixtures/styled_column_states.json', import.meta.url), 'utf8'));
if (typeof orm.StyledValue !== 'function') throw new Error('StyledValue is required');

let tested = 0;
for (const entry of fixture.cases) {
  if (!Object.hasOwn(entry, 'stored_text') && !Object.hasOwn(entry, 'write_text')) {
    if (!['unselected', 'nonnull_sql_null'].includes(entry.id)) throw new Error(`${entry.id}: fixture case has no codec operation`);
    continue;
  }
  tested++;
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
}

const cases = Object.fromEntries(fixture.cases.map(entry => [entry.id, entry]));
const probeText = 'dbspec 1 styled_probe\n\ntable styled_probe {\n  seq i64\n  payload text\n  primary key (seq)\n  settings {\n    codec payload ordered_json\n  }\n}\n';
const { manifest } = orm.dbspecManifest([orm.parseDbspec(probeText, {}).document]);
const model = orm.registerModel(manifest.manifestText, manifest.manifestHash);
const probe = new orm.Core({ model, entity: model.entities.get('styled_probe'), create: () => { throw new Error('not used'); } });
try { probe.column('payload'); throw new Error('unselected getter was accepted'); }
catch (error) { if (error.code !== cases.unselected.getter_error) throw error; }
try { probe.setValue('payload', orm.StyledValue.sqlNull()); throw new Error('non-null column accepted SQL NULL'); }
catch (error) { if (error.code !== cases.nonnull_sql_null.error) throw error; }
probe.setValue('payload', orm.StyledValue.value(null));
if (JSON.stringify(probe.column('payload')) !== JSON.stringify(cases.nonnull_value_null.getter)) {
  throw new Error('non-null column rejected JSON literal null');
}

function rejectsLostOutput(label, read) {
  try { read(); throw new Error(`${label}: input was silently omitted`); }
  catch (error) { if (error.code !== 'CODEC_ENCODE') throw error; }
}
rejectsLostOutput('styled toJSON', () => orm.StyledValue.value({ missing: undefined }).toJSON());
rejectsLostOutput('nested styled JSON.stringify', () => JSON.stringify(orm.StyledValue.value({ nested: { missing: undefined } })));
rejectsLostOutput('styled array gap', () => orm.StyledValue.value([, 'present']).toJSON());
const hidden = Object.defineProperty({ present: 1 }, 'missing', { value: 2 });
rejectsLostOutput('hidden styled member', () => orm.StyledValue.value(hidden).toJSON());
const keyed = { present: 1, [Symbol('missing')]: 2 };
rejectsLostOutput('symbol styled member', () => orm.StyledValue.value(keyed).toJSON());
rejectsLostOutput('map styled value', () => orm.StyledValue.value(new Map([['missing', 1]])).toJSON());
const extra = ['present'];
extra.missing = 2;
rejectsLostOutput('extra styled array member', () => orm.StyledValue.value(extra).toJSON());
const changed = { present: 1 };
const state = orm.StyledValue.value(changed);
changed.missing = undefined;
rejectsLostOutput('mutated styled value', () => state.toJSON());
const rejected = new orm.Author();
rejectsLostOutput('setter before assignment', () => rejected.setJsonSetting(orm.StyledValue.value({ missing: undefined })));
try { rejected.getJsonSetting(); throw new Error('a rejected setter changed the model'); }
catch (error) { if (error.code !== 'COLUMN_UNSELECTED') throw error; }
const document = { present: 1 };
const author = new orm.Author().setJsonSetting(orm.StyledValue.value(document));
document.missing = undefined;
rejectsLostOutput('model array', () => author.toArray());
rejectsLostOutput('model JSON value', () => author.toJSON());
rejectsLostOutput('model JSON text', () => author.toJSONText());

console.log(`styled value fixture: ${tested} codec cases and 3 model states passed`);
