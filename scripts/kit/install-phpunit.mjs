// Installs the PHPUnit release that config/toolchain.json phpunit declares into var/tools/phpunit, with the wrapper phpunit
// in var/tools/bin. The Composer project of config/phpunit (composer.json and composer.lock) is copied into the temporary
// directory of the install, and `composer install` with the composer.phar of var/tools/composer, the Composer that
// install-composer.mjs installs with its sha256, resolves the locked packages; Composer checks the digest of each archive
// against the lock. Composer keeps its home and cache in var/tools/composer and writes no link, so the install of var/tools
// holds no symbolic link. An installed release is kept, and the Composer of the machine is never used.
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { installOnce } from './install-tool.mjs';
import { bootstrapEnvironment, printedRelease, quote, run, toolsPath, wrapperText, writeWrapper } from './tool-wrappers.mjs';

/** Installs the declared PHPUnit `{ version, manifest }` into var/tools/phpunit of `root` and writes the wrapper. */
export function installPhpunit({ root, declared, print = () => {} }) {
  const composer = toolsPath(root, 'composer', 'composer.phar');
  if (!existsSync(composer)) throw new Error(`phpunit needs ${path.relative(root, composer)}, the Composer that config/toolchain.json composer declares; declare composer and run make install-tools TOOLS=composer`);
  const prefix = toolsPath(root, 'phpunit');
  const environment = bootstrapEnvironment(root, { COMPOSER_HOME: toolsPath(root, 'composer', 'home'), COMPOSER_CACHE_DIR: toolsPath(root, 'composer', 'cache') });
  const result = installOnce({
    root, label: 'PHPUnit', prefix, recorded: declared.version, installedRelease: directory => printedRelease(path.join(directory, 'vendor/bin/phpunit'), 'phpunit'), print,
    install: (next) => {
      const manifest = path.dirname(declared.manifest);
      for (const file of ['composer.json', 'composer.lock']) copyFileSync(path.join(root, manifest, file), path.join(next, file));
      run('php', [composer, 'install', '--no-interaction', '--no-progress', '--no-scripts', '--no-plugins', '--prefer-dist'], { cwd: next, env: environment }, print);
    },
  });
  writeWrapper(root, 'phpunit', wrapperText(`PHPUnit ${declared.version} of this checkout`, `exec ${quote(path.join(prefix, 'vendor/bin/phpunit'))} "$@"`), print);
  return result;
}
