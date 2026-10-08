// The setup and the teardown of a test file or a test: a browser launch, a server start, a stylesheet compile, a browser
// close, a server stop, a directory removal. They are long operations, not test cases: each has no hook timeout and ends
// when its operation settles (the browser launched, the server announced readiness, the close resolved, the process
// exited), and its result or error decides it. Each prints its start, a line while it is still running and its end with the
// elapsed time.
import { after, before } from 'node:test';
import { compactSeconds } from './time.mjs';

function hook(register, kind, name, operation, { context, write = text => process.stdout.write(text), heartbeatMs = 5000 } = {}) {
  const add = context ? context[register].bind(context) : { before, after }[register];
  add(async () => {
    const started = performance.now();
    const elapsed = () => compactSeconds(performance.now() - started);
    write(`[${kind}] ${name}: started\n`);
    const running = setInterval(() => write(`[${kind}] ${name}: still running (${elapsed()})\n`), heartbeatMs);
    try {
      await operation();
      write(`[${kind}] ${name}: finished in ${elapsed()}\n`);
    } catch (error) {
      write(`[${kind}] ${name}: failed after ${elapsed()}: ${error?.message ?? error}\n`);
      throw error;
    } finally {
      clearInterval(running);
    }
  }, { timeout: Infinity });
}

/**
 * Register one setup as a `before` hook without a time limit.
 * @param {string} name what the setup starts, such as `browser launch`
 * @param {() => unknown} operation
 * @param {object} [options]
 * @param {{ before: Function }} [options.context] the test or suite context whose `before` hook runs the setup; without it,
 *   the setup runs before the tests of the file or of the enclosing suite
 * @param {(text: string) => void} [options.write]
 * @param {number} [options.heartbeatMs] interval of the still-running lines
 */
export function setup(name, operation, options) {
  hook('before', 'setup', name, operation, options);
}

/**
 * Register one teardown as an `after` hook without a time limit.
 * @param {string} name what the teardown stops, such as `browser close`
 * @param {() => unknown} operation
 * @param {object} [options]
 * @param {{ after: Function }} [options.context] the test whose `after` hook runs the teardown; without it, the teardown runs
 *   after the tests of the file or of the enclosing suite
 * @param {(text: string) => void} [options.write]
 * @param {number} [options.heartbeatMs] interval of the still-running lines
 */
export function teardown(name, operation, options) {
  hook('after', 'teardown', name, operation, options);
}
