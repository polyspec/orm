/** Creates the consistent failure reporter used by multi-case test programs. */
export function createFailureCheck(current, recordFailure, report = console.error) {
  return (condition, message) => {
    if (condition) return;
    recordFailure();
    report(`FAIL ${current()}: ${message}`);
  };
}
