// Runs packages/php/tests/SqliteWithoutMysqlTest.php on PHPUnit with a PHP that loads no MySQL driver (mysqlnd, pdo_mysql,
// mysqli; N17). `php -n` leaves out every shared module that an ini loads, and this script loads with `-d extension=` only
// the extensions that the client uses on SQLite and that PHPUnit requires (dom, libxml, xml, xmlwriter, tokenizer;
// EXTENSIONS) which are not compiled in. A MySQL driver compiled into PHP cannot be left out with `-n`, so the script
// prints why and fails: CI runs this check on the declared Linux runner (.github/runner), whose drivers are shared modules.
// make php-without-mysql-check runs this script as a long operation through tests/run-long.mts with no deadline, which
// reports its start, output, exit code, result and elapsed time; the PHP cases inside report their own lines and deadlines.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = realpathSync(resolve(import.meta.dirname, '..'));
const EXTENSIONS = ['pdo', 'pdo_sqlite', 'openssl', 'zlib', 'ctype', 'mbstring', 'libxml', 'dom', 'xml', 'xmlwriter', 'tokenizer'];
const DRIVERS = ['mysqlnd', 'pdo_mysql', 'mysqli'];

const modules = spawnSync('php', ['-n', '-m'], { encoding: 'utf8' });
if (modules.status !== 0) {
  console.error(`php-without-mysql: php -n -m exited with ${modules.status ?? modules.signal ?? 'no status'}`);
  process.exit(1);
}
const compiled = new Set(modules.stdout.split('\n').map(line => line.trim().toLowerCase()));
const driver = DRIVERS.find(name => compiled.has(name));
if (driver !== undefined) {
  const php = spawnSync('sh', ['-c', 'command -v php'], { encoding: 'utf8' }).stdout.trim();
  console.error(`php-without-mysql: ${php} compiles ${driver} in, so php -n cannot leave it out; this check runs on the Linux runner ${readFileSync(join(root, '.github/runner'), 'utf8').trim()}, whose MySQL drivers are shared modules`);
  process.exit(1);
}
const loads = EXTENSIONS.filter(name => !compiled.has(name)).flatMap(name => ['-d', `extension=${name}`]);
const version = spawnSync('php', ['-n', '-r', 'echo PHP_VERSION;'], { encoding: 'utf8' }).stdout;
console.log(`php ${version} -n ${loads.join(' ')}`);
const result = spawnSync('php', ['-n', ...loads, join(root, 'vendor-php/bin/phpunit'), '--configuration', join(root, 'packages/php/phpunit.xml.dist'),
  join(root, 'packages/php/tests/SqliteWithoutMysqlTest.php')], { stdio: 'inherit' });
process.exit(result.status ?? 1);
