import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
import { formatMicroseconds } from './coverage_performance_report.mjs';

caseTest('the TypeScript hot-path gate reports nanoseconds as microseconds', COMPUTE, () => {
  assert.equal(formatMicroseconds(2_500_000), '2500.0µs');
  assert.equal(formatMicroseconds(125), '0.1µs');
});
