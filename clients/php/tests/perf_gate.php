<?php
// Hot-path gate: the model client against the same statement through PDO with the same cell
// decoding and the same typed row conversion, measured in alternating pairs.
// Usage: php clients/php/tests/perf_gate.php
// ORM_BENCH_MYSQL_DSN names the seeded bench database; the gate fails without it.
// ORM_PERF_CPU_LOAD=1 runs the gate beside one busy process per CPU.
declare(strict_types=1);

require __DIR__ . '/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

use Polyspec\Orm\Tests\Model\Author;
use Orm\Codec;
use Orm\Config;
use Orm\Db;
use Orm\PendingTime;

if ($argc !== 1) {
    fwrite(STDERR, "usage: perf_gate.php\n");
    exit(2);
}

require __DIR__ . '/perf_extensions.php';
$refused = perfGateRefusedExtensions(fn (string $name): bool => extension_loaded($name));
if ($refused !== []) {
    fwrite(STDERR, 'perf_gate: this PHP loads ' . implode(', ', $refused) . '; the gate measures PHP without a debugger or coverage driver (shivammathur/setup-php coverage: none)' . "\n");
    exit(1);
}

$benchDsn = getenv('ORM_BENCH_MYSQL_DSN');
if ($benchDsn === false || $benchDsn === '') {
    fwrite(STDERR, "ORM_BENCH_MYSQL_DSN is required; it names the seeded bench database, and the gate never skips\n");
    exit(1);
}
$db = \Polyspec\Orm\Tests\Model\connect($benchDsn, new Config(
    aesKey: 'bench-salt',
    blindIndexKey: 'bench-blind-index',
));

/**
 * Measures client and native in adjacent pairs after a warm-up, alternating
 * which side runs first, and returns the median client and native times and
 * the median of the per-pair client/native ratios. Load that slows one pair
 * slows both of its sides, so the median ratio does not follow the machine load.
 * @return array{0: int, 1: int, 2: float}
 */
function pairedRatio(Closure $client, Closure $native, int $warm = 100, int $pairs = 1000): array
{
    for ($i = 0; $i < $warm; $i++) {
        $client();
        $native();
    }
    $times = [[], []];
    $ratios = [];
    for ($i = 0; $i < $pairs; $i++) {
        $pair = [0, 0];
        foreach (($i & 1) === 0 ? [0, 1] : [1, 0] as $side) {
            $start = hrtime(true);
            ($side === 0 ? $client : $native)();
            $pair[$side] = hrtime(true) - $start;
        }
        $times[0][] = $pair[0];
        $times[1][] = $pair[1];
        $ratios[] = $pair[0] / $pair[1];
    }
    sort($times[0]);
    sort($times[1]);
    sort($ratios);
    $mid = intdiv($pairs, 2);
    return [$times[0][$mid], $times[1][$mid], $ratios[$mid]];
}

/**
 * Starts one busy PHP process per CPU when ORM_PERF_CPU_LOAD=1, so the gate
 * runs under CPU load; the processes end when the gate ends.
 * @return list<resource>
 */
function cpuLoad(): array
{
    if (getenv('ORM_PERF_CPU_LOAD') !== '1') {
        return [];
    }
    $cpus = (int) trim((string) shell_exec('getconf _NPROCESSORS_ONLN'));
    if ($cpus < 1) {
        fwrite(STDERR, "gate: the CPU count is unknown\n");
        exit(2);
    }
    $load = [];
    for ($i = 0; $i < $cpus; $i++) {
        $process = proc_open([PHP_BINARY, '-r', 'while (true) {}'], [], $pipes);
        if ($process === false) {
            fwrite(STDERR, "gate: a load process did not start\n");
            exit(2);
        }
        $load[] = $process;
    }
    register_shutdown_function(static function () use ($load): void {
        foreach ($load as $process) {
            proc_terminate($process, 9);
            proc_close($process);
        }
    });
    return $load;
}

/** The statement, decode cells and typed row conversion a model terminal runs, prepared on
 * the same connection. The conversion mirrors Model::assembleRow: the same column groups,
 * the same per-kind casts and the same values array, without the client machinery. */
function native(Db $db, Author $query): Closure
{
    $q = $query->getQuery();
    $binds = array_map(static fn(mixed $v): mixed => $v === Db::SECRET ? 'bench-salt' : (is_bool($v) ? (int) $v : $v), $q['binds']);
    $cells = [];
    $columns = null;
    foreach ((new ReflectionProperty(\Orm\Engine::class, 'plans'))->getValue(\Orm\Engine::for(Author::meta()['manifest_hash'], $db->driver(), $db->config()->planCacheSize)) as $plan) {
        if ($plan['steps'][0]['sql'] === $q['sql']) {
            $cells = $plan['steps'][0]['decode'];
            $columns = $plan['steps'][0]['assemble']['columns'];
        }
    }
    if ($columns === null) {
        fwrite(STDERR, "gate: the engine holds no plan for the query\n");
        exit(2);
    }
    $meta = Author::meta()['columns'];
    $groups = ['int' => [], 'float' => [], 'bool' => [], 'date' => [], 'string' => [], 'codec' => []];
    foreach ($columns as $col) {
        $mc = $meta[$col['name']] ?? null;
        if ($mc === null || ($col['column'] ?? $col['name']) !== $col['name']) {
            fwrite(STDERR, "gate: selected {$col['name']} is not a plain author column\n");
            exit(2);
        }
        $kind = $mc['codec'] !== [] ? 'codec' : $mc['type'];
        $groups[match ($kind) {
            'i16', 'i32', 'i64' => 'int',
            'f64', 'decimal' => 'float',
            'bool' => 'bool',
            'date', 'datetime' => 'date',
            'codec' => 'codec',
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
            foreach ($groups['codec'] as [$index, $name]) {
                $values[$name] = $vals[$index];
            }
            $out[] = $values;
        }
    };
}

$cases = [
    ['pk', static fn() => (new Author)($db)->seq(42), 1.35],
    ['list100', static fn() => (new Author)($db)->serviceSeq(7)->andIsClose(false)->orderBySeqDesc()->limit(0, 100), 1.25],
];
$load = cpuLoad();
// GATE_DEADLINE은 gate case 하나의 기한이다. case는 warm-up 100쌍과 측정 1000쌍의 client와
// native 조회를 bench database에 보내고, 부하 process가 모든 CPU를 쓰는 동안에도 몇십 초
// 안에 끝난다.
const GATE_DEADLINE = 300.0;
$gate = new TestCases();
foreach ($cases as [$name, $query, $bound]) {
    $gate->run('perf_gate/' . $name . ($load === [] ? '' : '/under-load'), GATE_DEADLINE, static function (callable $step) use ($db, $query, $bound, $name): void {
        $native = native($db, $query());
        [$clientNs, $nativeNs, $ratio] = pairedRatio(static fn() => $query()->gets(), $native);
        $step(sprintf('native %.1fµs client %.1fµs ratio %.2f (bound %.2f)', $nativeNs / 1000, $clientNs / 1000, $ratio, $bound));
        if ($ratio > $bound) {
            throw new RuntimeException("PHP model client exceeds the $name performance regression limit");
        }
    });
}
$gate->finish();
