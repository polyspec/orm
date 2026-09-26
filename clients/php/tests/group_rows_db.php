<?php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Polyspec\Orm\Tests\Model\Author;
use Orm\Code;
use Orm\Config;
use Orm\GroupRow;
use Orm\GroupRows;
use Orm\Orm;
use Orm\OrmException;

$driver = getenv('ORM_GROUP_DATABASE');
$dsn = getenv('ORM_GROUP_DSN');
if (!in_array($driver, ['mysql', 'postgres', 'sqlite'], true) || !is_string($dsn) || $dsn === '') {
    throw new RuntimeException('ORM_GROUP_DATABASE and ORM_GROUP_DSN are required');
}
$schema = dirname(__DIR__, 3) . '/schema/schema.json';
$db = Orm::connect($dsn, new Config(schemaPath: $schema, aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index'));
try {
    if ($db->driver() !== $driver) throw new RuntimeException('DSN selected the wrong database');
    $query = static fn(): Author => (new Author)($db);
    $groups = $query()->groupByIsClose()->orderByIsCloseAsc()->getsCount();
    if (!$groups instanceof GroupRows || count($groups) !== 2) throw new RuntimeException('getsCount returned partial models');
    $total = 0;
    foreach ($groups as $row) {
        if (!$row instanceof GroupRow || !is_bool($row->value('is_close')) || $row->count() < 1) {
            throw new RuntimeException('grouped boolean or count has the wrong type');
        }
        if (array_keys($row->toArray()) !== ['is_close', 'row_count']) {
            throw new RuntimeException('group row includes an unselected field');
        }
        try {
            $row->value('name');
            throw new RuntimeException('unselected model column was available');
        } catch (OrmException $error) {
            if ($error->code_ !== Code::COLUMN_UNSELECTED) throw $error;
        }
        $total += $row->count();
    }
    if ($total !== $query()->getCount()) throw new RuntimeException('group counts do not sum to the row count');
    $services = $query()->groupByServiceSeq()->getsCount();
    $serviceTotal = 0;
    foreach ($services as $row) {
        if (!is_int($row->value('service_seq'))) throw new RuntimeException('grouped integer changed type');
        $serviceTotal += $row->count();
    }
    if ($serviceTotal !== $total) throw new RuntimeException('service group counts differ');
    $nullable = $query()->groupByPrice()->getsCount();
    $nullableTotal = 0;
    $sawNull = false;
    foreach ($nullable as $row) {
        if ($row->value('price') === null) $sawNull = true;
        $nullableTotal += $row->count();
    }
    if (!$sawNull || $nullableTotal !== $total) throw new RuntimeException('SQL NULL group value was lost');
} finally {
    $db->close();
}
echo "CASE group_rows_$driver PASS\n";
