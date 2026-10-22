<?php

// Hot-path gate: the model client against the same statement through PDO with the same cell
// decoding and the same typed row conversion, measured in alternating pairs. Each gate query is a
// data set; the measurement is written to standard error, and a ratio above its reference is a
// warning there (`WARNING ...`), not a failure: performance is measured and reported, never a
// failed test (AGENTS.md).
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/PerfGateTest.php
// ORM_BENCH_MYSQL_DSN names the seeded bench database; the gate fails without it.
// ORM_PERF_CPU_LOAD=1 runs the gate beside one busy process per CPU.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Closure;
use PDO;
use ReflectionProperty;
use RuntimeException;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\DoesNotPerformAssertions;
use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Codec;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\PendingTime;

// A gate case sends 100 warm-up pairs and 1000 measured pairs of client and native reads to the
// bench database and ends within tens of seconds, also while load processes use every CPU.
#[Large]
final class PerfGateTest extends TestCase
{
    private static ?Db $db = null;

    public static function setUpBeforeClass(): void
    {
        $refused = perfGateRefusedExtensions(fn (string $name): bool => extension_loaded($name));
        if ($refused !== []) {
            throw new RuntimeException(
                'perf_gate: this PHP loads ' . implode(
                    ', ',
                    $refused
                ) . '; the gate measures PHP without a debugger or coverage driver (shivammathur/setup-php coverage: '
                    . 'none)'
            );
        }
        $benchDsn = requiredDsn('ORM_BENCH_MYSQL_DSN');
        if ($benchDsn === false || $benchDsn === '') {
            throw new RuntimeException(
                'ORM_BENCH_MYSQL_DSN is required; it names the seeded bench database, and the gate never skips; run '
                . 'it through make orm-check or make run-databases TARGETS=<target>, which create the bench database '
                . 'of the run'
            );
        }
        self::$db = \Polyspec\Orm\Tests\Model\connect($benchDsn, new Config(
            aesKey: 'bench-salt',
            blindIndexKey: 'bench-blind-index',
        ));
        self::cpuLoad();
    }

    /**
     * The gate queries with their reference ratio, each a data set; under ORM_PERF_CPU_LOAD=1 the
     * data set names end in /under-load.
     *
     * @return iterable<string, array{string, float}>
     */
    public static function gates(): iterable
    {
        $suffix = getenv('ORM_PERF_CPU_LOAD') === '1' ? '/under-load' : '';
        yield "pk$suffix" => ['pk', 1.35];
        yield "list100$suffix" => ['list100', 1.25];
    }

    private static function query(string $name): Author
    {
        return match ($name) {
            'pk' => (new Author())(self::$db)->seq(42),
            'list100' => (new Author())(self::$db)->serviceSeq(7)->andIsClose(false)->orderBySeqDesc()->limit(0, 100),
        };
    }

    /** The gate measures and reports; it asserts nothing, since a slow ratio is a warning. */
    #[DataProvider('gates')]
    #[DoesNotPerformAssertions]
    public function testPerfGate(string $name, float $bound): void
    {
        $native = self::native(self::$db, self::query($name));
        [$clientNs, $nativeNs, $ratio] = self::pairedRatio(static fn() => self::query($name)->gets(), $native);
        fwrite(
            STDERR,
            sprintf(
                "perf_gate %s: native %.1fµs client %.1fµs ratio %.2f (bound %.2f)\n",
                $name,
                $nativeNs / 1000,
                $clientNs / 1000,
                $ratio,
                $bound
            )
        );
        if ($ratio > $bound) {
            fwrite(
                STDERR,
                sprintf(
                    "WARNING perf_gate %s: client/native ratio %.2f is above its reference %.2f "
                    . "(docs/operations/perf.md); machine %s %s, PHP %s\n",
                    $name,
                    $ratio,
                    $bound,
                    PHP_OS_FAMILY,
                    php_uname('m'),
                    PHP_VERSION
                )
            );
        }
    }

    /**
     * Measures client and native in adjacent pairs after a warm-up, alternating
     * which side runs first, and returns the median client and native times and
     * the median of the per-pair client/native ratios. Load that slows one pair
     * slows both of its sides, so the median ratio does not follow the machine load.
     * @return array{0: int, 1: int, 2: float}
     */
    private static function pairedRatio(Closure $client, Closure $native, int $warm = 100, int $pairs = 1000): array
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
    private static function cpuLoad(): array
    {
        if (getenv('ORM_PERF_CPU_LOAD') !== '1') {
            return [];
        }
        $cpus = (int) trim((string) shell_exec('getconf _NPROCESSORS_ONLN'));
        if ($cpus < 1) {
            throw new RuntimeException('gate: the CPU count is unknown');
        }
        $load = [];
        for ($i = 0; $i < $cpus; $i++) {
            $process = proc_open([PHP_BINARY, '-r', 'while (true) {}'], [], $pipes);
            if ($process === false) {
                throw new RuntimeException('gate: a load process did not start');
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
    private static function native(Db $db, Author $query): Closure
    {
        $q = $query->getQuery();
        $binds = array_map(
            static fn(mixed $v): mixed => $v === Db::SECRET ? 'bench-salt' : (is_bool($v) ? (int) $v : $v),
            $q['binds']
        );
        $cells = [];
        $columns = null;
        foreach (
            (new ReflectionProperty(\Polyspec\Orm\Engine::class, 'plans'))->getValue(
                \Polyspec\Orm\Engine::for(Author::meta()['manifest_hash'], $db->driver(), $db->config()->planCacheSize)
            ) as $plan
        ) {
            if ($plan['steps'][0]['sql'] === $q['sql']) {
                $cells = $plan['steps'][0]['decode'];
                $columns = $plan['steps'][0]['assemble']['columns'];
            }
        }
        if ($columns === null) {
            throw new RuntimeException('gate: the engine holds no plan for the query');
        }
        $meta = Author::meta()['columns'];
        $groups = ['int' => [], 'float' => [], 'bool' => [], 'date' => [], 'string' => [], 'codec' => []];
        foreach ($columns as $col) {
            $mc = $meta[$col['name']] ?? null;
            if ($mc === null || ($col['column'] ?? $col['name']) !== $col['name']) {
                throw new RuntimeException("gate: selected {$col['name']} is not a plain author column");
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
                    $values[$name] = $v === null || is_string($v) ? $v : (
                        is_resource($v) ? stream_get_contents($v) : (string) $v
                    );
                }
                foreach ($groups['codec'] as [$index, $name]) {
                    $values[$name] = $vals[$index];
                }
                $out[] = $values;
            }
        };
    }
}
