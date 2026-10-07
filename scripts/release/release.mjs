// release는 release workflow(.github/workflows/release.yml)가 tag의 push에서 실행하는 GitHub Release다(AGENTS.md
// "Releases"). 모든 변경은 merge queue의 필수 check를 지나 main에 들어오므로 main의 commit은 모두 전체 CI를 통과했다.
// maintainer가 main의 commit에 `vX.Y.Z`(Go module이 하위 directory에 있으면 `<dir>/vX.Y.Z`)를 tag하면 workflow가 네 make
// 단계를 차례로 실행하고, 각 단계는 이 script의 action 하나다:
//   verify    tag한 commit이 main에 있고(`git merge-base --is-ancestor <sha> origin/main`), 그 commit의 GitHub check run에서
//             push-gate와 ci-passed의 가장 최근 run이 success인지 확인한다. test는 다시 실행하지 않는다.
//   versions  root tag는 RELEASED의 모든 manifest와 VERSION이 tag의 version을 선언하는지(version 없는 composer.json은 tag의
//             version을 쓴다), go.mod가 그 directory의 module path를 선언하는지, CHANGELOG.md와 CHANGELOG.ko.md에 section
//             `## X.Y.Z`가 있는지 확인한다. Go module tag는 그 go.mod와 변경 이력만 확인한다. 실패는 file과 두 값을 적는다.
//   assets    root tag의 asset을 .runtime/release/assets에 만든다: npm package는 `npm pack`, Composer package는 그 directory의
//             `git archive` zip(Composer가 설치하는 내용)이다. packed manifest는 polyspec dependency를 정확한 version으로
//             선언하고, packed composer.json은 `repositories` 없이 tag의 `version`을 가지며, 단계는 asset마다 이를 확인한다
//             (buildAssets, packedManifestErrors). 이름은 <package-name>-<version>.<ext>이고 `@scope/`는 `scope-`,
//             Composer의 `vendor/`는 `vendor-`가 된다. Rust crate와 Go module은 asset이 없다: Cargo는 0.1까지 git
//             dependency와 tag로 의존하고, Go는 tag로 module을 얻는다. Go module tag는 아무것도 만들지 않는다.
//   publish   CHANGELOG.md의 section X.Y.Z를 notes로, assets가 만든 asset과 함께 `gh release create <tag> --verify-tag`를
//             실행한다. section이 GitHub release 본문의 한도 NOTES_LIMIT자를 넘으면 notes는 tag의 CHANGELOG.md에서 그
//             section을 가리키는 한 줄이다(releaseNotes).
//
// Usage: [GITHUB_REPOSITORY=<owner>/<repo>] node scripts/release/release.mjs verify|versions|assets|publish <tag>
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// REQUIRED_CHECKS는 tag한 commit이 통과해야 하는 GitHub check다: .github/ruleset.json이 main에 요구하는 check와 같다.
export const REQUIRED_CHECKS = ['push-gate', 'ci-passed'];

// CHECK_RUNS는 gh api의 check run마다 줄 하나(이름, 상태, 결론, 시작 시각을 tab으로 나눈)를 쓰는 jq filter다.
export const CHECK_RUNS = '.check_runs[] | [.name, .status, (.conclusion // ""), .started_at] | @tsv';

// GO_MODULE은 저장소 root의 Go module path다. 하위 directory의 module은 이 path 아래 그 directory다.
export const GO_MODULE = 'github.com/polyspec/orm';

// RELEASED는 root tag `vX.Y.Z`가 release하는 manifest다. kind는 version을 읽고 asset을 만드는 방법이다: npm과 composer는
// asset을 가지고, cargo는 version만 확인하며(asset 없음), go는 module path만 확인한다.
export const RELEASED = [
  { path: 'clients/typescript/package.json', kind: 'npm' },
  { path: 'clients/php/composer.json', kind: 'composer' },
  { path: 'clients/php-extension/composer.json', kind: 'composer' },
  { path: 'clients/rust/orm-schema/Cargo.toml', kind: 'cargo' },
  { path: 'clients/rust/orm/Cargo.toml', kind: 'cargo' },
  { path: 'clients/rust/orm-build/Cargo.toml', kind: 'cargo' },
  { path: 'go.mod', kind: 'go' },
];

// NOT_RELEASED는 release하지 않는 추적된 manifest와 그 이유다. 추적된 manifest는 모두 RELEASED나 여기에 있다(release-check).
export const NOT_RELEASED = {
  'package.json': 'the private npm workspace of the repository tools',
  'clients/rust/Cargo.toml': 'the Cargo workspace of the Rust crates, no package of its own',
  'clients/rust/case-clock/Cargo.toml': 'a test support crate of the Rust client (publish = false)',
  'clients/rust/case-database/Cargo.toml': 'a test support crate of the Rust client (publish = false)',
  'clients/rust/testcase/Cargo.toml': 'a test support crate of the Rust client (publish = false)',
  'clients/rust/tests/Cargo.toml': 'the integration tests of the Rust client (publish = false)',
  'bench/rust/Cargo.toml': 'the benchmark crate of the Rust client',
  'tests/interfaces/rust/Cargo.toml': 'the interface check crate of the Rust client',
};

// MANIFESTS는 manifest file의 이름이다. 추적된 이 이름의 file은 RELEASED나 NOT_RELEASED에 있어야 한다.
export const MANIFESTS = /(?:^|\/)(?:package\.json|composer\.json|Cargo\.toml|go\.mod|pyproject\.toml)$/;
export const CHANGELOGS = ['CHANGELOG.md', 'CHANGELOG.ko.md'];
// RELEASE_DIR은 assets 단계가 asset과 그 목록을 쓰고 publish 단계가 읽는 directory다(git이 무시하는 .runtime 아래).
export const RELEASE_DIR = '.runtime/release';
const EXTENSION = { npm: 'tgz', composer: 'zip' };

// parseTag는 tag에서 version과 Go module의 directory(root tag는 null)를 읽는다.
export function parseTag(tag) {
  const match = /^(?:(.+)\/)?v(\d+\.\d+\.\d+)$/.exec(tag ?? '');
  if (!match) throw new Error(`the tag ${JSON.stringify(tag ?? '')} is neither vX.Y.Z nor <dir>/vX.Y.Z; give the pushed tag as TAG, which release.yml sets from github.ref_name`);
  return { version: match[2], module: match[1] ?? null };
}

// assetName은 release asset의 이름이다.
export const assetName = (name, version, extension) => `${name.replace(/^@([^/]+)\//, '$1-').replaceAll('/', '-')}-${version}.${extension}`;

// manifest는 manifest text에서 이름과 version(없으면 undefined)을 읽는다.
export function manifest(kind, text) {
  if (kind === 'cargo') {
    const lines = text.split('\n');
    const start = lines.findIndex(line => line.trim() === '[package]');
    const end = lines.findIndex((line, index) => index > start && /^\[/.test(line));
    const section = start === -1 ? '' : lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
    return { name: /^name = "([^"]+)"$/m.exec(section)?.[1], version: /^version = "([^"]+)"$/m.exec(section)?.[1] };
  }
  if (kind === 'go') return { name: /^module\s+(\S+)/m.exec(text)?.[1], version: undefined };
  const { name, version } = JSON.parse(text);
  return { name, version };
}

// unlistedManifests는 추적된 manifest 가운데 RELEASED에도 NOT_RELEASED에도 없는 것과, 두 목록에 있지만 추적되지 않는 것마다
// 오류 하나를 돌려준다.
export function unlistedManifests(tracked) {
  const listed = new Set([...RELEASED.map(({ path }) => path), ...Object.keys(NOT_RELEASED)]);
  return [
    ...tracked.filter(path => MANIFESTS.test(path) && !listed.has(path)).map(path => `${path} is neither released nor listed as not released; add it to RELEASED or to NOT_RELEASED with the reason in scripts/release/release.mjs`),
    ...[...listed].filter(path => !tracked.includes(path)).map(path => `${path} is listed in scripts/release/release.mjs but not tracked; remove it from the list`),
  ];
}

// changelogSection은 변경 이력 text에서 `## <version>` section의 본문을 돌려준다. 없으면 null이다.
export function changelogSection(text, version) {
  const lines = text.split('\n');
  const start = lines.findIndex(line => line.trim() === `## ${version}`);
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();
}

// NOTES_LIMIT는 GitHub가 받는 release 본문의 최대 길이(문자 수)다. 더 긴 본문은 `body is too long`으로 거부된다.
export const NOTES_LIMIT = 125000;

// releaseNotes는 release의 notes다: section이 NOTES_LIMIT자 이하면 section 그대로이고, 넘으면 tag의 CHANGELOG.md에서
// heading `## X.Y.Z`의 anchor(version에서 점을 뺀 것)를 가리키는 한 줄이다. tag는 path segment마다 URL로 encode한다.
export function releaseNotes(section, tag) {
  const { version } = parseTag(tag);
  if ([...section].length <= NOTES_LIMIT) return section;
  const ref = tag.split('/').map(encodeURIComponent).join('/');
  return `The changes of ${version} are listed in [CHANGELOG.md](https://${GO_MODULE}/blob/${ref}/CHANGELOG.md#${version.replaceAll('.', '')}).`;
}

// checkErrors는 commit의 check run([{ name, status, conclusion, started_at }])에서 required check마다, run이 없거나 가장
// 최근 run이 success가 아니면 오류 하나를 돌려준다.
export function checkErrors(runs, sha, required = REQUIRED_CHECKS) {
  const errors = [];
  for (const name of required) {
    const latest = runs.filter(run => run.name === name).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
    if (!latest) errors.push(`the check ${name} has no run on commit ${sha}; the merge queue runs it on every commit that reaches main`);
    else if (latest.conclusion !== 'success') errors.push(`the check ${name} on commit ${sha} ended with ${latest.conclusion || latest.status || 'no conclusion'}; release a commit whose ${name} succeeded`);
  }
  return errors;
}

// versionErrors는 tag의 version이 tag가 담는 manifest와 다르거나 변경 이력에 그 section이 없는 곳마다 오류 하나를 돌려준다.
// read(path)는 저장소 file의 text이거나 없으면 null이다.
export function versionErrors({ version, module }, read) {
  const errors = [];
  const goModule = (path, want) => {
    const text = read(path);
    const declared = text === null ? undefined : manifest('go', text).name;
    if (text === null) errors.push(`${path} is missing; a tag <dir>/vX.Y.Z releases the Go module of <dir>`);
    else if (declared !== want) errors.push(`${path} declares the module ${declared}, not ${want}, so go get does not resolve the tag`);
  };
  if (module === null) {
    const declared = read('VERSION')?.trim();
    if (declared !== version) errors.push(`VERSION declares ${declared ?? '(missing)'}, the tag declares ${version}`);
    for (const { path, kind } of RELEASED) {
      if (kind === 'go') { goModule(path, GO_MODULE); continue; }
      const text = read(path);
      if (text === null) { errors.push(`${path} is missing; the tag releases it`); continue; }
      const found = manifest(kind, text).version;
      if (found !== undefined && found !== version) errors.push(`${path} declares ${found}, the tag declares ${version}`);
    }
  } else goModule(`${module}/go.mod`, `${GO_MODULE}/${module}`);
  for (const path of CHANGELOGS) {
    const text = read(path);
    if (text === null || changelogSection(text, version) === null) errors.push(`${path} has no section ## ${version}; the release PR renames ## Unreleased to ## ${version}`);
  }
  return errors;
}

// polyspec는 0.1까지 registry에 publish하지 않는다. 소비자는 필요한 release asset을 내려받아 함께 설치하고(npm은 그 tarball을
// `file:`로 나열하고, Composer는 zip을 담은 artifact repository를 쓴다), asset은 서로를 이름과 정확한 version으로 찾는다. 그래서
// packed manifest는 polyspec dependency를 정확한 version으로만 선언한다: URL, path, git source와 범위는 저장소 밖에서 풀리지 않거나
// 함께 설치한 asset과 맞지 않는다.
const NPM_SECTIONS = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const COMPOSER_SECTIONS = ['require', 'require-dev'];
const EXACT = /^\d+\.\d+\.\d+$/;
// RELEASE_TARBALL은 저장소의 package.json이 git 없이 설치하려고 polyspec npm package를 가리키는 GitHub Release tarball의 URL이다.
// packedPackage는 그것을 tag의 version으로 바꾼다.
export const RELEASE_TARBALL = /^https:\/\/github\.com\/polyspec\/[^/]+\/releases\/download\/v(\d+\.\d+\.\d+)\/[^/]+\.tgz$/;

// dependencyForm은 정확한 version이 아닌 dependency spec의 형식을 이름으로 돌려준다.
function dependencyForm(spec) {
  if (/^(?:file|link|workspace):/.test(spec)) return 'a path inside the repository';
  if (/^(?:git[+:]|github:|ssh:|git@)|\.git(?:#|$)/.test(spec)) return 'a git source';
  if (/^[a-z]+:\/\//.test(spec)) return 'a URL';
  if (/@dev\b|^dev-/.test(spec)) return 'a development version';
  return 'a version range';
}

// packedManifestErrors는 release asset의 packed manifest(npm의 package.json, Composer의 composer.json) text에서 규칙을 어긴
// 곳마다 오류 하나를 돌려준다: `@polyspec/*`와 `polyspec/*` dependency는 정확한 version이고, Composer manifest는
// `repositories`가 없으며(Composer는 root package의 것만 읽는다) `version`이 release의 version이다(artifact repository는 zip의
// version을 읽는다).
export function packedManifestErrors(asset, kind, text, version) {
  const json = JSON.parse(text);
  const errors = [];
  const [scope, sections] = kind === 'npm' ? ['@polyspec/', NPM_SECTIONS] : ['polyspec/', COMPOSER_SECTIONS];
  for (const section of sections)
    for (const [name, spec] of Object.entries(json[section] ?? {}))
      if (name.startsWith(scope) && !EXACT.test(spec))
        errors.push(`${asset} declares ${section} ${name} as ${JSON.stringify(spec)}, ${dependencyForm(spec)}; declare the exact version of its release`);
  if (kind === 'composer') {
    if ('repositories' in json) errors.push(`${asset} declares repositories, which Composer reads only from the root package; remove them from the packed composer.json`);
    if (json.version !== version) errors.push(`${asset} declares the version ${json.version ?? '(none)'}, the release is ${version}; an artifact repository reads the version from the zip`);
  }
  return errors;
}

// packedPackage는 npm tarball에 넣는 package.json이다: `@polyspec/*` dependency의 RELEASE_TARBALL URL을 그 tag의 version으로
// 바꾼다. 다른 형식은 그대로 두어 packedManifestErrors가 거부한다. 저장소의 package.json은 바꾸지 않는다.
export function packedPackage(text) {
  const json = JSON.parse(text);
  for (const section of NPM_SECTIONS)
    for (const [name, spec] of Object.entries(json[section] ?? {}))
      if (name.startsWith('@polyspec/')) json[section][name] = RELEASE_TARBALL.exec(spec)?.[1] ?? spec;
  return `${JSON.stringify(json, null, 2)}\n`;
}

// packedComposer는 Composer zip에 넣는 composer.json이다: 저장소의 composer.json에서 `repositories`를 빼고 `version`을 release의
// version으로 둔다(`type` 다음, 없으면 `name` 다음). 저장소의 composer.json은 바꾸지 않는다.
export function packedComposer(text, version) {
  const { repositories, version: declared, ...rest } = JSON.parse(text);
  const after = 'type' in rest ? 'type' : 'name';
  const packed = {};
  for (const [key, value] of Object.entries(rest)) {
    packed[key] = value;
    if (key === after) packed.version = version;
  }
  return `${JSON.stringify(packed, null, 4)}\n`;
}

// buildAssets는 commit sha의 npm과 Composer asset을 directory assets에 만들고, 각 asset의 packed manifest를 그 asset에서
// 다시 읽어 packedManifestErrors로 확인한 뒤 그 이름을 돌려준다. npm package는 package.json을 packedPackage로 바꿔 다시 pack한
// `npm pack`이고, Composer package는 그 directory의 `git archive` zip이며 그 composer.json은 packedComposer다.
// run(program, args, options)는 stdout을 돌려주고 실패하면 던진다.
export function buildAssets({ root, sha, version, assets, run, log = console.log }) {
  mkdirSync(assets, { recursive: true });
  const built = [];
  const errors = [];
  for (const { path, kind } of RELEASED.filter(({ kind }) => EXTENSION[kind])) {
    const dir = path.slice(0, path.lastIndexOf('/'));
    const text = run('git', ['show', `${sha}:${path}`]);
    const asset = assetName(manifest(kind, text).name, version, EXTENSION[kind]);
    const file = join(assets, asset);
    if (kind === 'npm') {
      run('make', ['--no-print-directory', 'typescript-build']);
      // npm pack이 만든 tarball을 풀어 package.json을 packedPackage로 바꾸고 그 directory를 다시 pack한다.
      const unpacked = mkdtempSync(join(tmpdir(), 'orm-release-npm-'));
      try {
        const packed = run('npm', ['pack', '--pack-destination', unpacked], { cwd: join(root, dir) }).trim().split('\n').at(-1).trim();
        run('tar', ['-xzf', join(unpacked, packed), '-C', unpacked]);
        const packageJson = join(unpacked, 'package', 'package.json');
        writeFileSync(packageJson, packedPackage(readFileSync(packageJson, 'utf8')));
        const repacked = run('npm', ['pack', '--pack-destination', assets], { cwd: join(unpacked, 'package') }).trim().split('\n').at(-1).trim();
        if (repacked !== asset) renameSync(join(assets, repacked), file);
      } finally {
        rmSync(unpacked, { recursive: true, force: true });
      }
    } else {
      const name = path.slice(dir.length + 1);
      run('git', ['archive', '--format=zip', '-o', file, `--add-virtual-file=${name}:${packedComposer(text, version)}`, `${sha}:${dir}`, `:(exclude)${name}`]);
    }
    const packedText = kind === 'npm' ? run('tar', ['-xzOf', file, 'package/package.json']) : run('unzip', ['-p', file, 'composer.json']);
    errors.push(...packedManifestErrors(asset, kind, packedText, version));
    built.push(asset);
    log(`release: built ${asset}`);
  }
  if (errors.length) throw new Error(`release ${version} assets refused:\n${errors.map(error => `  ${error}`).join('\n')}`);
  return built;
}

// step은 release의 단계 하나를 실행하고 그 단계가 만든 asset의 이름을 돌려준다. exec(program, args, { cwd })는 { status,
// stdout, stderr }를 돌려주고, log는 줄 하나를 적는다. 실패하면 이유를 모두 적은 오류를 던진다.
export function step({ action, tag, root, repository, exec, log = console.log }) {
  const run = (program, args, options = {}) => {
    const result = exec(program, args, { cwd: root, ...options });
    if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} exited with ${result.status}: ${(result.stderr || result.stdout || '').trim()}`);
    return result.stdout;
  };
  const read = path => existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null;
  const parsed = parseTag(tag);
  const directory = join(root, RELEASE_DIR);
  const assets = join(directory, 'assets');
  const refuse = errors => { if (errors.length) throw new Error(`release ${tag} ${action} refused:\n${errors.map(error => `  ${error}`).join('\n')}`); };
  if (action === 'verify') {
    if (!repository) throw new Error('GITHUB_REPOSITORY is unset; set it to <owner>/<repo>, which GitHub Actions sets');
    const sha = run('git', ['rev-parse', `${tag}^{commit}`]).trim();
    const errors = [];
    if (exec('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { cwd: root }).status !== 0)
      errors.push(`commit ${sha} of ${tag} is not on origin/main; tag a commit that the merge queue put on main`);
    const runs = run('gh', ['api', '--paginate', `repos/${repository}/commits/${sha}/check-runs`, '--jq', CHECK_RUNS]).split('\n').filter(Boolean).map(line => {
      const [name, status, conclusion, started] = line.split('\t');
      return { name, status, conclusion: conclusion || null, started_at: started };
    });
    errors.push(...checkErrors(runs, sha));
    refuse(errors);
    log(`release: commit ${sha} of ${tag} is on origin/main, and its checks ${REQUIRED_CHECKS.join(' and ')} succeeded`);
    return [];
  }
  if (action === 'versions') {
    refuse(versionErrors(parsed, read));
    log(`release: ${parsed.module === null ? `VERSION and ${RELEASED.length} manifests` : `${parsed.module}/go.mod`} and ${CHANGELOGS.join(' and ')} agree on ${parsed.version}`);
    return [];
  }
  if (action === 'assets') {
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(assets, { recursive: true });
    let built = [];
    if (parsed.module === null) built = buildAssets({ root, sha: run('git', ['rev-parse', `${tag}^{commit}`]).trim(), version: parsed.version, assets, run, log });
    else log(`release: the Go module tag ${tag} has no assets`);
    writeFileSync(join(directory, 'assets.txt'), built.map(asset => `${asset}\n`).join(''));
    return built;
  }
  if (action === 'publish') {
    const list = read(`${RELEASE_DIR}/assets.txt`);
    if (list === null) throw new Error(`${RELEASE_DIR}/assets.txt is missing; run make release-assets, which builds the assets of the tag first`);
    const built = list.split('\n').filter(Boolean);
    refuse(built.filter(asset => !existsSync(join(assets, asset))).map(asset => `${RELEASE_DIR}/assets/${asset} is missing; run make release-assets again`));
    const section = changelogSection(read('CHANGELOG.md') ?? '', parsed.version);
    refuse(section === null ? [`CHANGELOG.md has no section ## ${parsed.version}; run make release-versions, which names the missing section`] : []);
    const notes = join(directory, 'notes.md');
    writeFileSync(notes, `${releaseNotes(section, tag)}\n`);
    run('gh', ['release', 'create', tag, '--verify-tag', '--title', tag, '--notes-file', notes, ...built.map(asset => join(assets, asset))]);
    log(`release: created the GitHub release ${tag} with ${built.length} asset(s)${built.length ? `: ${built.join(' ')}` : ''}`);
    return built;
  }
  throw new Error(`unknown release action ${JSON.stringify(action)}; give verify, versions, assets or publish`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, tag] = process.argv.slice(2);
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const exec = (program, args, options) => {
    const result = spawnSync(program, args, { ...options, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (result.error) return { status: 1, stdout: '', stderr: result.error.message };
    // 단계의 출력은 job log에 남긴다: 실행한 명령과 그 stdout과 stderr다.
    console.log(`release: ${program} ${args.join(' ')} exited with ${result.status}`);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result;
  };
  try {
    step({ action, tag, root, repository: process.env.GITHUB_REPOSITORY, exec });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
