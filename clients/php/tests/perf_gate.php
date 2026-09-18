<?php
// Hot-path gate: the model client against the same statement through PDO with the same cell
// decoding, measured in alternating pairs.
// Usage: php clients/php/tests/perf_gate.php /abs/schema.json
// ORM_BENCH_MYSQL_DSN selects the seeded bench database.
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use App\Orm\Battle;
use Orm\Codec;
use Orm\Config;
use Orm\Db;
use Orm\Orm;

if ($argc < 2) {
    fwrite(STDERR, "usage: perf_gate.php /abs/schema.json\n");
    exit(2);
}

$db = Orm::connect(getenv('ORM_BENCH_MYSQL_DSN') ?: 'mysql://root@localhost/orm_bench?socket=/tmp/mysql.sock', new Config(
    schemaPath: $argv[1],
    aesKey: 'bench-salt',
    blindIndexKey: 'bench-blind-index',
));

/** @return array{0: int, 1: int} */
function pairedP50(Closure $client, Closure $native, int $iterations = 300): array
{
    for ($i = 0; $i < 50; $i++) {
        $client();
        $native();
    }
    $times = [[], []];
    for ($i = 0; $i < $iterations; $i++) {
        foreach (($i & 1) === 0 ? [0, 1] : [1, 0] as $side) {
            $start = hrtime(true);
            ($side === 0 ? $client : $native)();
            $times[$side][] = hrtime(true) - $start;
        }
    }
    sort($times[0]);
    sort($times[1]);
    return [$times[0][intdiv($iterations, 2)], $times[1][intdiv($iterations, 2)]];
}

/** The statement and decode cells a model terminal runs, prepared on the same connection. */
function native(Db $db, Battle $query): Closure
{
    $q = $query->getQuery();
    $binds = array_map(static fn(mixed $v): mixed => $v === Db::SECRET ? 'bench-salt' : (is_bool($v) ? (int) $v : $v), $q['binds']);
    $cells = [];
    foreach ((new ReflectionProperty(\Orm\Engine::class, 'plans'))->getValue((new ReflectionProperty(Db::class, 'engine'))->getValue($db)) as $plan) {
        if ($plan['steps'][0]['sql'] === $q['sql']) {
            $cells = $plan['steps'][0]['decode'];
        }
    }
    $st = $db->pdo()->prepare($q['sql']);
    return static function () use ($st, $binds, $cells, $db): void {
        $st->execute($binds);
        $rows = $st->fetchAll(PDO::FETCH_NUM);
        Codec::decodeRows($rows, $cells, $db->config());
    };
}

$cases = [
    ['pk', static fn() => (new Battle)($db)->seq(42), 1.35],
    ['list100', static fn() => (new Battle)($db)->serviceSeq(7)->andIsClose(false)->orderBySeqDesc()->limit(0, 100), 1.50],
];
$failed = false;
foreach ($cases as [$name, $query, $bound]) {
    $native = native($db, $query());
    [$clientNs, $nativeNs] = pairedP50(static fn() => $query()->gets(), $native);
    $ratio = $clientNs / $nativeNs;
    printf("%-8s native %7.1fµs  client %7.1fµs  ratio %.2f (bound %.2f)\n", $name, $nativeNs / 1000, $clientNs / 1000, $ratio, $bound);
    if ($ratio > $bound) {
        $failed = true;
    }
}
if ($failed) {
    fwrite(STDERR, "PHP model client exceeds a performance regression limit\n");
    exit(1);
}
