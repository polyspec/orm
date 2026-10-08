#!/usr/bin/env node
// Releases a tag of a commit of main. The steps run in this order from the release workflow, each through its make target:
//
//   node scripts/kit/release.mjs verify TAG     the tagged commit is on origin/main and its checks concluded success
//   node scripts/kit/release.mjs versions TAG   every manifest of the tag has its version, CHANGELOG has its section
//   node scripts/kit/release.mjs assets TAG     build the archive of every package of the tag into var/release/assets
//   node scripts/kit/release.mjs publish TAG    create the GitHub Release of the tag with its notes and archives
//   node scripts/kit/release.mjs go-tags TAG    every Go module has its tag <directory>/vX.Y.Z at the commit of TAG
//   node scripts/kit/release.mjs coverage       every package file of the checkout is classified in config/release.json
//
// The repository is data: config/release.json (schema scripts/kit/schema/release.schema.json) lists the packages that a
// tag releases as archives, the manifests that carry the version, the manifests that no tag releases and the Go modules.
// A tag `vX.Y.Z` releases the packages at the version X.Y.Z; a tag `<Go module directory>/vX.Y.Z` releases that Go module
// and builds no archive. No step reruns the tests: every commit of main passed the full suite before it reached main.
//
// `verify` resolves the tag to its commit, requires the commit to be an ancestor of origin/main, requires for a tag vX.Y.Z
// the tag `<directory>/vX.Y.Z` of every Go module at the same commit (`go-tags`; a Go proxy reads a module from that tag
// only) and reads the check runs of the commit from `gh api repos/<repository>/commits/<sha>/check-runs` (the repository of GITHUB_REPOSITORY): the latest run
// of each configured check must be completed with the conclusion success. `versions` compares X.Y.Z with the version of
// every manifest of `manifests` and requires the section `## X.Y.Z` in the change logs; for a Go module it requires the module
// path of the go.mod. `assets` builds one archive per package, named `<package>-<language>-<version>.<ext>` with `@scope/`
// written `scope-` and `vendor/` `vendor-` (`@scope/x` is `scope-x-npm-1.0.0.tgz`, `vendor/x` is `vendor-x-php-1.0.0.zip`):
// `npm pack` of an npm package, whose output is renamed to that name, and a `git archive` zip of the directory of a Composer
// package at the tagged commit, with stored entries, the time of the commit and TZ=UTC, so a second run of the same tag
// writes the same bytes. Each archive carries the manifest of its package unchanged, and
// the manifest names every package of its scope by an exact version (see manifestProblems). `publish` runs `gh release
// create TAG --verify-tag --title TAG --notes-file <notes>` with the archives; the notes are the section X.Y.Z, or one
// line that links the section when it is longer than NOTES_LIMIT characters, the limit of a release body.
// Each failure names the tag, the file or the check, and the expected and the actual value, and exits with status 1.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { consumerConfigProblems } from './release-consumer-config.mjs';
import { readConfig } from './schema-validate.mjs';
import { checkedFiles } from './tracked-files.mjs';
import { isMain, ROOT } from './paths.mjs';
import { execute, run, Stop } from './process.mjs';

export const MAIN = 'origin/main';
export const CONFIG = 'config/release.json';
export const ASSETS = 'var/release/assets';
export const DEFAULT_CHECKS = ['push-gate', 'ci-passed'];
// GitHub refuses a release body over 125000 characters.
export const NOTES_LIMIT = 125000;
export const MODES = ['archive', 'version', 'git-tag'];
// The files of a checkout that carry the version or the module of a package; coverage requires each to be classified.
export const PACKAGE_FILES = ['package.json', 'composer.json', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'VERSION'];
const MANIFEST_FILES = PACKAGE_FILES.filter(name => name !== 'go.mod');
const TAG = /^(?:(?<directory>[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)\/)?v(?<version>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const MANIFEST_OF = { npm: 'package.json', composer: 'composer.json' };
// The language and the extension of the archive of each package kind: an npm tarball and a Composer zip.
const ARCHIVE_FORMAT = { npm: ['npm', 'tgz'], composer: ['php', 'zip'] };
const NPM_DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const COMPOSER_DEPENDENCY_FIELDS = ['require', 'require-dev'];

/**
 * The configuration of the repository at `root`: config/release.json validated against its schema and for the rules that the
 * schema cannot express (the values of the maps, the packages against the manifests). Stop with every finding.
 */
export function loadConfig(root) {
  const file = path.join(root, CONFIG);
  if (!existsSync(file)) throw new Stop(`${CONFIG}: the file is missing; a repository that releases declares its packages in it`);
  const { value: config, errors: problems } = readConfig(root, CONFIG, 'release.schema.json');
  if (problems.length) throw new Stop(problems.join('; '));
  const reason = (map, where, check) => {
    for (const [key, value] of Object.entries(config[map])) {
      const found = check(key, value);
      if (found) problems.push(`${CONFIG}: ${where}.${key} ${found}`);
    }
  };
  reason('manifests', 'manifests', (key, value) => (!MANIFEST_FILES.includes(path.posix.basename(key))
    ? `is not a ${MANIFEST_FILES.join(', ')} file`
    : MODES.includes(value) ? null : `is ${JSON.stringify(value)}, the allowed values are ${MODES.join(', ')}`));
  reason('notReleased', 'notReleased', (key, value) => (typeof value === 'string' && value.trim() ? null : 'needs a reason, a non-empty string'));
  reason('goModules', 'goModules', (key, value) => (typeof value === 'string' && value ? null : 'needs the module path of its go.mod'));
  for (const key of Object.keys(config.manifests)) if (key in config.notReleased) problems.push(`${CONFIG}: ${key} is in both manifests and notReleased`);
  const names = new Set();
  const directories = new Set();
  for (const { kind, directory, name } of config.packages) {
    const shape = kind === 'npm' ? /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/ : /^[a-z0-9._-]+\/[a-z0-9._-]+$/;
    if (!shape.test(name)) problems.push(`${CONFIG}: the ${kind} package ${name} is not a ${kind === 'npm' ? '`name` or `@scope/name`' : '`vendor/name`'}`);
    if (names.has(`${kind}:${name}`)) problems.push(`${CONFIG}: the ${kind} package ${name} is listed twice`);
    if (directories.has(directory)) problems.push(`${CONFIG}: the directory ${directory} holds two packages`);
    names.add(`${kind}:${name}`);
    directories.add(directory);
    const manifest = `${directory}/${MANIFEST_OF[kind]}`;
    if (config.manifests[manifest] !== 'archive') problems.push(`${CONFIG}: the package ${name} needs manifests.${manifest} = "archive", found ${JSON.stringify(config.manifests[manifest] ?? null)}`);
  }
  const archived = new Set(config.packages.map(({ directory, kind }) => `${directory}/${MANIFEST_OF[kind]}`));
  for (const [key, value] of Object.entries(config.manifests)) {
    if (value === 'archive' && !archived.has(key)) problems.push(`${CONFIG}: manifests.${key} is "archive" but no package of packages has that manifest`);
  }
  if (new Set(assetNames(config, '1.0.0')).size !== config.packages.length) problems.push(`${CONFIG}: two packages have the same archive name`);
  problems.push(...consumerConfigProblems(config).map(problem => `${CONFIG}: ${problem}`));
  if (problems.length) throw new Stop(problems.join('; '));
  return { checks: DEFAULT_CHECKS, changelogTranslations: [], ...config };
}

const at = ctx => ({ cwd: ctx.root, env: ctx.env });

/** A command context: the repository root, its configuration, the environment of its commands and a log function. */
export function context(root, { config = loadConfig(root), env = process.env, log = () => {} } = {}) {
  return { root, config, env, log };
}

/** [Go module directory or null, version] of a release tag. */
export function parseTag(config, tag) {
  const found = TAG.exec(tag);
  if (!found) throw new Stop(`${tag}: a release tag is vX.Y.Z or <Go module directory>/vX.Y.Z`);
  const directory = found.groups.directory ?? null;
  if (directory !== null && (directory === '.' || !(directory in config.goModules))) {
    throw new Stop(`${tag}: ${directory} is not a Go module directory; the Go modules are [${Object.keys(config.goModules).filter(item => item !== '.').sort().join(', ')}]`);
  }
  return [directory, found.groups.version];
}

const taggedCommit = (ctx, tag) => run('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], at(ctx)).trim();

/**
 * The problems of the Go module tags of a tag vX.Y.Z: each declared Go module below the root needs the tag
 * `<directory>/vX.Y.Z` at the commit of vX.Y.Z, because a Go proxy resolves the module from that tag. A missing tag and a tag at
 * another commit name the git command that creates it. A Go module tag releases that module only and has no sibling tags.
 */
export function goTagProblems(ctx, tag) {
  const [directory, version] = parseTag(ctx.config, tag);
  if (directory !== null) return [];
  const commit = taggedCommit(ctx, tag);
  const problems = [];
  for (const [module, modulePath] of Object.entries(ctx.config.goModules).sort()) {
    if (module === '.') continue;
    const goTag = `${module}/v${version}`;
    const found = execute('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${goTag}^{commit}`], at(ctx));
    const create = `git tag -a ${goTag} -m ${goTag} ${commit} && git push origin ${goTag}`;
    if (found.status !== 0) problems.push(`the Go module tag ${goTag} is missing; a Go proxy resolves ${modulePath} from it. Fix: ${create}`);
    else if (found.stdout.trim() !== commit) problems.push(`the Go module tag ${goTag} is at ${found.stdout.trim()}, the tag ${tag} is at ${commit}. Fix: git tag -d ${goTag} && ${create}`);
  }
  return problems;
}

/** The tagged commit is on main, its Go module tags exist and the latest run of every configured check concluded success: { commit, checks }. */
export function verify(ctx, tag) {
  parseTag(ctx.config, tag);
  const repository = ctx.repository ?? ctx.env.GITHUB_REPOSITORY;
  if (!repository) throw new Stop('GITHUB_REPOSITORY is not set; it names the repository <owner>/<name> whose check runs are read');
  const commit = taggedCommit(ctx, tag);
  const problems = [];
  const ancestry = execute('git', ['merge-base', '--is-ancestor', commit, MAIN], at(ctx));
  if (ancestry.status === 1) problems.push(`the commit is not on ${MAIN}; a release tags a commit of main`);
  else if (ancestry.status !== 0) throw new Stop(`git merge-base --is-ancestor ${commit} ${MAIN} exited with ${ancestry.status}: ${(ancestry.stderr ?? '').trim()}`);
  ctx.log(`[release] ${tag}: reading the Go module tags of ${Object.keys(ctx.config.goModules).filter(item => item !== '.').length} modules`);
  problems.push(...goTagProblems(ctx, tag));
  ctx.log(`[release] ${tag}: reading the check runs of ${commit} in ${repository}`);
  const listed = run('gh', ['api', '--paginate', `repos/${repository}/commits/${commit}/check-runs?per_page=100`, '--jq', '.check_runs[] | [.id, .name, .status, .conclusion] | @json'], at(ctx));
  const runs = listed.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  for (const name of ctx.config.checks) {
    const named = runs.filter(entry => entry[1] === name);
    if (named.length === 0) {
      problems.push(`the check ${name} is missing`);
      continue;
    }
    // A rerun of a check is a new run with a greater id; the latest run decides.
    const [, , status, conclusion] = named.reduce((latest, entry) => (entry[0] > latest[0] ? entry : latest));
    if (status !== 'completed' || conclusion !== 'success') problems.push(`the check ${name} is ${status} with the conclusion ${conclusion}, not success`);
  }
  if (problems.length) throw new Stop(`${tag}: the commit ${commit}: ${problems.join('; ')}`);
  return { commit, checks: [...ctx.config.checks] };
}

/** The version that a manifest file declares, or null without one. A composer.json may omit it: Composer takes the tag. */
export function manifestVersion(file) {
  const text = readFileSync(file, 'utf8');
  const name = path.basename(file);
  if (name === 'package.json' || name === 'composer.json') return JSON.parse(text).version ?? null;
  if (name === 'VERSION') return text.trim() || null;
  const heading = name === 'Cargo.toml' ? 'package' : name === 'pyproject.toml' ? 'project' : null;
  if (heading === null) throw new Stop(`${name}: not a manifest of a release`);
  const section = new RegExp(`^\\[${heading}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm').exec(text);
  return /^version\s*=\s*"([^"]*)"/m.exec(section?.[1] ?? '')?.[1] ?? null;
}

/** The body of the section `## version` of the change log `file`, without the anchor of the next section. */
export function changelogSection(root, file, version) {
  const lines = readFileSync(path.join(root, file), 'utf8').split('\n').map(line => line.trimEnd());
  const heading = lines.indexOf(`## ${version}`);
  if (heading === -1) throw new Stop(`${file}: no section ## ${version}`);
  let end = lines.findIndex((line, index) => index > heading && line.startsWith('## '));
  if (end === -1) end = lines.length;
  const body = lines.slice(heading + 1, end);
  while (body.length && (!body.at(-1).trim() || /^<a id="[^"]*"><\/a>$/.test(body.at(-1).trim()))) body.pop();
  while (body.length && !body[0].trim()) body.shift();
  if (!body.length) throw new Stop(`${file}: the section ## ${version} has no entry`);
  return `${body.join('\n')}\n`;
}

/** The anchor of the section `## version`: the id of an `<a id>` line above it, else the version without its dots. */
export function changelogAnchor(root, file, version) {
  const lines = readFileSync(path.join(root, file), 'utf8').split('\n').map(line => line.trim());
  let index = lines.indexOf(`## ${version}`) - 1;
  while (index >= 0 && !lines[index]) index -= 1;
  const explicit = index >= 0 ? /^<a id="([^"]+)"><\/a>$/.exec(lines[index]) : null;
  return explicit ? explicit[1] : version.replaceAll('.', '');
}

/** The notes of the release of the tag: the section when it has at most NOTES_LIMIT characters, otherwise one linking line. */
export function releaseNotes(ctx, tag) {
  const [, version] = parseTag(ctx.config, tag);
  const { changelog, repositoryUrl } = ctx.config;
  const section = changelogSection(ctx.root, changelog, version);
  if ([...section].length <= NOTES_LIMIT) return section;
  const tagPath = tag.split('/').map(encodeURIComponent).join('/');
  return `The changes of ${version} are listed in [${path.posix.basename(changelog)}](${repositoryUrl}/blob/${tagPath}/${changelog}#${changelogAnchor(ctx.root, changelog, version)}).\n`;
}

/** The module path that the go.mod of `directory` declares, or null. */
function goModulePath(root, directory) {
  const file = path.join(root, directory === '.' ? '' : directory, 'go.mod');
  return existsSync(file) ? /^module\s+(\S+)\s*$/m.exec(readFileSync(file, 'utf8'))?.[1] ?? null : null;
}

/** Every manifest of the tag declares its version and the change logs have the section of the version: the version. */
export function versions(ctx, tag) {
  const { root, config } = ctx;
  const [directory, version] = parseTag(config, tag);
  const problems = [];
  if (directory === null) {
    for (const [name, mode] of Object.entries(config.manifests)) {
      ctx.log(`[release] ${tag}: reading the version of ${name}`);
      const declared = manifestVersion(path.join(root, name));
      // A package that is released as an archive declares its version; Composer takes it from the tag for other manifests.
      const missingOk = declared === null && path.basename(name) === 'composer.json' && mode !== 'archive';
      if (declared !== version && !missingOk) problems.push(`${name}: version ${declared ?? 'none'}, the tag ${tag} is ${version}`);
    }
  }
  for (const [module, expected] of Object.entries(config.goModules)) {
    if (directory !== null && directory !== module) continue;
    const declared = goModulePath(root, module);
    const file = `${module === '.' ? '' : `${module}/`}go.mod`;
    if (declared !== expected) problems.push(`${file}: module ${declared ?? 'none'}, the tag ${tag} is ${expected}`);
  }
  for (const file of [config.changelog, ...config.changelogTranslations]) {
    try {
      changelogSection(root, file, version);
    } catch (error) {
      if (!(error instanceof Stop) && error?.code !== 'ENOENT') throw error;
      problems.push(`${error instanceof Stop ? error.message : `${file}: the file is missing`} for the tag ${tag}`);
    }
  }
  if (problems.length) throw new Stop(problems.join('; '));
  return version;
}

/**
 * <package>-<language>-<version>.<ext>: `@scope/name` is written `scope-name` and `vendor/name` `vendor-name`, the language
 * is `npm` for an npm package and `php` for a Composer package: `@scope/x` is `scope-x-npm-1.0.0.tgz` and `vendor/x` is
 * `vendor-x-php-1.0.0.zip`.
 */
export function assetName(name, language, version, extension) {
  return `${name.replace(/^@/, '').replaceAll('/', '-')}-${language}-${version}.${extension}`;
}

/** The archive names of the packages at `version`, in the order of the configuration. */
export function assetNames(config, version) {
  return config.packages.map(({ kind, name }) => assetName(name, ARCHIVE_FORMAT[kind][0], version, ARCHIVE_FORMAT[kind][1]));
}

const SOURCE_FORMS = [
  [/^(?:file|link|workspace|portal):/, 'a path of the repository'],
  [/^(?:git(?:\+[a-z]+)?:|github:|gitlab:|bitbucket:|ssh:|git@)|\.git(?:#|$)/, 'a git source'],
  [/^[a-z][a-z0-9+.-]*:\/\//i, 'a URL'],
  [/@dev\b|^dev-|-dev$/, 'a development version'],
];

/** The form of a dependency spec that is not an exact version. */
function specForm(spec) {
  for (const [pattern, form] of SOURCE_FORMS) if (pattern.test(spec)) return form;
  return EXACT_VERSION.test(spec) ? 'another version' : 'a range';
}

/** The scopes of the packages of `kind`: `@scope/` of an npm package, `vendor/` of a Composer package. */
function scopesOf(config, kind) {
  return new Set(config.packages.filter(item => item.kind === kind).map(({ name }) => name.slice(0, name.indexOf('/') + 1)).filter(Boolean));
}

/**
 * The problems of a manifest that an archive of `kind` carries at `version`. A consumer installs the archives together
 * without the repository, so a dependency is a registry version: no path, URL, git source or development version. A dependency on a
 * package of a scope of this repository is one exact version, and the version of a package of this repository is the
 * version of the tag. A package.json declares no `overrides`; a composer.json declares the version of the tag and no
 * `repositories`.
 */
export function manifestProblems(config, kind, manifest, version) {
  const problems = [];
  const ours = new Set(config.packages.filter(item => item.kind === kind).map(({ name }) => name));
  const scopes = scopesOf(config, kind);
  const fields = kind === 'npm' ? NPM_DEPENDENCY_FIELDS : COMPOSER_DEPENDENCY_FIELDS;
  for (const field of fields) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      const form = specForm(String(spec));
      const sourced = form !== 'a range' && form !== 'another version';
      const ofScope = [...scopes].some(scope => name.startsWith(scope));
      if (sourced) problems.push(`${field} ${name}: ${spec} is ${form}, not a registry version`);
      else if (ours.has(name) ? spec !== version : ofScope && !EXACT_VERSION.test(spec)) problems.push(`${field} ${name}: ${spec} is ${form}, not ${ours.has(name) ? version : 'an exact version'}`);
    }
  }
  if (kind === 'npm' && 'overrides' in manifest) problems.push(`overrides: ${JSON.stringify(manifest.overrides)}; a published package.json resolves only by name and version`);
  if (kind === 'composer') {
    if (manifest.version !== version) problems.push(`version: ${manifest.version ?? 'none'}, not ${version}`);
    if ('repositories' in manifest) problems.push(`repositories: ${JSON.stringify(manifest.repositories)}; a release zip declares none`);
  }
  return problems;
}

/** The manifest text that an archive carries: package/package.json of a tarball, composer.json at the root of a zip. */
export function packedManifest(ctx, file) {
  return file.endsWith('.tgz') ? run('tar', ['-xzOf', file, 'package/package.json'], at(ctx)) : run('unzip', ['-p', file, 'composer.json'], at(ctx));
}

/**
 * Builds the archive of every package of the tag into var/release/assets and returns their names. The manifests of the
 * tagged commit must pass manifestProblems before a package is packed, and each archive must carry the manifest of its
 * package at the commit byte for byte, because no step rewrites a manifest. The directory is replaced as a whole.
 */
export function assets(ctx, tag) {
  const { root, config } = ctx;
  const [directory, version] = parseTag(config, tag);
  const target = path.join(root, ASSETS);
  rmSync(target, { recursive: true, force: true });
  if (directory !== null) {
    ctx.log(`[release] ${tag}: a Go module tag builds no archive`);
    mkdirSync(target, { recursive: true });
    return [];
  }
  const commit = taggedCommit(ctx, tag);
  const names = assetNames(config, version);
  const sources = config.packages.map(({ kind, directory: folder }) => run('git', ['show', `${commit}:${folder}/${MANIFEST_OF[kind]}`], at(ctx)));
  const problems = config.packages.flatMap(({ kind, directory: folder, name }, index) => {
    const file = `${folder}/${MANIFEST_OF[kind]}`;
    const manifest = JSON.parse(sources[index]);
    return [
      ...(manifest.name === name ? [] : [`${file}: name ${manifest.name ?? 'none'}, ${CONFIG} declares ${name}`]),
      ...manifestProblems(config, kind, manifest, version).map(problem => `${file}: ${problem}`),
    ];
  });
  if (problems.length) throw new Stop(`${tag}: the manifests of the commit ${commit} do not install outside the repository: ${problems.join('; ')}`);
  const mtime = new Date(Number(run('git', ['show', '-s', '--format=%ct', commit], at(ctx)).trim()) * 1000).toISOString();
  const next = `${target}.next-${process.pid}`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true });
  try {
    config.packages.forEach(({ kind, directory: folder, name }, index) => {
      ctx.log(`[release] ${tag}: packing ${name} from ${folder} into ${names[index]}`);
      if (kind === 'npm') {
        const before = new Set(readdirSync(next));
        run('npm', ['pack', '--pack-destination', next], { cwd: path.join(root, folder), env: ctx.env });
        // npm pack names its output itself; the single new file is renamed to the archive name.
        const created = readdirSync(next).filter(item => !before.has(item));
        if (created.length !== 1) throw new Stop(`npm pack of ${folder} wrote [${created.join(', ')}], not one archive`);
        renameSync(path.join(next, created[0]), path.join(next, names[index]));
      } else {
        // Stored entries, the time of the commit and TZ=UTC give the zip of a tree the same bytes on every machine and at
        // every time: `git archive` of a tree writes the current time without --mtime, and a zip stores local time.
        run('git', ['archive', '--format=zip', '-0', `--mtime=${mtime}`, `--output=${path.join(next, names[index])}`, `${commit}:${folder}`], { cwd: root, env: { ...ctx.env, TZ: 'UTC' } });
      }
    });
    const present = readdirSync(next).sort();
    if (JSON.stringify(present) !== JSON.stringify([...names].sort())) throw new Stop(`${ASSETS} holds [${present.join(', ')}], not the archives [${[...names].sort().join(', ')}]`);
    const failures = config.packages.flatMap(({ kind, directory: folder }, index) => {
      const file = MANIFEST_OF[kind];
      const packed = packedManifest(ctx, path.join(next, names[index]));
      return [
        ...(packed === sources[index] ? [] : [`${names[index]}: the packed ${file} differs from ${folder}/${file} of the commit ${commit}`]),
        ...manifestProblems(config, kind, JSON.parse(packed), version).map(problem => `${names[index]}: ${problem}`),
      ];
    });
    if (failures.length) throw new Stop(`${tag}: the release assets do not install outside the repository: ${failures.join('; ')}`);
    renameSync(next, target);
  } finally {
    rmSync(next, { recursive: true, force: true });
  }
  return names;
}

/** Creates the GitHub Release of the tag with the notes of releaseNotes and the archives of assets. */
export function publish(ctx, tag) {
  const { root, config } = ctx;
  const [directory, version] = parseTag(config, tag);
  const notes = releaseNotes(ctx, tag);
  const names = directory === null ? assetNames(config, version) : [];
  const target = path.join(root, ASSETS);
  const missing = names.filter(name => !existsSync(path.join(target, name)));
  if (missing.length) throw new Stop(`${ASSETS} lacks [${missing.join(', ')}]; make release-assets builds them`);
  const folder = mkdtempSync(path.join(tmpdir(), 'kit-release-notes-'));
  try {
    const notesFile = path.join(folder, 'notes.md');
    writeFileSync(notesFile, notes);
    ctx.log(`[release] ${tag}: creating the GitHub Release with ${names.length} archives`);
    run('gh', ['release', 'create', tag, '--verify-tag', '--title', tag, '--notes-file', notesFile, ...names.map(name => path.join(target, name))], at(ctx));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  return names;
}

/**
 * The problems of the classification of the package files of the checkout: every tracked or new file named package.json,
 * composer.json, Cargo.toml, pyproject.toml, go.mod or VERSION is a key of `manifests` or `notReleased`, or the go.mod of a
 * Go module; a listed file exists; no file is in two lists.
 */
export function coverage(ctx) {
  const { root, config } = ctx;
  const files = checkedFiles(root).filter(file => PACKAGE_FILES.includes(path.posix.basename(file)));
  const goFiles = Object.keys(config.goModules).map(module => `${module === '.' ? '' : `${module}/`}go.mod`);
  const lists = { manifests: Object.keys(config.manifests), notReleased: Object.keys(config.notReleased), goModules: goFiles };
  const problems = [];
  const where = new Map();
  for (const [list, keys] of Object.entries(lists)) {
    for (const key of keys) {
      if (where.has(key)) problems.push(`${key} is in both ${where.get(key)} and ${list} of ${CONFIG}; list it once`);
      where.set(key, list);
      if (!files.includes(key)) problems.push(`${key} is listed in ${list} of ${CONFIG} but is not a package file of the checkout; remove it from the list`);
    }
  }
  for (const file of files) {
    if (!where.has(file)) problems.push(`${file} is neither released nor listed as not released; add it to manifests, notReleased or goModules in ${CONFIG}`);
  }
  return problems;
}

const USAGE = 'usage: node scripts/kit/release.mjs verify|versions|assets|publish|go-tags TAG | coverage';

/** Runs a step of the command line; the exit status. */
export function main(argv, { root = ROOT, env = process.env, print = console.log, error = console.error } = {}) {
  const [mode, tag, ...rest] = argv;
  const tagged = ['verify', 'versions', 'assets', 'publish', 'go-tags'].includes(mode);
  if (!(tagged && tag && rest.length === 0) && !(mode === 'coverage' && tag === undefined)) {
    error(USAGE);
    return 2;
  }
  try {
    const ctx = context(root, { env, log: print });
    if (mode === 'coverage') {
      const problems = coverage(ctx);
      for (const problem of problems) error(`[release] coverage: ${problem}`);
      if (problems.length) {
        error(`[release] coverage failed: ${problems.length} package files are not classified`);
        return 1;
      }
      print(`[release] coverage: every package file is classified in ${CONFIG}`);
    } else if (mode === 'verify') {
      const { commit, checks } = verify(ctx, tag);
      print(`[release] ${tag}: the commit ${commit} is on ${MAIN} and passed ${checks.join(', ')}`);
    } else if (mode === 'go-tags') {
      const problems = goTagProblems(ctx, tag);
      for (const problem of problems) error(`[release] go-tags ${tag}: ${problem}`);
      if (problems.length) {
        error(`[release] go-tags ${tag} failed: ${problems.length} Go module tags are missing or at another commit`);
        return 1;
      }
      print(`[release] ${tag}: every Go module has its tag at the commit of ${tag}`);
    } else if (mode === 'versions') {
      const version = versions(ctx, tag);
      print(`[release] ${tag}: every manifest of the tag declares ${version} and ${ctx.config.changelog} has ## ${version}`);
    } else if (mode === 'assets') {
      const names = assets(ctx, tag);
      print(`[release] ${tag}: built ${names.length ? names.join(', ') : 'no archive (a Go module)'} in ${ASSETS}`);
    } else {
      const names = publish(ctx, tag);
      print(`[release] ${tag}: created the GitHub Release with ${names.length ? names.join(', ') : 'no archive'}`);
    }
  } catch (failure) {
    if (!(failure instanceof Stop) && !(failure instanceof SyntaxError) && failure?.code !== 'ENOENT') throw failure;
    error(`[release] ${mode}${tag ? ` ${tag}` : ''} failed: ${failure.message}`);
    return 1;
  }
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
