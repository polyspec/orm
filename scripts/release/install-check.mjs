// install-check는 release asset이 저장소 없이 설치되는지 확인한다(make package-check). HEAD의 npm과 Composer asset을
// release-assets와 같은 buildAssets로 만들고(packed manifest의 확인 포함), 저장소 밖의 임시 directory에서 그 asset으로 root
// package를 설치한 뒤 load한다. check는 network를 읽지 않으므로(make의 npm_config_offline, COMPOSER_DISABLE_NETWORK) 다른
// package는 make install이 이 checkout에 설치한 것에서 온다. npm cache, COMPOSER_HOME, Composer cache는 비어 있는 임시
// directory다:
//   npm       project의 package.json이 orm tarball과, 그것이 의존하는 package마다 저장소 root의 package-lock.json이
//             설치한 directory를 `npm pack`한 tarball을 모두 `file:`로 나열하고, `npm install
//             --offline`으로 설치한다. `@polyspec` scope의 registry는 닿지 않는 주소다. orm tarball이 선언한 정확한 version을
//             함께 설치한 tarball이 채운다.
//   Composer  artifact repository가 asset zip을 담고, 다른 package는 저장소 root의 composer.lock이 vendor-php에 설치한
//             directory를 그 lock의 version으로 주는 `path` repository다. Packagist는 끈다. polyspec/orm-dbspec는 type
//             `php-ext`이므로 Composer가 아니라 PIE가 설치하고, project는 polyspec/orm을 요구한다.
//
// Usage: node scripts/release/install-check.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetName, buildAssets } from './release.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const run = (program, args, options = {}) => {
  const result = spawnSync(program, args, { cwd: root, ...options, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error || result.status !== 0)
    throw new Error(`${program} ${args.join(' ')} exited with ${result.status}: ${(result.error?.message || result.stderr || result.stdout || '').trim()}`);
  return result.stdout;
};
const json = path => JSON.parse(readFileSync(path, 'utf8'));

const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
const sha = run('git', ['rev-parse', 'HEAD^{commit}']).trim();
const work = mkdtempSync(join(tmpdir(), 'orm-release-install-'));
try {
  const assets = join(work, 'assets');
  const built = buildAssets({ root, sha, version, assets, run, log: line => console.log(line.replace('release: ', 'install-check: ')) });

  // npm: orm tarball과, clients/typescript의 dependencies에서 package-lock.json의 dependency, optional과 peer dependency를 따라
  // 닿는 package마다 그 설치된 directory의
  // tarball이다. node처럼 가까운 node_modules부터 위로 찾는다. 같은 이름은 version 하나다.
  const npm = join(work, 'npm');
  const tarballs = join(work, 'tarballs');
  mkdirSync(npm);
  mkdirSync(tarballs);
  const dependencies = { '@polyspec/orm': `file:${join(assets, assetName('@polyspec/orm', version, 'tgz'))}` };
  const lock = json(join(root, 'package-lock.json')).packages;
  const locate = (from, name) => {
    for (let at = from; ; at = at.includes('/node_modules/') ? at.slice(0, at.lastIndexOf('/node_modules/')) : '') {
      const path = `${at ? `${at}/` : ''}node_modules/${name}`;
      if (lock[path]) return path;
      if (!at) return null;
    }
  };
  const versions = new Map();
  const visit = (from, entry) => {
    const peerOptional = name => entry.peerDependenciesMeta?.[name]?.optional === true;
    const edges = [
      ...Object.keys(entry.dependencies ?? {}).map(name => [name, false]),
      ...Object.keys(entry.optionalDependencies ?? {}).map(name => [name, true]),
      ...Object.keys(entry.peerDependencies ?? {}).map(name => [name, peerOptional(name)]),
    ];
    for (const [name, optional] of edges) {
      const path = locate(from, name);
      if (path === null) { if (optional) continue; throw new Error(`package-lock.json installs no ${name} for ${from}`); }
      const { version: at } = lock[path];
      if (versions.has(name)) {
        if (versions.get(name) !== at) throw new Error(`package-lock.json installs ${name} at ${versions.get(name)} and ${at}; the project lists one tarball per package`);
        continue;
      }
      versions.set(name, at);
      const packed = run('npm', ['pack', '--ignore-scripts', '--pack-destination', tarballs, join(root, path)], { cwd: work }).trim().split('\n').at(-1).trim();
      dependencies[name] = `file:${join(tarballs, packed)}`;
      visit(path, lock[path]);
    }
  };
  visit('clients/typescript', lock['clients/typescript']);
  writeFileSync(join(npm, 'package.json'), `${JSON.stringify({ name: 'orm-release-install', private: true, type: 'module', dependencies }, null, 2)}\n`);
  run('npm', ['install', '--offline', '--cache', join(work, 'npm-cache'), '--ignore-scripts', '--no-audit', '--no-fund', '--@polyspec:registry=http://127.0.0.1:9/'], { cwd: npm });
  run('node', ['--input-type=module', '-e', "const orm = await import('@polyspec/orm'); if (typeof orm.StyledValue !== 'function') throw new Error('@polyspec/orm exports no StyledValue');"], { cwd: npm });
  console.log(`install-check: npm installed @polyspec/orm ${version} offline from its tarball and ${versions.size} dependency tarballs`);

  // Composer: asset zip의 artifact repository와, root composer.lock의 다른 package마다 vendor-php directory의 path repository다.
  const composer = join(work, 'composer');
  mkdirSync(composer);
  const locked = json(join(root, 'composer.lock')).packages.filter(({ name }) => name !== 'polyspec/orm');
  writeFileSync(join(composer, 'composer.json'), `${JSON.stringify({
    require: { 'polyspec/orm': version },
    repositories: [
      { type: 'artifact', url: assets },
      ...locked.map(({ name, version: at }) => ({ type: 'path', url: join(root, 'vendor-php', name), options: { symlink: false, versions: { [name]: at.replace(/^v/, '') } } })),
      { 'packagist.org': false },
    ],
  }, null, 4)}\n`);
  const env = { ...process.env, COMPOSER_HOME: join(work, 'composer-home'), COMPOSER_CACHE_DIR: join(work, 'composer-cache'), COMPOSER_DISABLE_NETWORK: '1' };
  run('composer', ['install', '--no-interaction', '--no-progress'], { cwd: composer, env });
  run('php', ['-r', "require 'vendor/autoload.php'; if (!class_exists(Polyspec\\Orm\\Db::class) || !class_exists(Polyspec\\OrderedJson\\ParseError::class)) { fwrite(STDERR, 'the installed packages do not load'); exit(1); }"], { cwd: composer });
  console.log(`install-check: Composer installed polyspec/orm ${version} offline from an artifact repository of ${built.filter(asset => asset.endsWith('.zip')).join(' and ')}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
