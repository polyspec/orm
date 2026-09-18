<?php
// Row keys that match relation children to parents and key collections.
// Usage: php clients/php/tests/relation_keys.php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use App\Orm\Battle;
use Orm\Db;

function expect(bool $ok, string $message): void
{
    if (!$ok) {
        throw new RuntimeException($message);
    }
}

$refs = [['column' => 'tenant_id', 'index' => 0], ['column' => 'account_id', 'index' => 1]];
$first = Db::rowKey(['1', '23'], $refs);
$second = Db::rowKey(['12', '3'], $refs);
expect(is_string($first) && is_string($second) && $first !== $second, 'composite row keys collide');
expect(Db::rowKey([1, null], $refs) === null, 'null composite row key was accepted');
expect(Db::rowKey([7], [['column' => 'id', 'index' => 0]]) === 7, 'single integer key type changed');
foreach (['get', 'gets', 'getCount', 'getsPage', 'create', 'update', 'delete'] as $method) {
    expect(method_exists(Battle::class, $method), "terminal $method is missing");
}
foreach (['one', 'all', 'count', 'using', 'begin', 'commit', 'rollback', 'savepoint', 'exec', 'offsetGet'] as $method) {
    expect(!method_exists(Battle::class, $method), "removed method $method remains public");
}

echo "php relation keys: composite keys, null handling, and terminals passed\n";
