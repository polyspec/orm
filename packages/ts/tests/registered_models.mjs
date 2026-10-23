// The model classes of a document set, registered as generated code does (KSTD-5-46): the shared helper of the tests
// that run a document set on their own model classes.
import { Model, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';

/** Registers the model of a document set as generated code does and returns a model class per entity. */
export function models(text) {
  const parsed = parseDbspec(text, {});
  if (parsed.document === null) throw new Error(JSON.stringify(parsed.diagnostics));
  const { manifest } = dbspecManifest([parsed.document]);
  const model = registerModel(manifest.manifestText, manifest.manifestHash);
  const out = {};
  for (const entity of model.entities.values()) {
    const cls = class extends Model {};
    cls.entity = { model, entity, create: core => new cls(core) };
    out[entity.name] = cls;
  }
  return out;
}
