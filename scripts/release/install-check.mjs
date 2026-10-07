// install-check는 release asset이 저장소 없이 설치되는지 확인한다(make package-check). HEAD의 npm과 Composer asset을
// release-assets와 같은 buildAssets로 만들고(packed manifest의 확인 포함), 저장소 밖의 임시 directory에서 그 asset과 그것이
// 의존하는 polyspec release asset만으로 root package를 설치한 뒤 load한다:
//   npm       project의 package.json이 tarball을 모두 `file:`로 나열한다. `@polyspec` scope의 registry는 닿지 않는 주소이므로
//             polyspec package는 함께 설치한 tarball로만 풀린다. 다른 package는 public registry에서 온다.
//   Composer  artifact repository가 asset zip을 담는다. polyspec/orm-dbspec는 type `php-ext`이므로 Composer가 아니라 PIE가
//             설치하고, project는 polyspec/orm을 요구한다. `version`이 없는 zip(ordered-json 0.0.2)은 그 composer.json에
//             version과 zip의 경로를 더한 `package` repository로 준다. 다른 package는 Packagist에서 온다.
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
// download는 다른 polyspec 저장소의 release asset을 directory에 받는다.
async function download(repository, version, asset, directory) {
  const url = `https://github.com/polyspec/${repository}/releases/download/v${version}/${asset}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  const file = join(directory, asset);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
const sha = run('git', ['rev-parse', 'HEAD^{commit}']).trim();
const work = mkdtempSync(join(tmpdir(), 'orm-release-install-'));
try {
  const assets = join(work, 'assets');
  const built = buildAssets({ root, sha, version, assets, run, log: line => console.log(line.replace('release: ', 'install-check: ')) });
  const tarball = join(assets, assetName('@polyspec/orm', version, 'tgz'));
  const packed = JSON.parse(run('tar', ['-xzOf', tarball, 'package/package.json']));
  const composerPacked = JSON.parse(run('unzip', ['-p', join(assets, assetName('polyspec/orm', version, 'zip')), 'composer.json']));
  const orderedJson = { npm: packed.dependencies['@polyspec/ordered-json'], composer: composerPacked.require['polyspec/ordered-json'] };

  const npm = join(work, 'npm');
  mkdirSync(npm);
  const orderedJsonTarball = await download('ordered-json', orderedJson.npm, assetName('@polyspec/ordered-json', orderedJson.npm, 'tgz'), npm);
  writeFileSync(join(npm, 'package.json'), `${JSON.stringify({ name: 'orm-release-install', private: true, type: 'module', dependencies: {
    '@polyspec/orm': `file:${tarball}`, '@polyspec/ordered-json': `file:${orderedJsonTarball}`,
  } }, null, 2)}\n`);
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--@polyspec:registry=http://127.0.0.1:9/'], { cwd: npm });
  run('node', ['--input-type=module', '-e', "const orm = await import('@polyspec/orm'); if (typeof orm.StyledValue !== 'function') throw new Error('@polyspec/orm exports no StyledValue');"], { cwd: npm });
  console.log(`install-check: npm installed @polyspec/orm ${version} with @polyspec/ordered-json ${orderedJson.npm} from their tarballs alone`);

  const composer = join(work, 'composer');
  mkdirSync(composer);
  const orderedJsonZip = await download('ordered-json', orderedJson.composer, assetName('polyspec/ordered-json', orderedJson.composer, 'zip'), work);
  const orderedJsonManifest = JSON.parse(run('unzip', ['-p', orderedJsonZip, 'composer.json']));
  const orderedJsonRepository = 'version' in orderedJsonManifest
    ? { type: 'artifact', url: work }
    : { type: 'package', package: { ...orderedJsonManifest, version: orderedJson.composer, dist: { type: 'zip', url: orderedJsonZip } } };
  writeFileSync(join(composer, 'composer.json'), `${JSON.stringify({
    require: { 'polyspec/orm': version },
    repositories: [{ type: 'artifact', url: assets }, orderedJsonRepository],
  }, null, 4)}\n`);
  run('composer', ['install', '--no-interaction', '--no-progress'], { cwd: composer });
  run('php', ['-r', "require 'vendor/autoload.php'; if (!class_exists(Polyspec\\Orm\\Db::class) || !class_exists(Polyspec\\OrderedJson\\ParseError::class)) { fwrite(STDERR, 'the installed packages do not load'); exit(1); }"], { cwd: composer });
  console.log(`install-check: Composer installed polyspec/orm ${version} with polyspec/ordered-json ${orderedJson.composer} from an artifact repository of ${built.filter(asset => asset.endsWith('.zip')).join(' and ')}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
