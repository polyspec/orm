<?php
// The PHP client loads and runs on SQLite in a PHP without pdo_mysql (N17):
// the scheme of a DSN selects its PDO driver, so composer.json requires no
// driver extension and suggests pdo_mysql, pdo_pgsql and pdo_sqlite.
// Usage: scripts/php-without-mysql.sh, which runs this file in the official PHP
// image; a PHP that loads pdo_mysql fails the case.
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Polyspec\Orm\Tests\Model\Service;
use Orm\Config;
use Orm\Orm;

function fail(string $message): never
{
    fwrite(STDERR, "FAIL sqlite_without_mysql: $message\n");
    exit(1);
}

$started = hrtime(true);
if (extension_loaded('pdo_mysql')) {
    fail('this PHP loads pdo_mysql; run scripts/php-without-mysql.sh');
}
$root = dirname(__DIR__, 3);
$manifest = json_decode((string) file_get_contents("$root/clients/php/composer.json"), true, 512, JSON_THROW_ON_ERROR);
$drivers = ['ext-pdo_mysql', 'ext-pdo_pgsql', 'ext-pdo_sqlite'];
$required = array_values(array_intersect($drivers, array_keys($manifest['require'] ?? [])));
$suggested = array_values(array_intersect($drivers, array_keys($manifest['suggest'] ?? [])));
if ($required !== [] || $suggested !== $drivers) {
    fail('composer.json requires ' . json_encode($required) . ' and suggests ' . json_encode($suggested) . ' of the PDO drivers; it must require none and suggest all three');
}
$work = sys_get_temp_dir() . '/orm-php-without-mysql-' . getmypid();
if (!mkdir($work, 0o700, true)) {
    fail("cannot create $work");
}
$schema = "$root/schema/schema.json";
$db = Orm::connect("sqlite://$work/case.sqlite", new Config(schemaPath: $schema, aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key'));
$db->utils()->schema()->install((string) file_get_contents($schema));
$created = (new Service)($db)->setName('without-mysql')->create();
$read = (new Service)($db)->getBySeq($created->getSeq());
$db->close();
unlink("$work/case.sqlite");
rmdir($work);
if ($read->getName() !== 'without-mysql') {
    fail("read the name {$read->getName()}");
}
printf("PASS sqlite_without_mysql: the client runs on SQLite without pdo_mysql %.1fms\n", (hrtime(true) - $started) / 1e6);
