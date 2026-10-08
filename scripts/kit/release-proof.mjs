#!/usr/bin/env node
// Proves a released tag from outside the repository. It runs after the release exists, online, as a developer or CI command;
// no offline check runs it.
//
//   node scripts/kit/release-proof.mjs TAG
//
// For a tag vX.Y.Z it proves, one line `✔ <what>` for each step, and stops at the first step that fails:
//   1. `gh release view TAG` lists exactly the archives that config/release.json declares for the version.
//   2. The release assets, downloaded into a temporary directory, install together in clean npm and Composer projects
//      (release-consumer.mjs installConsumers, with the committed manifests and locks of the checkout) and the smoke command of
//      each package passes. Run it in a checkout of the tag, whose consumer projects name the archives of the version.
//   3. Each manifest with the mode `git-tag` installs from the tag in a clean temporary environment: a Python package with
//      `pip install "<name> @ git+<repositoryUrl>@TAG#subdirectory=<directory>"` into a new virtual environment, a Rust crate
//      as a git dependency of a temporary crate; the declared smoke command then runs in that environment.
//   4. Each Go module has its tag on the remote (`git ls-remote`) and `go list -m <module>@<tag>` resolves it with
//      GOFLAGS=-mod=mod and GOPROXY=direct.
// A tag `<Go module directory>/vX.Y.Z` releases that module alone: the release holds no archive and only step 4 runs for it.
// Every command of a step comes from config/release.json: `consumers` (smoke commands of the archives) and `proof.gitTag`.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetNames, context, parseTag } from './release.mjs';
import { run, Stop } from './process.mjs';
import { installConsumers } from './release-consumer.mjs';

/** `HOST/OWNER/REPO` of the repository URL, the form that `gh --repo` takes for any host. */
const repositoryOf = url => url.replace(/^https:\/\//, '');

/** Step 1: the names of the assets of the GitHub Release equal the archives of the tag. */
function proveAssets(ctx, tag, version, directory, step) {
  const expected = [...(directory === null ? assetNames(ctx.config, version) : [])].sort();
  const listed = JSON.parse(run('gh', ['release', 'view', tag, '--repo', repositoryOf(ctx.config.repositoryUrl), '--json', 'assets'], { cwd: ctx.root, env: ctx.env }));
  const actual = (listed.assets ?? []).map(({ name }) => name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = expected.filter(name => !actual.includes(name));
    const extra = actual.filter(name => !expected.includes(name));
    throw new Stop(`the release ${tag} lists [${actual.join(', ')}], expected [${expected.join(', ')}]${missing.length ? `; missing [${missing.join(', ')}]` : ''}${extra.length ? `; unexpected [${extra.join(', ')}]` : ''}`);
  }
  step(`the release ${tag} lists ${expected.length ? `exactly its ${expected.length} archives` : 'no archive'}`);
}

/** Step 2: download the assets into `folder/assets` and install them in clean consumer projects. */
function proveInstall(ctx, tag, version, folder, step) {
  const assets = path.join(folder, 'assets');
  mkdirSync(assets, { recursive: true });
  run('gh', ['release', 'download', tag, '--repo', repositoryOf(ctx.config.repositoryUrl), '--dir', assets], { cwd: ctx.root, env: ctx.env });
  step(`downloaded [${readdirSync(assets).sort().join(', ')}] from the release ${tag}`);
  const count = installConsumers(ctx, version, assets, text => step(text));
  step(`installed and checked ${count} packages from the release assets`);
}

/** The smoke command of a git-tag manifest, run in `cwd`. */
const smoke = (command, cwd, env) => run(command[0], command.slice(1), { cwd, env });

/** Step 3: install each git-tag manifest from the tag in a clean environment of `folder`. */
function proveGitTag(ctx, tag, folder, step) {
  const { config } = ctx;
  const files = Object.entries(config.manifests).filter(([, mode]) => mode === 'git-tag').map(([file]) => file).sort();
  for (const file of files) {
    const entry = config.proof?.gitTag?.[file];
    if (!entry) throw new Stop(`config/release.json proof.gitTag lacks ${file}, which manifests releases by "git-tag"`);
    const directory = path.posix.dirname(file);
    const work = path.join(folder, `git-tag-${files.indexOf(file)}`);
    mkdirSync(work, { recursive: true });
    if (entry.kind === 'python') {
      const environment = path.join(work, 'venv');
      run('python3', ['-m', 'venv', environment], { cwd: work, env: ctx.env });
      const bin = path.join(environment, 'bin');
      const env = { ...ctx.env, PATH: `${bin}${path.delimiter}${ctx.env.PATH}`, VIRTUAL_ENV: environment };
      const spec = `${entry.name} @ git+${config.repositoryUrl}@${tag}${directory === '.' ? '' : `#subdirectory=${directory}`}`;
      run(path.join(bin, 'python'), ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', spec], { cwd: work, env });
      smoke(entry.smoke, work, env);
      step(`${file}: pip installed ${entry.name} from ${tag} and ${entry.smoke.join(' ')} passed`);
    } else {
      const crate = path.join(work, 'crate');
      mkdirSync(path.join(crate, 'src'), { recursive: true });
      writeFileSync(path.join(crate, 'Cargo.toml'), `[package]\nname = "release-proof"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[dependencies]\n${entry.name} = { git = "${config.repositoryUrl}", tag = "${tag}" }\n`);
      writeFileSync(path.join(crate, 'src/main.rs'), 'fn main() {}\n');
      smoke(entry.smoke, crate, { ...ctx.env, CARGO_TARGET_DIR: path.join(work, 'target') });
      step(`${file}: cargo resolved ${entry.name} from ${tag} and ${entry.smoke.join(' ')} passed`);
    }
  }
}

/** Step 4: the tag of each Go module is on the remote and the Go tool resolves the module at it. */
function proveGoModules(ctx, tag, version, directory, folder, step) {
  const { config } = ctx;
  const modules = Object.entries(config.goModules).filter(([module]) => directory === null || module === directory).sort();
  const env = { ...ctx.env, GIT_TERMINAL_PROMPT: '0' };
  for (const [module, modulePath] of modules) {
    const goTag = module === '.' ? `v${version}` : `${module}/v${version}`;
    const remote = run('git', ['ls-remote', '--tags', config.repositoryUrl, `refs/tags/${goTag}`], { cwd: folder, env });
    if (!remote.split('\n').some(line => line.endsWith(`\trefs/tags/${goTag}`))) throw new Stop(`the tag ${goTag} of the Go module ${modulePath} is not on ${config.repositoryUrl}, git ls-remote lists [${remote.trim()}]`);
    const listed = run('go', ['list', '-m', `${modulePath}@v${version}`], { cwd: folder, env: { ...env, GOFLAGS: '-mod=mod', GOPROXY: 'direct', GOPATH: path.join(folder, 'gopath') } }).trim();
    if (listed !== `${modulePath} v${version}`) throw new Stop(`go list -m ${modulePath}@v${version} printed "${listed}", expected "${modulePath} v${version}"`);
    step(`the Go module ${modulePath} resolves at ${goTag}`);
  }
}

/** Runs the proof of the tag; `step(text)` reports each completed step. */
export function prove(ctx, tag, step) {
  const [directory, version] = parseTag(ctx.config, tag);
  const folder = mkdtempSync(path.join(tmpdir(), 'kit-release-proof-'));
  try {
    proveAssets(ctx, tag, version, directory, step);
    if (directory === null) {
      proveInstall(ctx, tag, version, folder, step);
      proveGitTag(ctx, tag, folder, step);
    } else {
      step(`${tag} is a Go module tag: the release holds no archive and no git-tag manifest`);
    }
    proveGoModules(ctx, tag, version, directory, folder, step);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

const USAGE = 'usage: node scripts/kit/release-proof.mjs TAG';

/** Runs the command line; the exit status. */
export function main(argv, { root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), env = process.env, print = console.log, error = console.error } = {}) {
  const [tag, ...rest] = argv;
  if (!tag || rest.length) {
    error(USAGE);
    return 2;
  }
  try {
    prove(context(root, { env }), tag, text => print(`✔ ${text}`));
  } catch (failure) {
    if (!(failure instanceof Stop) && !(failure instanceof SyntaxError) && failure?.code !== 'ENOENT') throw failure;
    error(`[release-proof] ${tag} failed: ${failure.message}`);
    return 1;
  }
  print(`✔ ${tag} is proven from outside the repository`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
