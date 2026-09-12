<?php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use App\Orm\Battle;
use Orm\Codec;
use Orm\Collection;
use Orm\Config;
use Orm\Db;
use Orm\Orm;
use Orm\Rows;

if ($argc < 3) {
    fwrite(STDERR, "usage: perf_gate.php /abs/ormd.sock /abs/schema.json\n");
    exit(2);
}

$lastSql = '';
$lastArgs = [];
Orm::init(new Config(
    socket: $argv[1],
    schemaPath: $argv[2],
    aesKey: 'bench-salt',
    onQuery: static function (string $sql, array $binds) use (&$lastSql, &$lastArgs): void {
        $lastSql = $sql;
        $lastArgs = array_map(static fn(mixed $value): mixed => $value === '$SECRET' ? 'bench-salt' : $value, $binds);
    },
));
$db = Db::mysql(orm_test_dsn(), 'root', '');

/** @return array{0: int, 1: int} */
function pairedP50(Closure $client, Closure $native, int $iterations = 300): array
{
    for ($i = 0; $i < 50; $i++) { $client(); $native(); }
    $clientTimes = [];
    $nativeTimes = [];
    for ($i = 0; $i < $iterations; $i++) {
        $order = ($i & 1) === 0 ? [[$client, &$clientTimes], [$native, &$nativeTimes]] : [[$native, &$nativeTimes], [$client, &$clientTimes]];
        foreach ($order as [$run, &$times]) {
            $start = hrtime(true);
            $run();
            $times[] = hrtime(true) - $start;
        }
        unset($times);
    }
    sort($clientTimes);
    sort($nativeTimes);
    return [$clientTimes[intdiv($iterations, 2)], $nativeTimes[intdiv($iterations, 2)]];
}

/** @return array{0: array, 1: list<mixed>, 2: PDOStatement} */
function nativeSetup(Db $db, object $query, string $kind, string &$lastSql, array &$lastArgs): array
{
    $terminal = $kind === 'one' ? 'one' : 'all';
    $query->using($db)->{$terminal}();
    $plan = $db->planFor($query->req, $kind);
    return [$plan, $lastArgs, $db->pdo->prepare($lastSql)];
}

$pkQuery = Battle::query()->seq(42);
[$pkPlan, $pkArgs, $pkStatement] = nativeSetup($db, $pkQuery, 'one', $lastSql, $lastArgs);
$pkClient = static function () use ($db): void {
    if (Battle::query()->seq(42)->using($db)->get() === null) { throw new RuntimeException('missing PK row'); }
};
$pkNative = static function () use ($db, $pkPlan, $pkArgs, $pkStatement): void {
    $pkStatement->execute($pkArgs);
    $data = $pkStatement->fetchAll(PDO::FETCH_NUM);
    foreach ($data as &$values) { Codec::decodeRow($values, $pkPlan['steps'][0]['assemble']); }
    unset($values);
    $rows = new Rows($pkPlan, $pkPlan['steps'][0]['assemble'], $data, $pkArgs);
    $rows->db = $db;
    if ($data !== []) { \App\Orm\BattleRow::fromRow($data[0], $rows->asm, $rows); }
};

$listQuery = Battle::query()->serviceSeq(7)->isClose(false)->orderBySeqDesc()->limit(0, 100);
[$listPlan, $listArgs, $listStatement] = nativeSetup($db, $listQuery, 'all', $lastSql, $lastArgs);
$listClient = static function () use ($db): void {
    Battle::query()->serviceSeq(7)->isClose(false)->orderBySeqDesc()->limit(0, 100)->using($db)->gets();
};
$listNative = static function () use ($db, $listPlan, $listArgs, $listStatement): void {
    $listStatement->execute($listArgs);
    $data = $listStatement->fetchAll(PDO::FETCH_NUM);
    foreach ($data as &$values) { Codec::decodeRow($values, $listPlan['steps'][0]['assemble']); }
    unset($values);
    $rows = new Rows($listPlan, $listPlan['steps'][0]['assemble'], $data, $listArgs);
    $rows->db = $db;
    Collection::fromRows($rows, \App\Orm\BattleRow::class);
};

$failed = false;
foreach ([['pk', $pkClient, $pkNative, 1.35], ['list100', $listClient, $listNative, 1.25]] as [$name, $client, $native, $bound]) {
    [$clientNs, $nativeNs] = pairedP50($client, $native);
    $ratio = $clientNs / $nativeNs;
    printf("%-8s native %6.1fµs  client %6.1fµs  ratio %.2f (bound %.2f)\n", $name, $nativeNs / 1000, $clientNs / 1000, $ratio, $bound);
    if ($ratio > $bound) { $failed = true; }
}
if ($failed) {
    fwrite(STDERR, "PHP generated client exceeds a performance regression limit\n");
    exit(1);
}
