#!/usr/bin/env node
// Proves a released tag from outside the repository, online. The release workflow (workflows/release.yml) runs it on the draft
// after make release-publish, in the same job; a failed proof fails that run and the release stays a draft. A developer may
// run it for any released tag.
//
//   node scripts/kit/release-proof.mjs TAG
//
// For a tag vX.Y.Z it proves, one line `✔ <what>` for each step, and stops at the first step that fails:
//   1. The GitHub Release of TAG, a draft included, lists exactly the archives that config/release.json declares for the version.
//   2. Each polyspec archive that a wheel lock names (consumers.wheel.lock) is the release asset of its version in its repository
//      (consumers.wheel.polyspec): the release lists the file, and the sha256 of the downloaded file is the one the lock holds.
//   3. The release assets, downloaded into a temporary directory, install together in clean npm and Composer projects
//      (release-consumer.mjs installConsumers, with the committed manifests and locks of the checkout) and the smoke command of
//      each package passes. Run it in a checkout of the tag, whose consumer projects name the archives of the version.
//   4. Each manifest with the mode `git-tag` installs from the tag: a Rust crate as a git dependency of a temporary crate, and
//      the declared smoke command runs in that crate. A Python package is a `wheel` package: its wheel is an archive of step 2.
//   5. Each Go module has its tag on the remote (`git ls-remote`) and `go list -m <module>@<tag>` resolves it with
//      GOFLAGS=-mod=mod and GOPROXY=direct.
// A tag `<Go module directory>/vX.Y.Z` releases that module alone: the release holds no archive and only step 4 runs for it.
// Every command of a step comes from config/release.json: `consumers` (smoke commands of the archives) and `proof.gitTag`.
//   TAG is `latest` for the newest root release tag reachable from HEAD.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetNames, context, latestTag, parseTag } from './release.mjs';
import { downloadAsset, releaseOf } from './github-release.mjs';
import { run, Stop } from './process.mjs';
import { installConsumers } from './release-consumer.mjs';
import { readPylock } from './pylock.mjs';
import { fileDigest } from './digest.mjs';
import { repositoryOf, wheelLocks } from './wheel-dependencies.mjs';

/** Step 1: the names of the assets of the GitHub Release (a draft included) equal the archives of the tag. */
function proveAssets(ctx, tag, version, directory, step) {
  const expected = [...(directory === null ? assetNames(ctx.config, version) : [])].sort();
  const release = releaseOf({ cwd: ctx.root, env: ctx.env }, ctx.config.repositoryUrl, tag);
  if (!release) throw new Stop(`the release ${tag} does not exist; make release-publish creates it as a draft`);
  const actual = release.assets.map(({ name }) => name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = expected.filter(name => !actual.includes(name));
    const extra = actual.filter(name => !expected.includes(name));
    throw new Stop(`the release ${tag} lists [${actual.join(', ')}], expected [${expected.join(', ')}]${missing.length ? `; missing [${missing.join(', ')}]` : ''}${extra.length ? `; unexpected [${extra.join(', ')}]` : ''}`);
  }
  step(`the ${release.draft ? 'draft' : 'public'} release ${tag} lists ${expected.length ? `exactly its ${expected.length} archives` : 'no archive'}`);
  return release;
}

/**
 * Step 2: each polyspec archive that a wheel lock names is downloaded from the release of its version in the repository that
 * consumers.wheel.polyspec declares, and its sha256 must be the one the lock holds (the fragment of the Requires-Dist is the same
 * sha256, checked offline by release-assets).
 */
function proveDependencies(ctx, folder, step) {
  const { root, env, config } = ctx;
  for (const { file, text } of wheelLocks(root, config)) {
    for (const entry of readPylock(text, file).packages.filter(item => item.kind === 'archive')) {
      const repository = repositoryOf(config.consumers.wheel.polyspec, entry.name);
      if (repository === null) throw new Stop(`${file} names the archive of ${entry.name}, which consumers.wheel.polyspec does not declare`);
      const asset = path.posix.basename(entry.files[0].url);
      const release = releaseOf({ cwd: root, env }, repository, `v${entry.version}`);
      if (!release) throw new Stop(`the release v${entry.version} of ${repository} does not exist; ${file} names its asset ${asset}`);
      const found = release.assets.find(item => item.name === asset);
      if (!found) throw new Stop(`the release v${entry.version} of ${repository} lists no ${asset}; ${file} names it`);
      const target = path.join(folder, 'dependencies', asset);
      mkdirSync(path.dirname(target), { recursive: true });
      downloadAsset({ cwd: root, env }, repository, found.id, target);
      const actual = fileDigest(target);
      if (actual !== entry.files[0].sha256) throw new Stop(`${asset} of ${repository} v${entry.version} has the sha256 ${actual}, ${file} holds ${entry.files[0].sha256} for ${entry.name}`);
      step(`polyspec ${entry.name} ${entry.version}: ${asset} of ${repository} has the sha256 that ${file} holds`);
    }
  }
}

/** Step 3: download the assets of the release into `folder/assets` and install them in clean consumer projects. */
function proveInstall(ctx, tag, version, folder, release, step) {
  const assets = path.join(folder, 'assets');
  mkdirSync(assets, { recursive: true });
  for (const { id, name } of release.assets) downloadAsset({ cwd: ctx.root, env: ctx.env }, ctx.config.repositoryUrl, id, path.join(assets, name));
  step(`downloaded [${readdirSync(assets).sort().join(', ')}] from the release ${tag}`);
  const count = installConsumers(ctx, version, assets, text => step(text));
  step(`installed and checked ${count} packages from the release assets`);
}

/** The smoke command of a git-tag manifest, run in `cwd`. */
const smoke = (command, cwd, env) => run(command[0], command.slice(1), { cwd, env });

/** Step 3: install each git-tag manifest (a Rust crate) from the tag as a git dependency of a temporary crate. */
function proveGitTag(ctx, tag, folder, step) {
  const { config } = ctx;
  const files = Object.entries(config.manifests).filter(([, mode]) => mode === 'git-tag').map(([file]) => file).sort();
  for (const file of files) {
    const entry = config.proof?.gitTag?.[file];
    if (!entry) throw new Stop(`config/release.json proof.gitTag lacks ${file}, which manifests releases by "git-tag"`);
    const work = path.join(folder, `git-tag-${files.indexOf(file)}`);
    const crate = path.join(work, 'crate');
    mkdirSync(path.join(crate, 'src'), { recursive: true });
    writeFileSync(path.join(crate, 'Cargo.toml'), `[package]\nname = "release-proof"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[dependencies]\n${entry.name} = { git = "${config.repositoryUrl}", tag = "${tag}" }\n`);
    writeFileSync(path.join(crate, 'src/main.rs'), 'fn main() {}\n');
    smoke(entry.smoke, crate, { ...ctx.env, CARGO_TARGET_DIR: path.join(work, 'target') });
    step(`${file}: cargo resolved ${entry.name} from ${tag} and ${entry.smoke.join(' ')} passed`);
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
    const release = proveAssets(ctx, tag, version, directory, step);
    if (directory === null) {
      proveDependencies(ctx, folder, step);
      proveInstall(ctx, tag, version, folder, release, step);
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
  const [latest, ...rest] = argv;
  let tag = latest;
  if (!tag || rest.length) {
    error(USAGE);
    return 2;
  }
  try {
    if (tag === 'latest') tag = latestTag(context(root, { env }));
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
