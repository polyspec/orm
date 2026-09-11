<?php
// PHP half of the S1 demo: same statements as clients/go/gen/gen_integration_test.go.
// Usage: php clients/php/tests/integration.php /abs/ormd.sock /abs/schema.json
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use App\Orm\Battle;
use App\Orm\BattleWhere;
use App\Orm\Service;
use App\Orm\ServiceWhere;
use App\Orm\User;
use App\Orm\UserWhere;
use Orm\Config;
use Orm\Db;
use Orm\Orm;
use Orm\OrmException;
use Orm\Tx;

$sock = $argv[1] ?? die("usage: integration.php /abs/ormd.sock /abs/schema.json\n");
$schema = $argv[2] ?? die("schema.json required\n");
$log = [];
Orm::init(new Config(socket: $sock, schemaPath: $schema, aesKey: 'bench-salt',
    onQuery: function (string $sql, array $args, float $sec, ?\Throwable $e) use (&$log) { $log[] = $sql; }));
$db = Db::mysql('mysql:unix_socket=/tmp/mysql.sock;dbname=orm_bench;charset=utf8mb4', 'root', '');

$fail = 0;
function check(bool $ok, string $what): void { global $fail; if (!$ok) { $fail++; fwrite(STDERR, "FAIL: $what\n"); } }

// ---- reads ----
$b = (new Battle)->oneBySeq($db, 42);
check($b !== null && $b->getSeq() === 42 && $b->getName() === 'battle-42' && $b->getAesHexEmail() === 'user42@example.com', 'one by pk + aes decode');
check($b->getDescription() === null && $b['name'] === 'battle-42', 'lazy column null by default; ArrayAccess');
check($b->getIsClose() === true && $b->getIsDisplay() === false, 'bool coercion (42: closed, not displayed)');
check($b->getMemo('dflt') === 'dflt', 'getX(default) for unknown column');

$b2 = (new Battle)->selectDescription()->seqEq(42)->one($db);
check(str_starts_with((string) $b2->getDescription(), 'desc-42'), 'select lazy column');

$now = '2026-09-11 00:00:00';
$rows = (new Battle)
    ->serviceSeqEq(7)
    ->isCloseEq(false)
    ->and(fn(BattleWhere $w) => $w
        ->isDisplayEq(true)
        ->or()
        ->and(fn(BattleWhere $w) => $w->isDisplayEq(false)->displayStartDtLt($now)))
    ->seqIn([6, 106, 206, 306, 406])
    ->orderBySeqDesc()
    ->limit(0, 3)
    ->all($db);
check(count($rows) === 3 && $rows->first()->getSeq() === 306, 'all + group + or + in + order + limit');
foreach ($rows as $seq => $r) { check($seq === $r->getSeq(), 'collection keyed by pk'); }

check((new Battle)->serviceSeqEq(7)->count($db) === 1000, 'count');
check((new Battle)->serviceSeqEq(7)->sumLikeCount($db) > 0, 'sum');

$cnt = (new Battle)
    ->joinService((new Service)->where(fn(ServiceWhere $w) => $w->nameEq('service-7')))
    ->leftJoinUser((new User)->on(fn(UserWhere $w) => $w->nameContains('user')))
    ->isCloseEq(false)
    ->and(fn(BattleWhere $w) => $w->isDisplayEq(true)->or()->service(fn(ServiceWhere $s) => $s->seqGt(1000)))
    ->count($db);
check($cnt > 0, 'join + on/where + nav');

$page = (new Battle)->serviceSeqEq(7)->orderBySeqAsc()->paginate($db, 2, 10);
check($page->total === 1000 && $page->pages === 100 && count($page->items) === 10 && $page->items->first()->getSeq() === 1006, 'paginate');
check((new Battle)->nameContains('%')->count($db) === 0, 'contains escapes %');

// join result access
$j = (new Battle)->joinService((new Service)->where(fn(ServiceWhere $w) => $w->seqEq(7)))->seqEq(6)->one($db);
check($j !== null && $j->getService() !== null && $j->getService()->getName() === 'service-7' && $j['service']['name'] === 'service-7', 'joined row access');

// ---- writes ----
$created = $db->transaction(function (Tx $tx) {
    return (new Battle)
        ->setName('php-write')
        ->setUserSeq(1)->setServiceSeq(999)->setServiceModuleSeq(1)->setServiceMemberSeq(1)
        ->setStartDt('2026-06-01 00:00:00')->setEndDt('2026-12-31 00:00:00')
        ->setAesHexEmail('w@example.com')
        ->insert($tx);
});
check($created !== null && $created->getSeq() > 0 && $created->getAesHexEmail() === 'w@example.com', 'insert in tx + aes');

$created->setName('php-write-2')->setLikeCount(5)->updateOptimistic($db);
$again = (new Battle)->oneBySeq($db, $created->getSeq());
check($again->getName() === 'php-write-2' && $again->getLikeCount() === 5, 'dirty update');
try {
    $created->setName('stale')->updateOptimistic($db);
    check(false, 'optimistic lock should fail');
} catch (OrmException $e) {
    check($e->code_ === 'OPTIMISTIC_LOCK', 'optimistic lock code');
}
$again->delete($db);
check((new Battle)->seqEq($created->getSeq())->count($db) === 0, 'delete');

// ---- error surface ----
try {
    (new Battle)->seqIn([])->count($db);
    check(false, 'EMPTY_IN should throw');
} catch (OrmException $e) {
    check($e->code_ === 'EMPTY_IN', 'EMPTY_IN code');
}

if ($fail === 0) {
    echo "ok — " . count($log) . " statements\n";
    exit(0);
}
foreach ($log as $s) { fwrite(STDERR, "  $s\n"); }
exit(1);
