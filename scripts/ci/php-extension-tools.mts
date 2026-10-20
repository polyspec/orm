// make orm-install-php-extension-tools checks what the build of the PHP extension polyspec_orm (packages/php-ext, C built
// with phpize) needs besides the PHP of .php-version: phpize and php-config on PATH, of the PHP on PATH. The check of the
// arginfo header (make lint-php-ext) reads only the stub hash, and make php-ext-arginfo runs the gen_stub.php of phpize.
import { spawnSync } from 'node:child_process';

const fail = (message: string): never => {
  console.error(`php-extension-tools: ${message}`);
  process.exit(1);
};
const output = (program: string, args: string[]): string | undefined => {
  const result = spawnSync(program, args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
};
const configured = output('php-config', ['--version']) ?? fail('php-config is not on PATH; install the PHP development files of .php-version (the setup-php step gives them in CI)');
if (output('sh', ['-c', 'command -v phpize']) === undefined) fail('phpize is not on PATH; install the PHP development files of .php-version (the setup-php step gives them in CI)');
const running = output('php', ['-r', 'echo PHP_VERSION;']) ?? fail('php does not run');
if (configured !== running) fail(`php-config reports PHP ${configured}, but php is PHP ${running}; put the development files of the same PHP on PATH`);
console.log(`php-extension-tools: php-config ${configured}`);
