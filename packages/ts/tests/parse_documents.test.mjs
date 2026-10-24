import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseDocuments } from './parse_documents.mjs';

test('parses documents in vector order against the other documents', () => {
  const ddl = JSON.parse(readFileSync(new URL('../../../tests/dbspec/ddl.json', import.meta.url), 'utf8'));
  const vector = ddl.cases.find(c => c.id === 'use-across-documents');
  assert.ok(vector, 'use-across-documents vector exists');
  assert.deepEqual(parseDocuments(vector.documents).map(document => document.name), ['core', 'shop']);
});
