// install-check는 release asset이 저장소 없이 소비자처럼 설치되는지 확인한다(make package-check). HEAD의 npm과 Composer asset을
// release-assets와 같은 buildAssets로 만들고(packed manifest의 확인 포함), tests/release-install의 소비자 fixture를 저장소 밖의
// 임시 directory에 복사해 그 lock대로 설치한 뒤 load한다. npm cache, COMPOSER_HOME, Composer cache는 비어 있는 임시
// directory다:
//   npm       fixture의 package.json은 polyspec package를 release tarball 이름의 `file:` dependency로 나열하고, 그
//             package-lock.json은 다른 package를 정확한 version과 integrity로 고정한다. 이 저장소가 만드는 tarball
//             옆에 다른 polyspec 저장소의 tarball을 그 GitHub Release에서 받아 두고(integrity는 lock이 확인한다), `npm ci`를
//             `@polyspec` registry가 닿지 않는 주소인 채로 실행하므로 polyspec package는 tarball로만 풀린다.
//   Composer  fixture의 composer.json은 asset zip의 artifact repository `assets`와 ordered-json 0.0.2 zip(`version`이 없어
//             artifact repository가 읽지 못한다)의 shasum을 가진 `package` repository를 두고, composer.lock은 다른 package를
//             dist reference로 고정한다. `composer install`이 lock대로 설치한다. polyspec/orm-dbspec는 type `php-ext`이므로
//             Composer가 아니라 PIE가 설치한다.
// lock이 고정한 package의 download는 설치이므로 허용한다(AGENTS.md): 이 script는 make가 export한 npm_config_offline과
// COMPOSER_DISABLE_NETWORK를 npm ci와 composer install에서 지운다. 시간에 따라 결과가 달라지는 registry 조회(version 범위의
// 해석, 최신 version 조회)는 `lock` action만 하고, 그것은 make install-release-fixtures가 실행한다.
//
// Usage: node scripts/release/install-check.mjs [check|lock]
//   check  fixture의 lock대로 설치한다.
//   lock   fixture의 lock을 다시 만든다. 이 저장소가 만드는 package는 commit마다 내용이 바뀌므로 그 integrity와 shasum은 lock에
//          두지 않는다.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAssets } from './release.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FIXTURE = join(root, 'tests', 'release-install');
const { npm_config_offline: _npmOffline, COMPOSER_DISABLE_NETWORK: _composerOffline, ...online } = process.env;
const run = (program, args, options = {}) => {
  const result = spawnSync(program, args, { cwd: root, ...options, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error || result.status !== 0)
    throw new Error(`${program} ${args.join(' ')} exited with ${result.status}: ${(result.error?.message || result.stderr || result.stdout || '').trim()}`);
  return result.stdout;
};
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, data, indent) => writeFileSync(path, `${JSON.stringify(data, null, indent)}\n`);

// download는 다른 polyspec 저장소의 release asset을 받는다: `@polyspec/<repo>`의 tarball은 그 저장소의 tag `v<version>`에 있다.
async function download(name, version, file, directory) {
  const url = `https://github.com/polyspec/${name.replace(/^@polyspec\//, '')}/releases/download/v${version}/${file}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  writeFileSync(join(directory, file), Buffer.from(await response.arrayBuffer()));
}

const action = process.argv[2] ?? 'check';
if (!['check', 'lock'].includes(action)) throw new Error(`unknown action ${JSON.stringify(action)}; give check or lock`);
const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
const sha = run('git', ['rev-parse', 'HEAD^{commit}']).trim();
const work = mkdtempSync(join(tmpdir(), 'orm-release-install-'));
try {
  const assets = join(work, 'assets');
  const built = buildAssets({ root, sha, version, assets, run, log: line => console.log(line.replace('release: ', 'install-check: ')) });
  const env = { ...online, COMPOSER_HOME: join(work, 'composer-home'), COMPOSER_CACHE_DIR: join(work, 'composer-cache') };

  // npm: fixture와 tarball을 한 directory에 둔다.
  const npm = join(work, 'npm');
  mkdirSync(npm);
  const manifest = json(join(FIXTURE, 'npm', 'package.json'));
  copyFileSync(join(FIXTURE, 'npm', 'package.json'), join(npm, 'package.json'));
  if (action === 'check') copyFileSync(join(FIXTURE, 'npm', 'package-lock.json'), join(npm, 'package-lock.json'));
  for (const [name, spec] of Object.entries(manifest.dependencies)) {
    const file = spec.replace(/^file:/, '');
    if (built.includes(file)) copyFileSync(join(assets, file), join(npm, file));
    else await download(name, /-(\d+\.\d+\.\d+)\.tgz$/.exec(file)[1], file, npm);
  }
  const npmArgs = ['--cache', join(work, 'npm-cache'), '--ignore-scripts', '--no-audit', '--no-fund', '--@polyspec:registry=http://127.0.0.1:9/'];
  if (action === 'lock') {
    run('npm', ['install', '--package-lock-only', ...npmArgs], { cwd: npm, env });
    const lock = json(join(npm, 'package-lock.json'));
    for (const entry of Object.values(lock.packages))
      if (built.includes(String(entry.resolved).replace(/^file:/, ''))) delete entry.integrity;
    write(join(FIXTURE, 'npm', 'package-lock.json'), lock, 2);
    console.log('install-check: wrote tests/release-install/npm/package-lock.json');
  } else {
    run('npm', ['ci', ...npmArgs], { cwd: npm, env });
    run('node', ['--input-type=module', '-e', "const orm = await import('@polyspec/orm'); if (typeof orm.StyledValue !== 'function') throw new Error('@polyspec/orm exports no StyledValue');"], { cwd: npm });
    console.log(`install-check: npm ci installed @polyspec/orm ${version} from tests/release-install/npm with an empty cache`);
  }

  // Composer: fixture 옆의 directory assets가 artifact repository다.
  const composer = join(work, 'composer');
  mkdirSync(join(composer, 'assets'), { recursive: true });
  copyFileSync(join(FIXTURE, 'composer', 'composer.json'), join(composer, 'composer.json'));
  for (const asset of built.filter(asset => asset.endsWith('.zip'))) copyFileSync(join(assets, asset), join(composer, 'assets', asset));
  if (action === 'lock') {
    run('composer', ['update', '--no-install', '--no-interaction', '--no-progress'], { cwd: composer, env });
    const lock = json(join(composer, 'composer.lock'));
    for (const entry of [...lock.packages, ...(lock['packages-dev'] ?? [])])
      if (entry.dist?.url?.startsWith('assets/')) entry.dist.shasum = '';
    write(join(FIXTURE, 'composer', 'composer.lock'), lock, 4);
    console.log('install-check: wrote tests/release-install/composer/composer.lock');
  } else {
    copyFileSync(join(FIXTURE, 'composer', 'composer.lock'), join(composer, 'composer.lock'));
    run('composer', ['install', '--no-interaction', '--no-progress'], { cwd: composer, env });
    run('php', ['-r', "require 'vendor/autoload.php'; if (!class_exists(Polyspec\\Orm\\Db::class) || !class_exists(Polyspec\\OrderedJson\\ParseError::class)) { fwrite(STDERR, 'the installed packages do not load'); exit(1); }"], { cwd: composer });
    console.log(`install-check: composer install installed polyspec/orm ${version} from tests/release-install/composer with empty caches`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
