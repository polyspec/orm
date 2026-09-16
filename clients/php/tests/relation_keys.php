<?php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Orm\Db;
use Orm\Q;
use Orm\Req;

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
expect(method_exists(\App\Orm\Battle::class, 'get') && method_exists(\App\Orm\Battle::class, 'gets') && method_exists(\App\Orm\Battle::class, 'getCount'), 'canonical terminals are missing');
expect(!method_exists(\App\Orm\Battle::class, 'one') && !method_exists(\App\Orm\Battle::class, 'all') && !method_exists(\App\Orm\Battle::class, 'count'), 'removed terminal aliases remain public');

$completeInsert = (new ReflectionClass(Q::class))->newInstanceWithoutConstructor();
$request = (new ReflectionClass(Req::class))->newInstanceWithoutConstructor();
$request->ir = ['ir_version' => 1, 'schema_hash' => 'test', 'kind' => '', 'entity' => 'membership', 'set' => [
    ['column' => 'tenant_id', 'p' => 0],
    ['column' => 'account_id', 'p' => 1],
    ['column' => 'name', 'p' => 2],
]];
$request->params = [7, 11, 'created'];
$request->sig = 'membership';
$completeInsert->req = clone $request;
expect($completeInsert->assignedKeyValues(['tenant_id', 'account_id']) === [7, 11], 'composite insert key order differs');
expect(count($completeInsert->req->ir['set']) === 3 && !isset($completeInsert->req->ir['where']), 'composite insert key inspection changed the request');
$partial = clone $completeInsert;
$partial->req = clone $request;
$partial->req->ir['set'] = [
    ['column' => 'tenant_id', 'p' => 0],
    ['column' => 'name', 'p' => 1],
];
$partial->req->params = [7, 'created'];
try {
    $partial->assignedKeyValues(['tenant_id', 'account_id']);
    throw new RuntimeException('partial composite insert was accepted');
} catch (\Orm\OrmException $error) {
    expect($error->code_ === \Orm\Code::IR_INVALID, 'partial composite insert returned the wrong error');
}
expect(count($partial->req->ir['set']) === 2 && !isset($partial->req->ir['where']), 'partial composite insert changed the request');

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

echo "php relation keys: ordered tuples, null handling, and canonical terminals passed\n";
