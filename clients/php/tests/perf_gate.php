<?php
// Hot-path gate: the model client against the same statement through PDO with the same cell
// decoding and the same typed row conversion, measured in alternating pairs.
// Usage: php clients/php/tests/perf_gate.php /abs/schema.json
// ORM_BENCH_MYSQL_DSN selects the seeded bench database.
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use App\Orm\Battle;
use Orm\Chain;
use Orm\Codec;
use Orm\Config;
use Orm\Db;
use Orm\Orm;
use Orm\PendingTime;

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

/** The statement, decode cells and typed row conversion a model terminal runs, prepared on
 * the same connection. The conversion mirrors Model::assembleRow: the same column groups,
 * the same per-kind casts and the same values array, without the client machinery. */
function native(Db $db, Battle $query): Closure
{
    $q = $query->getQuery();
    $binds = array_map(static fn(mixed $v): mixed => $v === Db::SECRET ? 'bench-salt' : (is_bool($v) ? (int) $v : $v), $q['binds']);
    $cells = [];
    $columns = null;
    foreach ((new ReflectionProperty(\Orm\Engine::class, 'plans'))->getValue((new ReflectionProperty(Db::class, 'engine'))->getValue($db)) as $plan) {
        if ($plan['steps'][0]['sql'] === $q['sql']) {
            $cells = $plan['steps'][0]['decode'];
            $columns = $plan['steps'][0]['assemble']['columns'];
        }
    }
    if ($columns === null) {
        fwrite(STDERR, "gate: the engine holds no plan for the query\n");
        exit(2);
    }
    $meta = Battle::meta()['columns'];
    $groups = ['int' => [], 'float' => [], 'bool' => [], 'date' => [], 'string' => [], 'other' => []];
    foreach ($columns as $col) {
        $mc = $meta[$col['name']] ?? null;
        if ($mc === null || ($col['column'] ?? $col['name']) !== $col['name']) {
            fwrite(STDERR, "gate: selected {$col['name']} is not a plain battle column\n");
            exit(2);
        }
        $kind = Chain::appStyled($mc) ? 'json' : $mc['type'];
        $groups[match ($kind) {
            'i32', 'i64' => 'int',
            'f64', 'decimal' => 'float',
            'bool' => 'bool',
            'date', 'datetime' => 'date',
            'point', 'json', 'jsontext' => 'other',
            default => 'string',
        }][] = [$col['index'], $col['name'], $kind];
    }
    $zone = $db->zone();
    $st = $db->pdo()->prepare($q['sql']);
    return static function () use ($st, $binds, $cells, $db, $groups, $zone): void {
        $st->execute($binds);
        $rows = $st->fetchAll(PDO::FETCH_NUM);
        Codec::decodeRows($rows, $cells, $db->config());
        $out = [];
        foreach ($rows as $vals) {
            $values = [];
            foreach ($groups['int'] as [$index, $name]) {
                $v = $vals[$index];
                $values[$name] = $v === null ? null : (int) $v;
            }
            foreach ($groups['float'] as [$index, $name]) {
                $v = $vals[$index];
                $values[$name] = $v === null ? null : (float) $v;
            }
            foreach ($groups['bool'] as [$index, $name]) {
                $v = $vals[$index];
                $values[$name] = $v === null ? null : (bool) $v;
            }
            foreach ($groups['date'] as [$index, $name]) {
                $v = $vals[$index];
                $values[$name] = $v === null ? null : new PendingTime($v, $zone);
            }
            foreach ($groups['string'] as [$index, $name]) {
                $v = $vals[$index];
                $values[$name] = $v === null || is_string($v) ? $v : (is_resource($v) ? stream_get_contents($v) : (string) $v);
            }
            foreach ($groups['other'] as [$index, $name, $kind]) {
                $v = $vals[$index];
                if (is_resource($v)) {
                    $v = stream_get_contents($v);
                }
                $values[$name] = $v === null || $kind === 'json' ? $v : Codec::point($v);
            }
            $out[] = $values;
        }
    };
}

$cases = [
    ['pk', static fn() => (new Battle)($db)->seq(42), 1.35],
    ['list100', static fn() => (new Battle)($db)->serviceSeq(7)->andIsClose(false)->orderBySeqDesc()->limit(0, 100), 1.25],
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
