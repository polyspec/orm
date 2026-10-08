// Stub commands for the toolchain tests: `npm`, `go`, `python3.14`, `cargo` and `curl` on PATH log their arguments to
// STUB_LOG and write what the real commands write (an npm tree, a Go toolchain module, a virtual environment with ruff, a
// cargo-audit binary, a downloaded file), so an installer runs offline and a test reads the calls it made. The files the
// stubs write are Node scripts, so a wrapper of var/tools/bin can be run.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HEADER = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, path.basename(process.argv[1]) + ' ' + args.join(' ') + '\\n');
const script = (file, source) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '#!/usr/bin/env node\\n' + source, { mode: 0o755 }); };
`;

const NPM = `${HEADER}
if (process.env.STUB_PATH_LOG) fs.appendFileSync(process.env.STUB_PATH_LOG, process.env.PATH + '\\n');
const version = /^npm@(.+)$/.exec(args.at(-1))[1];
const prefix = args[args.indexOf('--prefix') + 1];
const shown = process.env.STUB_NPM_SHOWS ?? version;
fs.mkdirSync(path.join(prefix, 'node_modules/npm'), { recursive: true });
fs.writeFileSync(path.join(prefix, 'node_modules/npm/package.json'), JSON.stringify({ name: 'npm', version: shown }));
script(path.join(prefix, 'node_modules/npm/bin/npm-cli.js'), 'console.log(' + JSON.stringify(shown) + ');');
`;

const GO = `${HEADER}
if (args[0] === 'mod') {
  const module = args.at(-1);
  const version = /-go(\\d+\\.\\d+\\.\\d+)\\./.exec(module)[1];
  const cache = process.env.GOMODCACHE;
  const root = path.join(cache, module);
  fs.mkdirSync(path.join(root, 'pkg/tool/stub_arch'), { recursive: true });
  fs.writeFileSync(path.join(root, 'VERSION'), 'go' + (process.env.STUB_GO_SHOWS ?? version) + '\\ntime 2026-01-01\\n');
  for (const name of ['go', 'gofmt']) script(path.join(root, 'bin', name), 'console.log(' + JSON.stringify(name + ' ' + version + ' ' + process.env.GOTOOLCHAIN) + ');');
  // The module zip keeps no file modes.
  fs.writeFileSync(path.join(root, 'pkg/tool/stub_arch/compile'), 'binary', { mode: 0o644 });
  fs.mkdirSync(path.join(cache, 'cache/download'), { recursive: true });
  fs.writeFileSync(path.join(cache, 'cache/download/zip'), 'zip');
} else if (args[0] === 'install') {
  const release = /@v(.+)$/.exec(args[1])[1];
  script(path.join(process.env.GOBIN, 'govulncheck'), 'console.log("Scanner: govulncheck@v' + (process.env.STUB_GOVULNCHECK_SHOWS ?? release) + '");');
}
`;

// The python of the virtual environment: pip installs ruff, whose command prints the version of the request.
const VENV_PYTHON = `const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, 'venv-python ' + args.join(' ') + '\\n');
const shown = process.env.STUB_RUFF_SHOWS ?? args.at(-1).slice('ruff=='.length);
fs.writeFileSync(path.join(path.dirname(process.argv[1]), 'ruff'), '#!/usr/bin/env node\\nconsole.log("ruff ' + shown + '");', { mode: 0o755 });
`;

const PYTHON = `${HEADER}
script(path.join(args.at(-1), 'bin/python'), ${JSON.stringify(VENV_PYTHON)});
`;

const CARGO = `${HEADER}
const root = args[args.indexOf('--root') + 1];
const release = /cargo-audit@(.+)$/.exec(args.at(-1))[1];
script(path.join(root, 'bin/cargo-audit'), 'console.log("cargo-audit ' + (process.env.STUB_CARGO_AUDIT_SHOWS ?? release) + '");');
`;

const CURL = `${HEADER}
const url = args.at(-1);
const output = args[args.indexOf('--output') + 1];
const source = JSON.parse(process.env.STUB_DOWNLOADS ?? '{}')[url];
if (!source) { console.error('curl: 404 ' + url); process.exit(22); }
fs.copyFileSync(source, output);
`;

/** The directory of stubs and the environment that puts them first on PATH; the directory is removed with \`t.after\`. */
export function toolchainStubs(t, { downloads = {}, extra = {} } = {}) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'kit-toolchain-stubs-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  mkdirSync(bin);
  for (const [name, source] of [['npm', NPM], ['go', GO], ['python3.14', PYTHON], ['cargo', CARGO], ['curl', CURL]]) {
    writeFileSync(path.join(bin, name), source);
    chmodSync(path.join(bin, name), 0o755);
  }
  const log = path.join(directory, 'calls.log');
  writeFileSync(log, '');
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_LOG: log, STUB_DOWNLOADS: JSON.stringify(downloads), ...extra };
  return { env, directory, calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

/**
 * Stubs of version commands: each command of `outputs` ({ name: text }) prints its text for any arguments (a command whose text
 * is `null` exits with status 1, as a command that fails to run), and the log line
 * holds the arguments and the GOTOOLCHAIN and RUSTUP_AUTO_INSTALL it ran with. The environment has the stubs first on PATH,
 * followed by the directory of this Node.js and the system directories only, so a tool that is not stubbed is absent.
 */
export function versionStubs(t, outputs) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'kit-toolchain-versions-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  mkdirSync(bin);
  const log = path.join(directory, 'calls.log');
  writeFileSync(log, '');
  for (const [name, text] of Object.entries(outputs)) {
    writeFileSync(path.join(bin, name), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(process.env.STUB_LOG, path.basename(process.argv[1]) + ' ' + process.argv.slice(2).join(' ') + ' [GOTOOLCHAIN=' + process.env.GOTOOLCHAIN + ' RUSTUP_AUTO_INSTALL=' + process.env.RUSTUP_AUTO_INSTALL + ']\\n');
${text === null ? 'console.error("stub: the command fails"); process.exit(1);' : `console.log(${JSON.stringify(text)});`}
`);
    chmodSync(path.join(bin, name), 0o755);
  }
  const env = { PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), STUB_LOG: log, HOME: directory };
  return { env, directory, calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}
