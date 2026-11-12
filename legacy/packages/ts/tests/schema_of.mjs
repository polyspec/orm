import { dbspecManifest, parseDbspec } from '../dist/index.js';

/** The generated schema value for a dbspec document. */
export function schemaOf(text) {
  const { manifest } = dbspecManifest([parseDbspec(text, {}).document]);
  return { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash };
}
