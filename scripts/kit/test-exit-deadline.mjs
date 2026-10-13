// Preloaded by scripts/kit/run-tests.mjs into the process of every node:test file, with the deadline in milliseconds as the
// `ms` parameter of its URL. A file whose tests have all ended but whose process stays alive holds a handle that a test left
// open: a timer, a server, a child process. After the deadline the process names the handles that keep it alive and exits 1,
// so the leak fails its file by name instead of hanging the run. node --test needs no --test-force-exit then, which ended a
// file's process at its last known test and dropped a test registered after a top-level await (K72).
import { writeSync } from 'node:fs';
import { after } from 'node:test';

const file = process.argv[1];
// Only the process of a test file: node --test marks it with NODE_TEST_CONTEXT.
if (file && process.env.NODE_TEST_CONTEXT) {
  const deadline = Number(new URL(import.meta.url).searchParams.get('ms'));
  if (!(deadline > 0)) throw new Error(`${import.meta.url}: the ms parameter must be a positive number of milliseconds`);
  // process.exit drops the writes that an asynchronous stdout pipe has not taken yet; the results of the tests reach the
  // parent through that pipe, so it is made blocking before the exit below can happen.
  process.stdout._handle?.setBlocking?.(true);
  process.stderr._handle?.setBlocking?.(true);
  after(() => {
    setTimeout(() => {
      writeSync(2, `${file}: the process did not exit ${deadline} ms after its last test; it holds ${process.getActiveResourcesInfo().join(', ')}\n`);
      process.exit(1);
    }, deadline).unref();
  });
}
