<?php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use App\Orm\Battle;
use Orm\Code;
use Orm\Config;
use Orm\Orm;
use Orm\OrmException;

$driver = getenv('ORM_UNSELECTED_DATABASE');
$dsn = getenv('ORM_UNSELECTED_DSN');
if (!in_array($driver, ['mysql', 'postgres', 'sqlite'], true) || !is_string($dsn) || $dsn === '') {
    throw new RuntimeException('ORM_UNSELECTED_DATABASE and ORM_UNSELECTED_DSN are required');
}

function requireUnselected(callable $read, string $column): void
{
    try {
        $read();
    } catch (OrmException $error) {
        if ($error->code_ === Code::COLUMN_UNSELECTED) return;
        throw $error;
    }
    throw new RuntimeException("unselected $column returned a value");
}

$schema = dirname(__DIR__, 3) . '/schema/schema.json';
$db = Orm::connect($dsn, new Config(schemaPath: $schema, aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index'));
try {
    if ($db->driver() !== $driver) throw new RuntimeException('DSN selected the wrong database');
    $row = (new Battle)($db)->removeAllColumns()->addColumnSeq()->getBySeq(1);
    $seq = $row->getSeq();
    if ($seq < 1) throw new RuntimeException('selected seq is invalid');
    requireUnselected(static fn() => $row->getName(), 'text');
    requireUnselected(static fn() => $row->getIsClose(), 'boolean');
    requireUnselected(static fn() => $row->getDescription(), 'nullable text');
    requireUnselected(static fn() => $row->getCreatedTs(), 'date');
    requireUnselected(static fn() => $row->getPrice(), 'nullable decimal');
    $selected = (new Battle)($db)->removeAllColumns()->addColumnSeq()->addColumnPrice()->getBySeq($seq);
    if ($selected->getSeq() !== $seq || $selected->getPrice() !== null) {
        throw new RuntimeException('selected SQL NULL changed');
    }
} finally {
    $db->close();
}
echo "CASE unselected_column_$driver PASS\n";
