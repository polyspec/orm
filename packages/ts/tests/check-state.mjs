import { captureError } from './capture-error.mjs';

/** Creates the consistent failure reporter used by multi-case test programs. */
export function createFailureCheck(current, recordFailure, report = console.error) {
  return (condition, message) => {
    if (condition) return;
    recordFailure();
    report(`FAIL ${current()}: ${message}`);
  };
}

/** Creates the assertion reporter and rejection capture used by database case programs. */
export function createCaseAssertions(current, recordFailure, success = undefined, report = console.error) {
  return {
    check: createFailureCheck(current, recordFailure, report),
    raised: run => captureError(run, { success }),
  };
}
