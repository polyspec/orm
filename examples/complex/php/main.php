<?php
// A complex statement in every client language, one JSON document. Run:
//
//   php examples/complex/php/main.php /abs/schema/schema.json
declare(strict_types=1);

require dirname(__DIR__, 3) . '/clients/php/tests/autoload.php';

use App\Orm\Battle;
use App\Orm\Service;
use App\Orm\ServiceMember;
use App\Orm\User;
use Orm\Config;
use Orm\Orm;

$db = Orm::connect(
    getenv('ORM_BENCH_MYSQL_DSN') ?: 'mysql://root@localhost/orm_bench?socket=/tmp/mysql.sock',
    new Config(schemaPath: $argv[1], aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index'),
);

// A join child with its own ON conditions whose WHERE conditions are placed
// in a group, and two levels of relations with options.
$service = (new Service)
    ->on(fn(Service $s) => $s->gtSeq(0))
    ->name('service-7');
$rows = (new Battle)($db)
    ->removeAllColumns()->addColumnName()
    ->joinServiceSeqWithSeq($service)
    ->isClose(false)
    ->and(fn(Battle $q) => $q->isDisplay(true)->or($service))
    ->relation((new User)->matchUserSeqWithSeq()
        ->relations((new Battle)->matchSeqWithUserSeq()->removeAllColumns()->orderBySeqDesc()->groupLimit(2)))
    ->relation((new Service)->matchServiceSeqWithSeq()->aliasOwnerService()
        ->relations((new ServiceMember)->matchSeqWithServiceSeq()->removeAllColumns()->orderBySeqAsc()->groupLimit(2)->keyNameUserSeq()))
    ->orderBySeqAsc()
    ->limit(0, 2)
    ->gets();

// Aggregates over the same data: grouped counts, a sum, an average, and a page.
$groups = (new Battle)($db)->serviceSeq(7)->groupByUserSeq()->getsCount();
$sum = (new Battle)($db)->serviceSeq(7)->sumReadCount()->getSum();
$avg = (new Battle)($db)->serviceSeq(7)->avgLikeCount()->getAvg();
$page = (new Battle)($db)->serviceSeq(7)->removeAllColumns()->orderBySeqAsc()->getsPage(2, 10);

echo json_encode([
    'rows' => $rows,
    'groups' => count($groups),
    'read_sum' => $sum,
    'like_avg' => $avg,
    'page_total' => $page->totalCount,
    'page_pages' => $page->totalPages,
    'page_length' => count($page->items),
], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), "\n";
