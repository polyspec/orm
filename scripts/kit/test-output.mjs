// The parsers of the output of the test tools: node:test (TAP), go test -json, cargo test (libtest), python unittest (verbose)
// and PHPUnit (TeamCity messages). run-tests reads a run's output with them into its progress lines, and the language-parity
// check (parity-runners.mjs) reads a binding's output with the same functions into the outcome of each native test. Each
// parser reports to a sink with the methods `start(test, options)`, `pass(test, ms)`, `fail(test, ms, text)`, `skip(test)`,
// `todo(test)`, `line(text)` and `raw(text)`, where `test` is `{ id, name }`: `id` is the name that the progress shows and
// `name` is the name that the tool reports for the test. `todo` is a test that the tool expects to fail (a unittest expected
// failure, a node TODO): it is no pass. `toProgress` turns a progress reporter into such a sink.

/**
 * Read go test -json events into the sink: each test with its id (the package and the test path, as the progress shows
 * it) and its name (the test name that go reports). The output of a test is passed to the sink only when it fails. The
 * compiler output of a package that does not build arrives as `build-output` events and its end as a `build-fail` event:
 * both reach the sink as lines and the error lines are added to `build`. A package that started no test case is reported
 * as skipped.
 */
export function goEvents(sink, build = []) {
  const output = new Map();
  // The test cases that each package started; a package that started none passed nothing.
  const started = new Map();
  return line => {
    let event;
    try { event = JSON.parse(line); } catch { return sink.line(line); }
    if (event.Action === 'build-output') {
      for (const text of String(event.Output ?? '').split('\n').filter(Boolean)) {
        sink.line(text);
        if (!text.startsWith('#')) build.push(text.trim());
      }
      return undefined;
    }
    if (event.Action === 'build-fail') return sink.line(`✖ build of ${event.ImportPath} failed`);
    const id = event.Test ? `${event.Package} › ${event.Test.replaceAll('/', ' › ')}` : event.Package;
    const test = { id, name: event.Test ?? event.Package };
    const group = !event.Test;
    switch (event.Action) {
      case 'start': started.set(event.Package, 0); return sink.start(test, { group: true });
      case 'run':
        if (group) return undefined;
        started.set(event.Package, (started.get(event.Package) ?? 0) + 1);
        return sink.start(test);
      case 'output': {
        if (group) { if (!/^(?:ok|PASS|FAIL|\?)\s/.test(event.Output)) sink.raw(event.Output); return; }
        output.set(id, (output.get(id) ?? '') + event.Output);
        return;
      }
      case 'pass':
        output.delete(id);
        if (group && !started.get(event.Package)) {
          sink.skip(test);
          return sink.line(`○ ${id}: ran no test case`);
        }
        return sink.pass(test, event.Elapsed * 1000);
      case 'skip': output.delete(id); return sink.skip(test);
      case 'fail': {
        const text = (output.get(id) ?? '').split('\n').filter(entry => !/^\s*(?:=== RUN|--- FAIL|=== (?:PAUSE|CONT))/.test(entry)).join('\n');
        output.delete(id);
        return sink.fail(test, (event.Elapsed ?? 0) * 1000, text);
      }
      default: return undefined;
    }
  };
}

/**
 * Read the output of a serial runner in which a test prints `<name> ... ` when it starts and its outcome on the same line
 * when it ends. `result` matches a finished line with the name and the outcome, `pending` the name of the test that started
 * at the end of an unfinished line, `outcome` names the sink call of an outcome (`pass`, `fail` or `skip`), `idOf` turns a
 * name into a test (`{ id, name }`) and `other` receives every other line. The runner is serial, so an outcome belongs to the
 * test that started last.
 */
function startResultLines(sink, { result, pending, outcome, idOf, other }) {
  let current;
  let buffer = '';
  const start = (name) => {
    if (current !== undefined) return;
    current = idOf(name);
    sink.start(current);
  };
  const line = (text) => {
    const match = result.exec(text);
    if (!match) return other(text);
    start(match[1]);
    sink[outcome(match[2])](current);
    current = undefined;
    return undefined;
  };
  return (data) => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      line(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
    }
    const started = pending.exec(buffer);
    if (started) start(started[1]);
  };
}

/**
 * Read serial libtest output into the sink. A test prints `test <name> ... ` when it starts and its result (`ok`,
 * `FAILED` or `ignored`) when it ends; a should_panic test prints `test <name> - should panic ... `. cargo names each test
 * binary on standard error before running it.
 */
export function cargoEvents(sink) {
  let binary = 'cargo';
  const stdout = startResultLines(sink, {
    result: /^test (\S+)(?: - should panic)? \.\.\. (ok|FAILED|ignored)\b/,
    pending: /^test (\S+)(?: - should panic)? \.\.\. $/,
    outcome: word => ({ ok: 'pass', FAILED: 'fail', ignored: 'skip' })[word],
    idOf: name => ({ id: `${binary} › ${name}`, name }),
    other: (text) => {
      if (text.trim() && !/^(?:running \d+ tests?$|test result:|failures:$|successes:$)/.test(text.trim())) sink.line(`  ${text}`);
    },
  });
  return {
    stdout,
    stderr(text) {
      const running = /^\s*(?:Running|Doc-tests)\s+(?:unittests\s+)?(\S+)/.exec(text);
      if (running) binary = running[1];
      if (text.trim()) sink.line(text.trim());
    },
  };
}

/**
 * Read the verbose output of Python unittest, which it writes to standard error, into the sink. A test prints
 * `<method> (<module>.<class>.<method>) ... ` when it starts and its outcome when it ends: `ok` passes, `expected failure` is a
 * todo, `skipped '<reason>'` is skipped, and `FAIL`, `ERROR` and `unexpected success` fail. A test with a docstring prints its
 * description on a line of its own and the first docstring line before ` ... `; the test keeps the id of the description.
 * The failure reports at the end of the run are printed as they are.
 */
export function pythonEvents(sink) {
  const DESCRIPTION = /^\w+ \([\w.]+\)$/;
  // The description line of a test with a docstring, which names the test whose outcome follows.
  let described;
  return startResultLines(sink, {
    result: /^(.+?) \.\.\. (ok|FAIL|ERROR|skipped\b.*|expected failure|unexpected success)$/,
    pending: /^(.+?) \.\.\. $/,
    outcome: word => ({ ok: 'pass', 'expected failure': 'todo' })[word] ?? (word.startsWith('skipped') ? 'skip' : 'fail'),
    idOf: (name) => {
      const id = described ?? name;
      described = undefined;
      return { id, name: id.split(' ')[0] };
    },
    other: (text) => {
      if (DESCRIPTION.test(text)) { described = text; return; }
      described = undefined;
      if (text.trim()) sink.line(`  ${text}`);
    },
  });
}

const unescapeTeamcity = value => value.replace(/\|(['|\][nr])/g, (match, character) => ({ n: '\n', r: '\r' })[character] ?? character);

/**
 * Read PHPUnit TeamCity messages into the sink. Other lines, such as the summary with the warnings that fail the run
 * under failOnWarning, are printed as they are.
 */
export function phpunitEvents(sink) {
  const failures = new Map();
  // A test is named by its class and method; testFinished repeats only the method name.
  const ids = new Map();
  // Suites without a location (the configuration and the test suites) are printed as groups. A class or a data provider
  // method has a location on its start only, so its finish is matched by this set.
  const groups = new Set();
  // A skipped or incomplete test gets testIgnored and then testFinished: its finish is no pass.
  const ignored = new Set();
  const qualified = attributes => {
    const hint = /::\\?([^:]+)::(.+)$/.exec(attributes.locationHint ?? '');
    return hint ? `${hint[1].split('\\').pop()}::${hint[2]}` : attributes.name;
  };
  return line => {
    const message = /^##teamcity\[(\w+)((?: \w+='(?:[^'|]|\|.)*')*)\]$/.exec(line.trim());
    if (!message) return line.trim() ? sink.line(line) : undefined;
    const attributes = Object.fromEntries([...message[2].matchAll(/ (\w+)='((?:[^'|]|\|.)*)'/g)].map(([, key, value]) => [key, unescapeTeamcity(value)]));
    if (message[1] === 'testStarted') ids.set(attributes.name, qualified(attributes));
    const id = ids.get(attributes.name) ?? attributes.name;
    const test = { id, name: attributes.name };
    switch (message[1]) {
      case 'testSuiteStarted': {
        if (attributes.locationHint) return undefined;
        groups.add(id);
        return sink.start(test, { group: true });
      }
      case 'testSuiteFinished': return groups.delete(id) ? sink.pass(test) : undefined;
      case 'testStarted': return sink.start(test);
      // PHPUnit reports a test that ran out of its time limit and also made no assertion twice.
      case 'testFailed': failures.set(id, [failures.get(id), attributes.message ?? '', attributes.details ?? ''].filter(Boolean).join('\n')); return undefined;
      case 'testIgnored': ignored.add(id); return sink.skip(test);
      case 'testFinished': {
        const duration = Number(attributes.duration);
        if (ignored.delete(id)) return undefined;
        if (failures.has(id)) { const text = failures.get(id); failures.delete(id); return sink.fail(test, duration, text); }
        return sink.pass(test, duration);
      }
      default: return undefined;
    }
  };
}

/**
 * Read the TAP output of node:test (`node --test --test-reporter=tap`) into the sink. Each test at the top of the output (a
 * line that starts with `ok` or `not ok` at column 0) is one test, with its name and its directive `# SKIP` (skipped) or
 * `# TODO` (a todo, whatever its result); the subtests of a test are indented and belong to it, so a test passes or fails as
 * a whole. The other lines are passed to `line`.
 */
export function tapEvents(sink) {
  return (line) => {
    const match = /^(ok|not ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/.exec(line);
    if (!match) return line.trim() ? sink.line(line) : undefined;
    const test = { id: match[2], name: match[2] };
    if (match[3] === 'SKIP') return sink.skip(test);
    if (match[3] === 'TODO') return sink.todo(test);
    return match[1] === 'ok' ? sink.pass(test) : sink.fail(test, undefined, '');
  };
}

/**
 * The progress reporter of run-tests as a sink: the test id is the name the progress shows. A todo shows as a pass, as the
 * progress has always shown an expected failure. `raw` writes the text as it is (standard output), as go test prints a
 * package line that no event describes.
 */
export function toProgress(progress, write = text => process.stdout.write(text)) {
  return {
    start: (test, options) => progress.start(test.id, options),
    pass: (test, ms) => progress.pass(test.id, ms),
    fail: (test, ms, text) => progress.fail(test.id, ms, text),
    skip: test => progress.skip(test.id),
    todo: test => progress.pass(test.id),
    line: text => progress.line(text),
    raw: text => write(text),
  };
}
