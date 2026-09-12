<?php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Orm\Db;

function expect(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

$refs = [['column' => 'tenant_id', 'index' => 0], ['column' => 'account_id', 'index' => 1]];
$first = Db::rowKey(['1', '23'], $refs);
$second = Db::rowKey(['12', '3'], $refs);
expect(is_string($first) && is_string($second) && $first !== $second, 'composite row keys collide');
expect(Db::rowKey([1, null], $refs) === null, 'null composite row key was accepted');
expect(Db::rowKey([7], [['column' => 'id', 'index' => 0]]) === 7, 'single integer key type changed');

$expand = (new ReflectionClass(Db::class))->getMethod('expandIn');
$base = [
    'parent' => ['keys' => $refs],
    'bind_slots' => [['from' => 'parent'], ['from' => 'param']],
];
[$sql, $values] = $expand->invoke(null, $base + ['sql' => 'SELECT 1 WHERE (a,b) IN ((?)) AND c = ?'], [1, 2, 1, 3, 2, 4]);
expect($sql === 'SELECT 1 WHERE (a,b) IN ((?, ?), (?, ?), (?, ?), (?, ?)) AND c = ?', 'question-mark tuple expansion differs');
expect($values === [1, 2, 1, 3, 2, 4, 2, 4], 'tuple padding differs');
[$sql] = $expand->invoke(null, $base + ['sql' => 'SELECT 1 WHERE (a,b) IN (($1)) AND c = $2'], [1, 2, 1, 3, 2, 4]);
expect($sql === 'SELECT 1 WHERE (a,b) IN (($1, $2), ($3, $4), ($5, $6), ($7, $8)) AND c = $9', 'numbered tuple expansion differs');

echo "php relation keys: ordered tuples, null handling, and scalar compatibility passed\n";
