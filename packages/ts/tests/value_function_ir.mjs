// The IR of a value function: functionIR gives the function name and the parameter index of each bound argument, numbered
// after the parameters the request already holds, and leaves out ps for a function without arguments.
//
// Usage: node --test packages/ts/tests/value_function_ir.mjs (after the build)
import assert from 'node:assert/strict';
import { orm } from '../dist/index.js';
import { functionIR } from '../dist/values.js';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

// Requirements: PRT-77.
caseTest('value_function_ir_parameter_indexes', COMPUTE, () => {
  const preceding = ['preceding'];
  assert.deepEqual(functionIR(orm.secondsAgo(30), value => preceding.push(value) - 1), { name: 'seconds_ago', ps: [1] });
  assert.equal(JSON.stringify(functionIR(orm.secondsAgo(30), () => 0)), '{"name":"seconds_ago","ps":[0]}');
  assert.equal(JSON.stringify(functionIR(orm.now(), () => 0)), '{"name":"now"}');
});
