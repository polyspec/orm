<?php

declare(strict_types=1);

// conformance_verification: the PHP conformance runner runs every vector of a dialect once on the seeded bench
// database of that dialect (BENCH_MYSQL_DSN, BENCH_POSTGRES_DSN, BENCH_SQLITE_DSN, which make run-databases and
// make orm-check create), and each vector is one data set, named by the vector, whose output must equal the recorded
// expect as a JSON value (tests/conformance/vectors.json for MySQL, vectors.<dialect>.json for the others).
// test_conformance_vector is the feature coverage (contracts/features.json): it runs the read-only vectors
// conditions_values and relations on the database that ORM_FEATURE_DATABASE and ORM_FEATURE_DSN select.

require_once __DIR__ . '/coverage_cases.php';

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;

// With the extension loaded (php-extension, S10) the client's entry classes are the extension's: a fallback to the PHP
// classes would not test the extension, so each one is asserted internal.
if (extension_loaded('polyspec_orm')) {
    foreach (['Polyspec\\Orm\\Db', 'Polyspec\\Orm\\Planner'] as $entry) {
        Assert::assertTrue((new \ReflectionClass($entry))->isInternal(), "$entry is the extension class");
    }
}

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

const CONFORMANCE_VECTORS = ['conditions_values', 'relations'];

#[Large]
final class CoverageConformanceVerificationTest extends TestCase
{
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
                "$variable is required, and database tests never skip; run make databases-create, which seeds the bench databases and writes their DSNs"
            );
        }
        $root = dirname(__DIR__, 3);
        [$status, $stdout, $stderr] = coverageProcess(
            [PHP_BINARY, "$root/packages/php/testing/conformance/runner.php", '--dsn', $dsn],
            $root
        );
        if ($status !== 0) {
            throw new RuntimeException(str_replace($dsn, '[dsn]', "conformance runner exited $status: $stderr$stdout"));
        }
        return self::$outputs[$driver] = json_decode($stdout, false, 512, JSON_THROW_ON_ERROR);
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

    #[DataProvider('mysqlVectors')]
    public function test_mysql(string $name, mixed $expect): void
    {
        self::check('mysql', $name, $expect);
    }

    #[DataProvider('postgresVectors')]
    public function test_postgres(string $name, mixed $expect): void
    {
        self::check('postgres', $name, $expect);
    }

    #[DataProvider('sqliteVectors')]
    public function test_sqlite(string $name, mixed $expect): void
    {
        self::check('sqlite', $name, $expect);
    }

    public function test_conformance_vector(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [$driver, $dsn] = coverageItem();
            $root = dirname(__DIR__, 3);
            $file = $driver === 'mysql' ? 'vectors.json' : "vectors.$driver.json";
            $recorded = coverageJson("$root/tests/conformance/$file", false);
            $expect = [];
            foreach ($recorded->vectors as $vector) {
                if (in_array($vector->name, CONFORMANCE_VECTORS, true)) {
                    $expect[$vector->name] = $vector->expect;
                }
            }
            Assert::assertTrue(count($expect) === count(CONFORMANCE_VECTORS), "$file lacks a selected vector");
            $command = [PHP_BINARY, "$root/packages/php/testing/conformance/runner.php", '--dsn', $dsn];
            foreach (CONFORMANCE_VECTORS as $name) {
                array_push($command, '--vector', $name);
            }
            [$status, $stdout, $stderr] = coverageProcess($command, $root);
            if ($status !== 0) {
                throw new RuntimeException(
                    str_replace($dsn, '[dsn]', "conformance runner exited $status: $stderr$stdout")
                );
            }
            $output = json_decode($stdout, false, 512, JSON_THROW_ON_ERROR);
            $names = array_keys(get_object_vars($output));
            Assert::assertTrue($names === CONFORMANCE_VECTORS, 'runner output vectors ' . json_encode($names));
            foreach (CONFORMANCE_VECTORS as $name) {
                Assert::assertTrue(
                    sameJson($output->$name, $expect[$name]),
                    "vector $name differs from $file: " . json_encode($output->$name)
                );
            }
        }
    }
}
