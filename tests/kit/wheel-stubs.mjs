// Stubs of the Python tool of the wheel tests. `-m pip wheel DIR SRC` writes the wheel of SRC into the directory after `-w`,
// with the Requires-Dist lines that the JSON file STUB_WHEEL_REQUIRES_FILE holds. `-m pip download ... -d DIR` writes the
// build backend file BACKEND_FILE with BACKEND_BYTES into DIR. Each pip call is appended as a JSON line to STUB_PYTHON_LOG
// when that variable is set, with the requirements file of a `-r` argument read at call time. No test reaches an index.
export const BACKEND_FILE = 'setuptools-84.0.0-py3-none-any.whl';
export const BACKEND_BYTES = 'setuptools 84.0.0 stand-in of the wheel tests\n';

// The functions of the pip stub, as source text for a stub script that has fs, path and execFileSync in scope.
export const PIP_FUNCTIONS = `
const WHEEL_BACKEND_FILE = ${JSON.stringify(BACKEND_FILE)};
const WHEEL_BACKEND_BYTES = ${JSON.stringify(BACKEND_BYTES)};
function pipWheel(args) {
  const output = args[args.indexOf('-w') + 1];
  const source = args[args.length - 1];
  const text = fs.readFileSync(path.join(source, 'pyproject.toml'), 'utf8');
  const name = /^name = "(.*)"$/m.exec(text)[1];
  const version = /^version = "(.*)"$/m.exec(text)[1];
  const requires = process.env.STUB_WHEEL_REQUIRES_FILE && fs.existsSync(process.env.STUB_WHEEL_REQUIRES_FILE) ? JSON.parse(fs.readFileSync(process.env.STUB_WHEEL_REQUIRES_FILE, 'utf8')) : [];
  const distribution = name.replace(/[^\\w\\d.]+/g, '_');
  const folder = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'stub-wheel-'));
  fs.mkdirSync(path.join(folder, distribution + '-' + version + '.dist-info'));
  fs.writeFileSync(path.join(folder, distribution + '-' + version + '.dist-info', 'METADATA'), ['Metadata-Version: 2.4', 'Name: ' + name, 'Version: ' + version, ...requires.map(line => 'Requires-Dist: ' + line)].join('\\n') + '\\n');
  execFileSync('zip', ['-q', '-r', '-X', path.join(output, distribution + '-' + version + '-py3-none-any.whl'), '.'], { cwd: folder });
  fs.rmSync(folder, { recursive: true, force: true });
  return 0;
}
function pipDownload(args) {
  fs.writeFileSync(path.join(args[args.indexOf('-d') + 1], WHEEL_BACKEND_FILE), WHEEL_BACKEND_BYTES);
  return 0;
}
function pipStub(args) {
  if (process.env.STUB_PYTHON_LOG) {
    const requirements = args.includes('-r') ? fs.readFileSync(args[args.indexOf('-r') + 1], 'utf8') : null;
    fs.appendFileSync(process.env.STUB_PYTHON_LOG, JSON.stringify({ args, cwd: process.cwd(), requirements }) + '\\n');
  }
  if (args[2] === 'wheel') return pipWheel(args);
  if (args[2] === 'download') return pipDownload(args);
  return 1;
}
`;

// The Python stub of a release sandbox: the pip calls of the build and the download, and nothing else.
export const PYTHON3_WHEEL_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
${PIP_FUNCTIONS}
const args = process.argv.slice(2);
if (args[0] === '-m' && args[1] === 'pip') process.exit(pipStub(args));
console.error('python3 stub: unexpected arguments ' + JSON.stringify(args));
process.exit(1);
`;
