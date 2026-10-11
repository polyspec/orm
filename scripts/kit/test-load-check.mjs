// Preloaded by scripts/kit/run-tests.mjs into the process of every node:test file. node --test runs with --test-force-exit,
// which ends the process when its known tests end; a test that the module registers after that end never runs. A process
// that ends before its module finished evaluating, top-level awaits included, fails the file and says so.
import { pathToFileURL } from 'node:url';

const file = process.argv[1];
// Only the process of a test file: node --test marks it with NODE_TEST_CONTEXT.
if (file && process.env.NODE_TEST_CONTEXT) {
  // The results of the tests reach the parent through this stdout pipe. A pipe is asynchronous, so process.exit drops the
  // writes it has not taken yet (64 KB on macOS): the last results of a file were lost. A blocking pipe takes each write
  // before it returns, so the exit has nothing to drop.
  process.stdout._handle?.setBlocking?.(true);
  process.stderr._handle?.setBlocking?.(true);
  let loaded = false;
  // The module is evaluated once; this import waits for the evaluation that node --test starts.
  import(pathToFileURL(file).href).then(() => { loaded = true; }, () => { loaded = true; });
  process.once('exit', () => {
    if (loaded) return;
    process.stderr.write(`${file}: the process ended before the module finished loading; tests registered later did not run\n`);
    process.exitCode = 1;
  });
}
