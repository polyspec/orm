// Vitest reporter printing through the shared progress lines. Vitest stops a test at its own timeout (--testTimeout); this
// reporter shows every test starting, still running and ending.
import path from 'node:path';
import { createProgress } from './test-progress.mjs';
import { ROOT } from './paths.mjs';

// An error with its message: the stack of a timed-out hook does not hold the message.
const errorText = errors => errors.map(error => {
  const text = error.stack ?? error.message;
  return error.message && !text.includes(error.message) ? `${error.message}\n${text}` : text;
}).join('\n');

export default class ProgressReporter {
  onInit() {
    this.progress = createProgress({ write: text => process.stdout.write(text) });
    this.suites = new Set();
  }

  id(entity) {
    const file = path.relative(ROOT, entity.module?.moduleId ?? entity.moduleId);
    return entity.fullName ? `${file} › ${entity.fullName.replaceAll(' > ', ' › ')}` : file;
  }

  onTestModuleStart(testModule) {
    this.progress.start(this.id(testModule), { group: true });
  }

  onTestModuleEnd(testModule) {
    const id = this.id(testModule);
    const errors = testModule.errors();
    const duration = testModule.diagnostic().duration;
    if (errors.length || testModule.state() === 'failed') this.progress.fail(id, duration, errorText(errors));
    else this.progress.pass(id, duration);
  }

  // A suite is a group, so the failure of its own hooks is printed with its elapsed time.
  onTestSuiteReady(testSuite) {
    this.suites.add(this.id(testSuite));
    this.progress.start(this.id(testSuite), { group: true });
  }

  onTestSuiteResult(testSuite) {
    const id = this.id(testSuite);
    // Vitest reports a skipped suite without its start.
    if (!this.suites.delete(id)) this.progress.start(id, { group: true });
    const errors = testSuite.errors();
    if (errors.length || testSuite.state() === 'failed') this.progress.fail(id, undefined, errorText(errors));
    else if (testSuite.state() === 'skipped') this.progress.skip(id);
    else this.progress.pass(id);
  }

  onTestCaseReady(testCase) {
    this.progress.start(this.id(testCase));
  }

  onTestCaseResult(testCase) {
    const id = this.id(testCase);
    const result = testCase.result();
    const duration = testCase.diagnostic()?.duration;
    if (result.state === 'passed') this.progress.pass(id, duration);
    else if (result.state === 'skipped') this.progress.skip(id);
    else this.progress.fail(id, duration, errorText(result.errors ?? []));
  }

  onTestRunEnd(testModules, unhandledErrors) {
    for (const error of unhandledErrors) this.progress.line(`✖ unhandled error: ${error.stack ?? error.message}`);
    // A failure that vitest does not count, such as a run of zero tests, fails the process too.
    if (!this.progress.close('vitest').ok) process.exitCode = 1;
  }
}
