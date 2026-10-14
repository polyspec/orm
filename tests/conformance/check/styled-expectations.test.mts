// The write_cycle expectations of every database record the styled columns (json_setting, serialize_data) of the created
// and updated rows as tagged styled values: {kind: "value", value}.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { COMPUTE, caseTest } from '../../testcase.mts';
import { readJsonFile } from '../../../scripts/json/schema.mts';

type Vectors = { vectors: { name: string; expect: { result: unknown } }[] };

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;

for (const file of ['vectors.json', 'vectors.postgres.json', 'vectors.sqlite.json']) {
  caseTest(`TestWriteCycleExpectationsUseTaggedStyledValues/${file}`, COMPUTE, () => {
    const document = readJsonFile<Vectors>(join(import.meta.dirname, '..', file), join(import.meta.dirname, '../schema/vectors.schema.json'));
    const vector = document.vectors.find(item => item.name === 'write_cycle');
    assert.ok(vector, 'write_cycle expectation is absent');
    const result = record(vector.expect.result);
    assert.ok(result, 'write_cycle result is absent');
    for (const rowName of ['created', 'updated']) {
      const row = record(result[rowName]);
      assert.ok(row, `${rowName} result is absent`);
      for (const column of ['json_setting', 'serialize_data']) {
        const styled = record(row[column]);
        assert.ok(styled && Object.keys(styled).length === 2 && styled.kind === 'value' && styled.value !== undefined && styled.value !== null,
          `${rowName}.${column} does not use the declared styled value: ${JSON.stringify(row[column])}`);
      }
    }
  });
}
