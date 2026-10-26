<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

    // conformance_verification: the PHP conformance runner runs every vector of a dialect once on the seeded bench
// database of that dialect (BENCH_MYSQL_DSN, BENCH_POSTGRES_DSN, BENCH_SQLITE_DSN, which make run-databases and
// make orm-check create), and each vector is one data set, named by the vector, whose output must equal the recorded
// expect as a JSON value (tests/conformance/vectors.json for MySQL, vectors.<dialect>.json for the others).
// testConformanceVector is the feature coverage (contracts/features.json): it runs the selected conformance vectors
// on the database that ORM_FEATURE_DATABASE and ORM_FEATURE_DSN select.


use RuntimeException;
use stdClass;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;

/** Compares two JSON values: arrays in order, objects by key set and values, numbers by value. */
function sameJson(mixed $a, mixed $b): bool
{
    if ($a instanceof stdClass || $b instanceof stdClass) {
        if (!$a instanceof stdClass || !$b instanceof stdClass) {
            return false;
        }
        $left = get_object_vars($a);
        $right = get_object_vars($b);
        if (count($left) !== count($right)) {
            return false;
        }
        foreach ($left as $key => $value) {
            if (!array_key_exists($key, $right) || !sameJson($value, $right[$key])) {
                return false;
            }
        }
        return true;
    }
    if (is_array($a) || is_array($b)) {
        if (!is_array($a) || !is_array($b) || count($a) !== count($b)) {
            return false;
        }
        foreach ($a as $i => $value) {
            if (!sameJson($value, $b[$i])) {
                return false;
            }
        }
        return true;
    }
    if ((is_int($a) || is_float($a)) && (is_int($b) || is_float($b))) {
        return $a == $b;
    }
    return $a === $b;
}

const CONFORMANCE_VECTORS = [
    'audit_lazy',
    'conditions_values',
    'relations',
    'delete_lock',
    'relation_null_key',
    'functions',
    'creates_and_save',
];

#[Large]
final class CoverageConformanceVerificationTest extends TestCase
{
    // Requirements: INT-39. The runner compares the restore_or_create vector with the recorded result.
    /** @var array<string, stdClass> the runner output of each dialect, read once per process */
    private static array $outputs = [];

    private static function file(string $driver): string
    {
        return dirname(__DIR__, 3) . '/tests/conformance/' . (
            $driver === 'mysql' ? 'vectors.json' : "vectors.$driver.json"
        );
    }

    /** @return iterable<string, array{string, mixed}> */
    private static function vectors(string $driver): iterable
    {
        foreach (coverageJson(self::file($driver), false)->vectors as $vector) {
            yield $vector->name => [$vector->name, $vector->expect];
        }
    }

    public static function mysqlVectors(): iterable
    {
        return self::vectors('mysql');
    }

    public static function postgresVectors(): iterable
    {
        return self::vectors('postgres');
    }

    public static function sqliteVectors(): iterable
    {
        return self::vectors('sqlite');
    }

    /** The output of the runner over every vector of the dialect on its bench database. */
    private static function runnerOutput(string $driver): stdClass
    {
        if (isset(self::$outputs[$driver])) {
            return self::$outputs[$driver];
        }
        $variable = 'BENCH_' . strtoupper($driver) . '_DSN';
        $dsn = getenv($variable);
        if (!is_string($dsn) || $dsn === '') {
            throw new RuntimeException(
                "$variable is required, and database tests never skip; run make databases-create, which seeds the "
                . "bench databases and writes their DSNs"
            );
        }
        $root = dirname(__DIR__, 3);
        $output = null;
        coverageWithConformanceCountersRestored($driver, $dsn, static function () use ($root, $dsn, &$output): void {
            [$status, $stdout, $stderr] = coverageProcess(
                [PHP_BINARY, "$root/packages/php/testing/conformance/runner.php", '--dsn', $dsn],
                $root
            );
            if ($status !== 0) {
                throw new RuntimeException(str_replace(
                    $dsn,
                    '[dsn]',
                    "conformance runner exited $status: $stderr$stdout",
                ));
            }
            $output = json_decode($stdout, false, 512, JSON_THROW_ON_ERROR);
        });
        if (!$output instanceof stdClass) {
            throw new RuntimeException('conformance runner returned no object');
        }
        return self::$outputs[$driver] = $output;
    }

    private static function check(string $driver, string $name, mixed $expect): void
    {
        $output = self::runnerOutput($driver);
        Assert::assertTrue(property_exists($output, $name), "the runner gave no output for $name");
        Assert::assertTrue(
            sameJson($output->$name, $expect),
            "vector $name differs from " . basename(self::file($driver)) . ': ' . json_encode($output->$name)
        );
    }

    // Requirements: DIA-37.
    #[DataProvider('mysqlVectors')]
    // Requirements: PRT-68, INT-20, INT-21, INT-22, INT-23, INT-24, INT-25, INT-26, DIA-24.
    public function testMysql(string $name, mixed $expect): void
    {
        self::check('mysql', $name, $expect);
    }

    #[DataProvider('postgresVectors')]
    // Requirements: PRT-68, INT-20, INT-21, INT-22, INT-23, INT-24, INT-25, INT-26, DIA-24.
    public function testPostgres(string $name, mixed $expect): void
    {
        self::check('postgres', $name, $expect);
    }

    #[DataProvider('sqliteVectors')]
    // Requirements: PRT-68, INT-20, INT-21, INT-22, INT-23, INT-24, INT-25, INT-26, DIA-24, DBS-115.
    public function testSqlite(string $name, mixed $expect): void
    {
        self::check('sqlite', $name, $expect);
    }

    // Requirements: CFG-8, DSL-87, DSL-111, DSL-137, DSL-139, DSL-144, DIA-11, DIA-14.
    public function testConformanceVector(): void
    {
        coverageAssertEntryClassesAreInternal();
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [$driver, $dsn] = coverageItem();
            if (!is_string($dsn) || $dsn === '') {
                throw new RuntimeException("coverage item for $driver has no DSN");
            }
            $root = dirname(__DIR__, 3);
            [$file, $expect] = coverageRecordedConformanceVectors($driver, CONFORMANCE_VECTORS);
            foreach (CONFORMANCE_VECTORS as $name) {
                $command = [
                    PHP_BINARY,
                    "$root/packages/php/testing/conformance/runner.php",
                    '--dsn',
                    $dsn,
                    '--vector',
                    $name,
                ];
                coverageWithConformanceCountersRestored(
                    $driver,
                    $dsn,
                    static function () use ($command, $root, $dsn, $file, $expect, $name): void {
                        [$status, $stdout, $stderr] = coverageProcess($command, $root);
                        if ($status !== 0) {
                            throw new RuntimeException(
                                str_replace($dsn, '[dsn]', "conformance runner exited $status: $stderr$stdout")
                            );
                        }
                        $output = json_decode($stdout, false, 512, JSON_THROW_ON_ERROR);
                        Assert::assertSame([$name], array_keys(get_object_vars($output)));
                        Assert::assertTrue(
                            sameJson($output->$name, $expect[$name]),
                            "vector $name differs from $file: " . json_encode($output->$name)
                        );
                    },
                );
            }
        }
    }
}
