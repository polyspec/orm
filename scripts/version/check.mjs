// orm의 모든 version 선언이 VERSION 파일과 같은지 확인한다. 다른 선언과 사라진 선언을
// 파일 이름과 함께 하나씩 보고한다.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// orm이 내는 Rust package. Cargo.lock에서 이 package의 version만 orm version이다.
const RUST_PACKAGES = ['orm', 'orm-schema', 'orm-build', 'orm-case-clock', 'orm-case-database', 'orm-testcase', 'orm-tests', 'orm-bench', 'orm-interface-symbols'];

const first = re => text => [...text.matchAll(re)].slice(0, 1).map(m => m[1]);
const all = re => text => [...text.matchAll(re)].map(m => m[1]);
const cargoToml = text => [
  ...first(/^version = "([^"]+)"$/gm)(text),
  ...all(/^(?:orm|orm-schema) = \{ version = "=([^"]+)"/gm)(text),
];
const cargoLock = text => [...text.matchAll(/^name = "([^"]+)"\nversion = "([^"]+)"$/gm)]
  .filter(m => RUST_PACKAGES.includes(m[1])).map(m => m[2]);
const packageLock = text => {
  const lock = JSON.parse(text);
  return [lock.version, lock.packages?.['']?.version].filter(Boolean);
};

// 각 선언의 파일과 그 파일에서 orm version을 읽는 방법.
export const DECLARATIONS = [
  ...['clients/rust/orm', 'clients/rust/orm-schema', 'clients/rust/orm-build', 'clients/rust/case-clock', 'clients/rust/case-database',
    'clients/rust/testcase', 'clients/rust/tests', 'bench/rust', 'tests/interfaces/rust'].map(dir => ({ file: `${dir}/Cargo.toml`, read: cargoToml })),
  ...['clients/rust', 'bench/rust', 'tests/interfaces/rust'].map(dir => ({ file: `${dir}/Cargo.lock`, read: cargoLock })),
  { file: 'clients/php/composer.json', read: text => [JSON.parse(text).version].filter(Boolean) },
  { file: 'clients/typescript/package.json', read: text => [JSON.parse(text).version].filter(Boolean) },
  { file: 'clients/typescript/package-lock.json', read: packageLock },
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(import.meta.dirname, '..', '..');
  const errors = await versionErrors(root);
  for (const error of errors) console.error(`version: ${error}`);
  if (errors.length > 0) process.exit(1);
  console.log(`version: ${DECLARATIONS.length} declarations agree on ${(await readFile(join(root, 'VERSION'), 'utf8')).trim()}`);
}
