// The styled-value feature cases of the TypeScript client: the model states, lost output and the json
// column getter. The styled column states at the setter and the getter are a case of the recipe conformance_verification.
import { decode } from '../dist/codec.js';
import * as orm from '../dist/index.js';
import { cases as caseRunner } from '../../../../tests/testcase.mts';

const suite = caseRunner();
const probeText = 'dbspec 1 styled_probe\n\ntable styled_probe {\n  seq i64\n  payload text\n  primary key (seq)\n  settings {\n    codec payload ordered_json\n  }\n}\n';
const { manifest } = orm.dbspecManifest([orm.parseDbspec(probeText, {}).document]);
const model = orm.registerModel(manifest.manifestText, manifest.manifestHash);
// Requirements: COD-20, COD-25.
await suite.run('styled-value/model-states', () => {
  const probe = new orm.Core({ model, entity: model.entities.get('styled_probe'), create: () => { throw new Error('not used'); } });
  try { probe.column('payload'); throw new Error('unselected getter was accepted'); }
  catch (error) { if (error.code !== 'COLUMN_UNSELECTED') throw error; }
  try { probe.setValue('payload', orm.StyledValue.sqlNull()); throw new Error('non-null column accepted SQL NULL'); }
  catch (error) { if (error.code !== 'CODEC_ENCODE') throw error; }
  probe.setValue('payload', orm.StyledValue.value(null));
  if (JSON.stringify(probe.column('payload')) !== JSON.stringify({ kind: 'value', value: null })) {
    throw new Error('non-null column rejected JSON literal null');
  }
});

function rejectsLostOutput(label, read) {
  try { read(); throw new Error(`${label}: input was silently omitted`); }
  catch (error) { if (error.code !== 'CODEC_ENCODE') throw error; }
}
// Requirements: COD-21, COD-73.
await suite.run('styled-value/lost-output', () => {
  rejectsLostOutput('styled toJSON', () => orm.StyledValue.value({ missing: undefined }).toJSON());
  rejectsLostOutput('nested styled JSON.stringify', () => JSON.stringify(orm.StyledValue.value({ nested: { missing: undefined } })));
  rejectsLostOutput('styled array gap', () => orm.StyledValue.value(Object.assign([], { 1: 'present' })).toJSON());
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
  // The array form holds the value that payload() returns unchecked (COD-27, COD-73); the JSON output refuses it.
  if (author.toArray().json_setting.value !== document) throw new Error('model array: the array form is not the stored value');
  rejectsLostOutput('model JSON value', () => author.toJSON());
  rejectsLostOutput('model JSON text', () => author.toJSONText());
});
// The JSON output writes an ordered-json value at any depth of a styled value as its stored text, and a bigint as its exact
// digits (COD-16, COD-26); a class object is its toJSON form, read once, so a form that is the object again has no JSON
// form and is refused, never read again (COD-73).
// Requirements: COD-16, COD-26, COD-73.
await suite.run('styled-value/nested-json-output', () => {
  const text = '{"n":1.50,"m":9007199254740993}';
  const author = new orm.Author().setJsonSetting(orm.StyledValue.value({ inner: decode(['ordered_json'], text).payload() }));
  const want = `"json_setting":{"kind":"value","value":{"inner":${text}}}`;
  if (!author.toJSONText().includes(want)) throw new Error(`toJSONText lost the stored text: ${author.toJSONText()}`);
  if (!JSON.stringify(author).includes(want)) throw new Error(`JSON.stringify lost the stored text: ${JSON.stringify(author)}`);
  const styled = orm.StyledValue.value([decode(['ordered_json'], text).payload(), 9007199254740993n]);
  if (JSON.stringify(styled) !== `{"kind":"value","value":[${text},9007199254740993]}`) throw new Error(`a styled value wrote ${JSON.stringify(styled)}`);
  // JavaScript would reorder the key "1" of a nested ordered-json value, so JSON.stringify refuses it and toJSONText writes it.
  const reordered = new orm.Author().setJsonSetting(orm.StyledValue.value([decode(['ordered_json'], '{"a":1,"1":2}').payload()]));
  rejectsLostOutput('nested reordered key', () => JSON.stringify(reordered));
  if (!reordered.toJSONText().includes('[{"a":1,"1":2}]')) throw new Error(`toJSONText reordered: ${reordered.toJSONText()}`);
  class Self { toJSON() { return this; } }
  const document = { a: 1 };
  const changed = new orm.Author().setJsonSetting(orm.StyledValue.value(document));
  document.a = new Self();
  for (const [label, read] of [['toJSONText', () => changed.toJSONText()], ['JSON.stringify', () => JSON.stringify(changed)], ['styled', () => JSON.stringify(orm.StyledValue.value(new Self()))]]) {
    try { read(); throw new Error(`${label}: a self toJSON form was written`); }
    catch (error) { if (error.code !== 'CODEC_ENCODE' || !error.message.endsWith('JSON output cannot write a value that JSON has no form for')) throw error; }
  }
});
// Core.jsonColumn, which the getter of an ordered_json column calls: it takes a styled SQL NULL or ordered-json value and
// refuses any other value with a TypeError that names the column.
// Requirements: DBS-112, DBS-114.
await suite.run('styled-value/json-column', () => {
  try { new orm.Author().getJsonSetting(); throw new Error('the unselected getter was accepted'); }
  catch (error) { if (error.code !== 'COLUMN_UNSELECTED') throw error; }
  const stored = decode(['ordered_json'], '{"b":1,"a":[true,null]}');
  const got = new orm.Author().setJsonSetting(stored).getJsonSetting();
  if (!(got instanceof orm.StyledValue) || got.kind !== 'value' || JSON.stringify(got) !== JSON.stringify(stored)) {
    throw new Error(`the getter changed an ordered-json value: ${JSON.stringify(got)}`);
  }
  const none = new orm.Author().setJsonSetting(orm.StyledValue.sqlNull()).getJsonSetting();
  if (!(none instanceof orm.StyledValue) || none.kind !== 'sql-null') throw new Error('the getter changed a styled SQL NULL');
  const plain = new orm.Author().setJsonSetting(orm.StyledValue.value({ plain: 1 }));
  try { plain.getJsonSetting(); throw new Error('the getter returned a value that is no ordered-json value'); }
  catch (error) {
    if (!(error instanceof TypeError) || !error.message.includes('author.json_setting')) throw error;
  }
});
suite.finish();
