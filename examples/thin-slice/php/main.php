<?php
// Thin-slice demo (PHP): one statement in every client language, one JSON.
// stdout: the result as JSON. stderr: p50 of the generated client and of the
// same SQL through PDO directly.
//
//   php examples/thin-slice/php/main.php /abs/schema/schema.json
declare(strict_types=1);

require dirname(__DIR__, 3) . '/clients/php/tests/autoload.php';

use App\Orm\Battle;
use Orm\Config;
use Orm\Db;
use Orm\Orm;

const ITERATIONS = 500;
const AES_KEY = 'bench-salt';

$lastSql = '';
$lastArgs = [];
$db = Orm::connect(dsn(), new Config(
    schemaPath: $argv[1],
    aesKey: AES_KEY,
    blindIndexKey: 'bench-blind-index',
    onQuery: static function (string $sql, array $binds) use (&$lastSql, &$lastArgs): void {
        $lastSql = $sql;
        $lastArgs = array_map(static fn(mixed $v): mixed => $v === Db::SECRET ? AES_KEY : $v, $binds);
    },
));
$now = new DateTimeImmutable('2026-09-11 00:00:00', new DateTimeZone('UTC'));

$query = static fn() => (new Battle)->connect($db)
    ->serviceSeq(7)
    ->andIsClose(false)
    ->and(fn(Battle $q) => $q->isDisplay(true)->or(fn(Battle $q) => $q->isDisplay(false)->andLtDisplayStartDt($now)))
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

function dsn(): string
{
    return getenv('ORM_BENCH_MYSQL_DSN') ?: 'mysql://root@localhost/orm_bench?socket=/tmp/mysql.sock';
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
