<?php
// pdo_mysql이 없는 PHP에서 PHP client가 load되고 SQLite에서 실행된다(N17). DSN의
// scheme이 PDO driver를 고르므로 composer.json은 driver 확장을 요구하지 않고
// pdo_mysql, pdo_pgsql, pdo_sqlite를 제안한다. schema/bench.dbs를 dbspec file reader로
// 읽어 설치하고, generated model로 row 하나를 만들고 읽는다.
// Usage: scripts/php-without-mysql.sh, which runs this file with php -n and only the
// extensions the client needs; a PHP that loads mysqlnd, pdo_mysql or mysqli fails the case.
declare(strict_types=1);

require __DIR__ . '/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

use Polyspec\Orm\Tests\Model\Service;
use Polyspec\Orm\Config;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Orm;

function fail(string $message): never
{
    throw new RuntimeException($message);
}

// case는 SQLite file 하나에 schema를 설치하고 row 하나를 쓰고 읽는다.
testcase_begin('sqlite_without_mysql', TESTCASE_DATABASE);
foreach (['mysqlnd', 'pdo_mysql', 'mysqli'] as $driver) {
    if (extension_loaded($driver)) {
        fail("this PHP loads $driver; run scripts/php-without-mysql.sh");
    }
}
$root = dirname(__DIR__, 3);
$manifest = json_decode((string) file_get_contents("$root/clients/php/composer.json"), true, 512, JSON_THROW_ON_ERROR);
$drivers = ['ext-pdo_mysql', 'ext-pdo_pgsql', 'ext-pdo_sqlite'];
$required = array_values(array_intersect($drivers, array_keys($manifest['require'] ?? [])));
$suggested = array_values(array_intersect($drivers, array_keys($manifest['suggest'] ?? [])));
if ($required !== [] || $suggested !== $drivers) {
    fail('composer.json requires ' . json_encode($required) . ' and suggests ' . json_encode($suggested) . ' of the PDO drivers; it must require none and suggest all three');
}
$document = Dbspec::readFile("$root/schema/bench.dbs");
if ($document->text === null) {
    fail('schema/bench.dbs: ' . $document->diagnostics[0]->message);
}
$work = sys_get_temp_dir() . '/orm-php-without-mysql-' . getmypid();
if (!mkdir($work, 0o700, true)) {
    fail("cannot create $work");
}
$db = Orm::connect("sqlite://$work/case.sqlite", new Config(aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key'));
$db->utils()->schema()->install(\Polyspec\Orm\Tests\Model\schema());
$created = (new Service)($db)->setName('without-mysql')->create();
$read = (new Service)($db)->getBySeq($created->getSeq());
$db->close();
unlink("$work/case.sqlite");
rmdir($work);
if ($read->getName() !== 'without-mysql') {
    fail("read the name {$read->getName()}");
}
testcase_step('the client runs on SQLite without pdo_mysql');
testcase_end();
