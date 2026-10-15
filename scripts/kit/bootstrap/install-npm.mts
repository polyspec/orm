// Installs the npm that `packageManager` of package.json declares into var/tools/npm, with the wrappers npm and npx in
// var/tools/bin. Without a digest in packageManager, the npm of the machine installs it (`npm install --prefix`). With
// `+sha512.<digest>`, the registry tarball is downloaded, refused unless its SHA-512 is the digest or when it holds a link,
// and unpacked. An installed release with the same digest is kept. The npm of the machine is never changed.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { installOnce } from './install-tool.mts';
import { bootstrapEnvironment, quote, run, toolsPath, wrapperText, writeWrapper } from './tool-wrappers.mts';
import { fileDigest } from './digest.mts';
import { readJsonObject } from './files.mts';

const MARKER = '.sha512';

/** The release of the npm under `prefix` as `<version>` or `<version>+sha512.<digest>`, or undefined when none is installed. */
function installedRelease(prefix: string): string | undefined {
  const directory = path.join(prefix, 'node_modules/npm');
  if (!statSync(path.join(directory, 'package.json'), { throwIfNoEntry: false })) return undefined;
  const { version } = readJsonObject(directory, 'package.json');
  if (typeof version !== 'string') throw new Error(`${path.join(directory, 'package.json')} records no version: ${JSON.stringify(version)}`);
  return statSync(path.join(directory, MARKER), { throwIfNoEntry: false }) ? `${version}+sha512.${readFileSync(path.join(directory, MARKER), 'utf8').trim()}` : version;
}

// Downloads the tarball, checks its digest and that it holds only files and directories, and unpacks it without its top directory.
function unpackVerified({ root, next, version, sha512, print }: { root: string; next: string; version: string; sha512: string; print: (text: string) => void }): void {
  const scratch = path.join(next, '.download');
  mkdirSync(scratch);
  const tarball = path.join(scratch, 'npm.tgz');
  const url = `https://registry.npmjs.org/npm/-/npm-${version}.tgz`;
  run('curl', ['--fail', '--silent', '--show-error', '--location', '--output', tarball, url], { cwd: root, env: bootstrapEnvironment(root) }, print);
  const actual = fileDigest(tarball, 'sha512');
  if (actual !== sha512) throw new Error(`npm ${version} tarball ${url} has the sha512 ${actual}; packageManager of package.json declares ${sha512}`);
  const listing = spawnSync('tar', ['-tvf', tarball], { encoding: 'utf8' });
  if (listing.status !== 0) throw new Error(`tar -tvf ${tarball} ended with exit status ${listing.status}: ${listing.stderr.trim()}`);
  // tar -tv starts the line of a file with - and the one of a directory with d.
  const links = listing.stdout.split('\n').filter(line => line && !/^[-d]/.test(line));
  if (links.length > 0) throw new Error(`the npm ${version} tarball holds a link or a special file; expected files and directories only: ${links[0]}`);
  const directory = path.join(next, 'node_modules/npm');
  mkdirSync(directory, { recursive: true });
  run('tar', ['-x', '-f', tarball, '-C', directory, '--strip-components', '1'], { cwd: root }, print);
  writeFileSync(path.join(directory, MARKER), `${sha512}\n`);
  rmSync(scratch, { recursive: true, force: true });
}

/** The wrappers of var/tools/bin that run the installed npm, each with its script of npm/bin. */
export const NPM_WRAPPERS = { npm: 'npm-cli.js', npx: 'npx-cli.js' };

/** Installs the declared npm `{ version, sha512 }` into var/tools/npm of `root` and writes the wrappers; returns `{ installed, release }`. */
export function installNpm({ root, declared, print = () => {} }: { root: string; declared: { version: string; sha512?: string | undefined }; print?: (text: string) => void }) {
  const recorded = declared.sha512 ? `${declared.version}+sha512.${declared.sha512}` : declared.version;
  const prefix = toolsPath(root, 'npm');
  const result = installOnce({
    root, label: 'npm', prefix, recorded, installedRelease, print,
    install: (next: string) => {
      writeFileSync(path.join(next, 'package.json'), '{ "private": true }\n');
      if (declared.sha512) unpackVerified({ root, next, version: declared.version, sha512: declared.sha512, print });
      else run('npm', ['install', '--prefix', next, '--no-save', '--no-package-lock', '--no-bin-links', '--no-audit', '--no-fund', `npm@${declared.version}`], { cwd: next, env: bootstrapEnvironment(root) }, print);
    },
  });
  for (const [name, cli] of Object.entries(NPM_WRAPPERS)) {
    writeWrapper(root, name, wrapperText(`${name} ${declared.version} of this checkout`, `exec node ${quote(path.join(prefix, 'node_modules/npm/bin', cli))} "$@"`), print);
  }
  return result;
}
