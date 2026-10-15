// The shared cases of contracts/fixtures/insert_parts.json, each one top-level test named by its id: insertParts splits
// the rows of the case into the parts of its driver and column count (docs/protocol.md "Multi-row inserts").
import { readFile } from 'node:fs/promises';
import { insertParts } from '../dist/model.js';
import { check } from './codec_case.mjs';

const fixture = JSON.parse(await readFile('contracts/fixtures/insert_parts.json', 'utf8'));

for (const c of fixture.cases) check(c.id, wrong => {
  if (c.operation !== 'insert_parts') wrong.push(`operation ${c.operation}`);
  const got = insertParts(c.input.rows, c.input.columns, c.input.driver);
  if (JSON.stringify(got) !== JSON.stringify(c.expected)) wrong.push(`parts ${JSON.stringify(got)}, want ${JSON.stringify(c.expected)}`);
});
