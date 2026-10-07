// orm의 모든 version 선언이 VERSION 파일과 같은지 확인한다. 다른 선언과 사라진 선언을
// 파일 이름과 함께 하나씩 보고한다.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { COMPUTE, sections } from '../../tests/testcase.mjs';

// orm이 내는 Rust package. Cargo.lock에서 이 package의 version만 orm version이다.
const RUST_PACKAGES = ['polyspec-orm', 'polyspec-orm-schema', 'polyspec-orm-build', 'polyspec-orm-case-clock', 'polyspec-orm-case-database', 'polyspec-orm-testcase', 'polyspec-orm-tests', 'polyspec-orm-bench',
  'polyspec-orm-interface-symbols'];

const first = re => text => [...text.matchAll(re)].slice(0, 1).map(m => m[1]);
const all = re => text => [...text.matchAll(re)].map(m => m[1]);
const cargoToml = text => [
  ...first(/^version = "([^"]+)"$/gm)(text),
  ...all(/^(?:polyspec-orm|polyspec-orm-schema) = \{ version = "=([^"]+)"/gm)(text),
];
const cargoLock = text => [...text.matchAll(/^name = "([^"]+)"\nversion = "([^"]+)"$/gm)]
  .filter(m => RUST_PACKAGES.includes(m[1])).map(m => m[2]);
// 저장소 root의 package-lock.json에서 orm version은 workspace clients/typescript의 항목이다(root는 version이 없는 private
// workspace다).
const packageLock = text => [JSON.parse(text).packages?.['clients/typescript']?.version].filter(Boolean);

// 각 선언의 파일과 그 파일에서 orm version을 읽는 방법.
export const DECLARATIONS = [
  ...['clients/rust/orm', 'clients/rust/orm-schema', 'clients/rust/orm-build', 'clients/rust/case-clock', 'clients/rust/case-database',
    'clients/rust/testcase', 'clients/rust/tests', 'bench/rust', 'tests/interfaces/rust'].map(dir => ({ file: `${dir}/Cargo.toml`, read: cargoToml })),
  ...['clients/rust', 'bench/rust', 'tests/interfaces/rust'].map(dir => ({ file: `${dir}/Cargo.lock`, read: cargoLock })),
  { file: 'clients/php/composer.json', read: text => [JSON.parse(text).version].filter(Boolean) },
  { file: 'clients/php-extension/composer.json', read: text => [JSON.parse(text).version].filter(Boolean) },
  { file: 'clients/typescript/package.json', read: text => [JSON.parse(text).version].filter(Boolean) },
  { file: 'package-lock.json', read: packageLock },
  // release asset 설치 검사의 소비자 fixture는 release의 asset 이름과 version을 적는다(make install-release-fixtures가 lock을 만든다).
  { file: 'tests/release-install/npm/package.json', read: text => [/^file:polyspec-orm-(.+)\.tgz$/.exec(JSON.parse(text).dependencies['@polyspec/orm'])?.[1]].filter(Boolean) },
  { file: 'tests/release-install/npm/package-lock.json', read: text => [JSON.parse(text).packages?.['node_modules/@polyspec/orm']?.version].filter(Boolean) },
  { file: 'tests/release-install/composer/composer.json', read: text => [JSON.parse(text).require?.['polyspec/orm']].filter(Boolean) },
  { file: 'tests/release-install/composer/composer.lock', read: text => JSON.parse(text).packages.filter(({ name }) => name === 'polyspec/orm').map(({ version }) => version) },
  { file: 'contracts/features.json', read: text => [JSON.parse(text).contract_version].filter(Boolean) },
  { file: 'README.md', read: first(/^# orm (\S+)$/gm) },
  { file: 'README.ko.md', read: first(/^# orm (\S+)$/gm) },
  { file: 'clients/php/README.md', read: first(/Version (\d+\.\d+\.\d+)\./g) },
  { file: 'SECURITY.md', read: first(/development version is `([^`]+)`/g) },
  { file: 'SECURITY.ko.md', read: first(/개발 version은 `([^`]+)`/g) },
  { file: 'AGENTS.md', read: first(/Develop one `([^`]+)` version/g) },
  { file: 'AGENTS.ko.md', read: first(/하나의 `([^`]+)` 버전/g) },
  { file: 'docs/plan.md', read: first(/product version is `([^`]+)`/g) },
  { file: 'docs/plan.ko.md', read: first(/제품 버전은 `([^`]+)`이다/g) },
];

export async function versionErrors(root) {
  const version = (await readFile(join(root, 'VERSION'), 'utf8')).trim();
  const errors = [];
  for (const { file, read } of DECLARATIONS) {
    let found;
    try { found = read(await readFile(join(root, file), 'utf8')); }
    catch (error) { errors.push(`${file}: ${error.message}`); continue; }
    if (found.length === 0) errors.push(`${file}: no version declaration found (VERSION is ${version})`);
    for (const value of found) if (value !== version) errors.push(`${file}: version ${value} differs from VERSION ${version}`);
  }
  return errors;
}

// CHANGELOGS는 변경 이력 file이다. 각 file은 맨 위에 `## Unreleased`(아직 tag하지 않은 변경)를 두고, 그 아래 section은
// release한 version `## X.Y.Z`이며 새 version이 위에 온다. release PR은 VERSION과 모든 package file을 X.Y.Z로 바꾸고
// `## Unreleased`를 `## X.Y.Z`로 바꾼 뒤 그 위에 빈 `## Unreleased`를 둔다(AGENTS.md), 그래서 어느 section도 VERSION보다 크지
// 않다. 두 언어의 file은 같은 section을 가진다.
export const CHANGELOGS = ['CHANGELOG.md', 'CHANGELOG.ko.md'];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const compare = (a, b) => {
  const [x, y] = [SEMVER.exec(a).slice(1).map(Number), SEMVER.exec(b).slice(1).map(Number)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

// changelogErrors는 version의 변경 이력 file({path: text})이 그 규칙을 어기는 곳마다 오류 하나를 돌려준다.
export function changelogErrors(version, files) {
  const errors = [];
  const sections = {};
  for (const [path, text] of Object.entries(files)) {
    const headings = [...text.matchAll(/^## (.*)$/gm)].map(match => match[1].trim());
    sections[path] = headings;
    if (headings[0] !== 'Unreleased') errors.push(`${path}: the first section is ${headings[0] === undefined ? 'missing' : `## ${headings[0]}`}; write the entries of the changes that no tag released under ## Unreleased at the top`);
    if (headings.filter(heading => heading === 'Unreleased').length > 1) errors.push(`${path}: ## Unreleased appears ${headings.filter(heading => heading === 'Unreleased').length} times; keep one at the top`);
    const versions = headings.filter(heading => heading !== 'Unreleased');
    for (const heading of versions) {
      if (!SEMVER.test(heading)) errors.push(`${path}: the section ## ${heading} is neither ## Unreleased nor a released version X.Y.Z`);
      else if (compare(heading, version) > 0) errors.push(`${path}: the section ## ${heading} is above VERSION ${version}; the release PR sets VERSION to the version it releases`);
    }
    const released = versions.filter(heading => SEMVER.test(heading));
    for (const [index, heading] of released.slice(1).entries())
      if (compare(released[index], heading) <= 0) errors.push(`${path}: the section ## ${heading} follows ## ${released[index]}; a newer version comes first and appears once`);
  }
  const [first, ...others] = Object.keys(sections);
  for (const path of others)
    if (sections[path].join('\n') !== sections[first].join('\n')) errors.push(`${path}: the sections ${sections[path].map(heading => `## ${heading}`).join(', ')} differ from the sections ${sections[first].map(heading => `## ${heading}`).join(', ')} of ${first}`);
  return errors;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  // version check는 선언 file을 읽고 비교하는 case 하나다.
  const log = sections();
  log.begin('version', COMPUTE);
  const root = resolve(import.meta.dirname, '..', '..');
  const version = (await readFile(join(root, 'VERSION'), 'utf8')).trim();
  const errors = [...await versionErrors(root),
    ...changelogErrors(version, Object.fromEntries(await Promise.all(CHANGELOGS.map(async path => [path, await readFile(join(root, path), 'utf8')]))))];
  for (const error of errors) console.error(`version: ${error}`);
  if (errors.length === 0) console.log(`version: ${DECLARATIONS.length} declarations agree on ${version}; ${CHANGELOGS.join(' and ')} start with ## Unreleased`);
  log.end(errors.length ? `${errors.length} declaration(s) differ; each is listed above` : undefined);
  if (errors.length > 0) process.exitCode = 1;
}
