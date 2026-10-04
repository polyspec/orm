<?php
// Thin-slice demo (PHP): one statement in every client language, one JSON.
// stdout: the result as JSON. stderr: p50 of the generated client and of the
// same SQL through PDO directly.
//
//   php examples/thin-slice/php/main.php
declare(strict_types=1);

require dirname(__DIR__, 3) . '/clients/php/tests/autoload.php';

use Polyspec\Orm\Tests\Model\Author;
use Orm\Config;
use Orm\Db;
use Orm\Orm;
use Orm\StatementEvent;

const ITERATIONS = 500;
const AES_KEY = 'bench-salt';

$lastSql = '';
$lastArgs = [];
$db = \Polyspec\Orm\Tests\Model\connect(dsn(), new Config(
    aesKey: AES_KEY,
    blindIndexKey: 'bench-blind-index',
));
$db->subscribe(static function (StatementEvent $e) use (&$lastSql, &$lastArgs): void {
    $lastSql = $e->sql;
    $lastArgs = array_map(static fn(mixed $v): mixed => $v === Db::SECRET ? AES_KEY : $v, $e->binds);
});
$now = new DateTimeImmutable('2026-09-11 00:00:00', new DateTimeZone('UTC'));

$query = static fn() => (new Author)->connect($db)
    ->serviceSeq(7)
    ->andIsClose(false)
    ->and(fn(Author $q) => $q->isDisplay(true)->or(fn(Author $q) => $q->isDisplay(false)->andLtDisplayStartDt($now)))
    ->andSeq([6, 106, 206, 306, 406])
    ->orderBySeqDesc()
    ->limit(0, 3)
    ->gets();

$out = [];
foreach ($query() as $r) {
    $out[] = ['is_display' => $r->getIsDisplay(), 'like_count' => $r->getLikeCount(), 'name' => $r->getName(), 'seq' => $r->getSeq()];
}
echo json_encode($out, JSON_THROW_ON_ERROR), "\n";

$client = p50($query);
[, $pdoDsn, $user, $password] = Orm::parseDsn(dsn());
$raw = new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$stmt = $raw->prepare($lastSql);
$native = p50(static function () use ($stmt, $lastArgs): void {
    $stmt->execute($lastArgs);
    $stmt->fetchAll(PDO::FETCH_NUM);
});
fwrite(STDERR, sprintf("php: client p50 %dµs, native p50 %dµs (%d iterations)\n", $client, $native, ITERATIONS));

/** 시드된 bench database 를 가리키는 ORM_BENCH_MYSQL_DSN 이다. 없거나 비어 있으면 연결하지 않고 끝난다. */
function dsn(): string
{
    $dsn = getenv('ORM_BENCH_MYSQL_DSN');
    if ($dsn === false || $dsn === '') {
        fwrite(STDERR, "ORM_BENCH_MYSQL_DSN is required; it names the seeded bench database\n");
        exit(1);
    }
    return $dsn;
}

function p50(Closure $f): int
{
    $s = [];
    for ($i = 0; $i < ITERATIONS; $i++) {
        $t = hrtime(true);
        $f();
        $s[] = intdiv(hrtime(true) - $t, 1000);
    }
    sort($s);
    return $s[intdiv(count($s), 2)];
}
