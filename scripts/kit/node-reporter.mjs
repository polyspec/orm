// node:test reporter printing through the shared progress lines. node --test enforces the timeout of each test
// (--test-timeout); this reporter shows every test starting, still running and ending. A file that reports no test case
// fails, and so does a run in which no test ran.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { createProgress } from './test-progress.mjs';
import { ROOT } from './paths.mjs';

// The failure of a test: what failed (for example `failed running after hook`), then its cause.
const failureText = error => {
  const cause = error?.cause ?? error;
  const text = cause?.stack ?? cause?.message ?? String(cause);
  return error?.cause && error.message && !text.includes(error.message) ? `${error.message}\n${text}` : text;
};

export default class ProgressReporter extends Transform {
  constructor() {
    super({ writableObjectMode: true });
    this.progress = createProgress({ write: text => this.push(text) });
    this.names = new Map();
    // Failed completions not yet matched by their failure report, by test key.
    this.completedFailures = new Map();
    // Files whose run reported a failure that no test completion holds, by real path.
    this.failedFiles = new Set();
    // The number of test cases each file reported, by real path; a file that reports none fails.
    this.cases = new Map();
  }

  key(data) {
    return [data.file, data.nesting, data.name, data.line, data.column].join('\0');
  }

  // A test's position: its file, then the names of its enclosing tests.
  id(data) {
    const file = data.file ? path.relative(ROOT, data.file) : '';
    if (data.nesting === 0 && (data.name === file || data.name === data.file)) return { id: file, group: true };
    const trail = this.names.get(file) ?? [];
    trail.length = data.nesting;
    trail[data.nesting] = data.name;
    this.names.set(file, trail);
    return { id: [file, ...trail].filter(Boolean).join(' › '), group: false };
  }

  // node:test reports a start when a test leaves the queue and its result, in execution order, when it completes.
  _transform(event, encoding, callback) {
    const { type, data } = event;
    if (type === 'test:dequeue') {
      const { id, group } = this.id(data);
      this.progress.start(id, { group });
    } else if (type === 'test:complete') {
      const { id, group } = this.id(data);
      const { duration_ms: duration, error, passed } = data.details;
      const file = data.file && realpathSync(data.file);
      if (!group && file) this.cases.set(file, (this.cases.get(file) ?? 0) + 1);
      if (data.skip || data.todo) this.progress.skip(id);
      else if (passed && group && this.failedFiles.has(file)) {
        this.failedFiles.delete(file);
        this.progress.fail(id, duration, 'a failure outside its tests failed the file');
      } else if (passed && group && !this.cases.get(file)) {
        this.progress.fail(id, duration, 'the file ran no test case');
        // node --test counts no failure for it; this reporter runs in that process and fails it.
        process.exitCode = 1;
      } else if (passed) this.progress.pass(id, duration);
      else {
        const key = this.key(data);
        this.completedFailures.set(key, (this.completedFailures.get(key) ?? 0) + 1);
        this.progress.fail(id, duration, failureText(error));
      }
    } else if (type === 'test:fail') {
      // node --test reports every failure after its completion, except a failure of the run of a file, such as a timed-out
      // hook of the file, which has no completion; the file then completes as passed.
      const key = this.key(data);
      const completed = this.completedFailures.get(key) ?? 0;
      if (completed > 1) this.completedFailures.set(key, completed - 1);
      else if (completed === 1) this.completedFailures.delete(key);
      else {
        const { error, duration_ms: duration } = data.details;
        const file = data.file ? path.relative(ROOT, data.file) : '';
        if (data.file) this.failedFiles.add(realpathSync(data.file));
        this.progress.fail(`${file} › ${error?.failureType === 'hookFailed' ? 'hook' : data.name}`, duration, failureText(error));
      }
    } else if (type === 'test:stderr' || type === 'test:stdout') this.push(data.message);
    callback();
  }

  _flush(callback) {
    // A failure that node --test does not count, such as a run of zero tests, fails the process too.
    if (!this.progress.close('node --test').ok) process.exitCode = 1;
    callback();
  }
}
