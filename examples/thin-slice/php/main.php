<?php
// S1 demo (PHP): one statement, three languages, one JSON.
// stdout: the result as JSON — byte-identical to the Go and Rust demos.
// stderr: p50 of the generated client vs the same SQL through PDO directly.
//
//   php examples/thin-slice/php/main.php /abs/ormd.sock /abs/schema.json
declare(strict_types=1);

require dirname(__DIR__, 3) . '/clients/php/tests/autoload.php';

use App\Orm\Battle;
use App\Orm\BattleWhere;
use Orm\Config;
use Orm\Db;
use Orm\Orm;

const ITERATIONS = 500;

$lastSql = '';
$lastArgs = [];
Orm::init(new Config(socket: $argv[1], schemaPath: $argv[2], aesKey: 'bench-salt',
    onQuery: function (string $sql, array $binds, float $sec, string $planId, ?\Throwable $e) use (&$lastSql, &$lastArgs) { $lastSql = $sql; $lastArgs = array_map(fn($v) => $v === '$SECRET' ? 'bench-salt' : $v, $binds); }));
$db = Db::mysql(orm_test_dsn(), 'root', '');
$now = '2026-09-11 00:00:00';

$query = fn() => (new Battle)
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

$out = [];
foreach ($query() as $r) {
    $out[] = ['is_display' => $r->getIsDisplay(), 'like_count' => $r->getLikeCount(), 'name' => $r->getName(), 'seq' => $r->getSeq()];
}
echo json_encode($out, JSON_THROW_ON_ERROR), "\n";

function p50(\Closure $f): int
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

$client = p50($query);
$stmt = $db->pdo->prepare($lastSql);
$native = p50(function () use ($stmt, $lastArgs) {
    $stmt->execute($lastArgs);
    $stmt->fetchAll(\PDO::FETCH_NUM);
});
fwrite(STDERR, sprintf("php: client p50 %dµs, native p50 %dµs (%d iterations)\n", $client, $native, ITERATIONS));
