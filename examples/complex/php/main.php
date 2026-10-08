<?php
// A complex statement in every client language, one JSON document. Run:
//
//   php examples/complex/php/main.php
declare(strict_types=1);

require dirname(__DIR__, 3) . '/packages/orm-php/tests/autoload.php';

use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\Service;
use Polyspec\Orm\Tests\Model\ServiceMember;
use Polyspec\Orm\Tests\Model\User;
use Polyspec\Orm\Config;

$db = \Polyspec\Orm\Tests\Model\connect(
    dsn(),
    new Config(aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index'),
);

// A join child with its own ON conditions whose WHERE conditions are placed
// in a group, and two levels of relations with options.
$service = (new Service)
    ->on(fn(Service $s) => $s->gtSeq(0))
    ->name('service-7');
$rows = (new Author)($db)
    ->removeAllColumns()->addColumnName()
    ->joinServiceSeqWithSeq($service)
    ->isClose(false)
    ->and(fn(Author $q) => $q->isDisplay(true)->or($service))
    ->relation((new User)->matchUserSeqWithSeq()
        ->relations((new Author)->matchSeqWithUserSeq()->removeAllColumns()->orderBySeqDesc()->groupLimit(2)))
    ->relation((new Service)->matchServiceSeqWithSeq()->aliasOwnerService()
        ->relations((new ServiceMember)->matchSeqWithServiceSeq()->removeAllColumns()->orderBySeqAsc()->groupLimit(2)->keyNameUserSeq()))
    ->orderBySeqAsc()
    ->limit(0, 2)
    ->gets();

// Aggregates over the same data: grouped counts, a sum, an average, and a page.
$groups = (new Author)($db)->serviceSeq(7)->groupByUserSeq()->getsCount();
$sum = (new Author)($db)->serviceSeq(7)->sumReadCount()->getSum();
$avg = (new Author)($db)->serviceSeq(7)->avgLikeCount()->getAvg();
$page = (new Author)($db)->serviceSeq(7)->removeAllColumns()->orderBySeqAsc()->getsPage(2, 10);

// 세 언어가 같은 byte를 내도록 member 순서는 이 array가 고정하고 compact JSON으로 쓴다.
echo json_encode([
    'rows' => $rows,
    'groups' => count($groups),
    'read_sum' => $sum,
    'like_avg' => $avg,
    'page_total' => $page->totalCount,
    'page_pages' => $page->totalPages,
    'page_length' => count($page->items),
], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), "\n";

/** 시드된 bench database 를 가리키는 ORM_BENCH_MYSQL_DSN 이다. 없거나 비어 있으면 연결하지 않고 끝난다. */
function dsn(): string
{
    $dsn = getenv('ORM_BENCH_MYSQL_DSN');
    if ($dsn === false || $dsn === '') {
        fwrite(STDERR, "ORM_BENCH_MYSQL_DSN is required; it names the seeded bench database; run it through make check or make run-databases TARGETS=<target>, which create the bench database of the run\n");
        exit(1);
    }
    return $dsn;
}
