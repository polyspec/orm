import assert from 'node:assert/strict';
import { parseDbspec } from '../dist/dbspec/index.js';

const text = lines => lines.join('\n') + '\n';

/** Parses each document against the other documents in the same vector. */
export function parseDocuments(documents) {
  return Object.keys(documents).map(name => {
    const set = {};
    for (const [other, lines] of Object.entries(documents)) if (other !== name) set[other] = text(lines);
    const result = parseDbspec(text(documents[name]), set);
    assert.deepEqual(result.diagnostics, [], `diagnostics of document ${name}`);
    return result.document;
  });
}
