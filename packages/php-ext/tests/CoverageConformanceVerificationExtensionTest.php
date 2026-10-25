<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Model;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;
use ReflectionClass;

#[Large]
final class CoverageConformanceVerificationExtensionTest extends TestCase
{
    private const CONFORMANCE_VECTORS = ['conditions_values', 'relations', 'delete_lock', 'audit_lazy', 'relation_null_key'];

    private static function extensionPath(): string
    {
        $path = getenv('POLYSPEC_ORM_EXTENSION');
        if (!is_string($path) || $path === '') {
            throw new \RuntimeException(
                'POLYSPEC_ORM_EXTENSION is required to run the PHP extension conformance child'
            );
        }
        return $path;
    }

    private static function childCommand(string $script, string ...$arguments): array
    {
        return [PHP_BINARY, '-d', 'extension=' . self::extensionPath(), $script, ...$arguments];
    }

    /** @return array<string, string> */
    private static function childEnvironment(): array
    {
        $environment = getenv();
        if (!is_array($environment)) {
            throw new \RuntimeException('cannot read the parent environment for the native conformance child');
        }
        $environment['ORM_PHP_MODE'] = 'extension';
        $environment['POLYSPEC_ORM_EXTENSION'] = self::extensionPath();
        return $environment;
    }

    // Requirements: DSL-87.
    // Requirements: PRT-68, INT-20, INT-21, INT-22, INT-23, INT-24, INT-25, INT-26, INT-39.
    public function testMysql(): void
    {
        $this->assertNativeConformanceVectors('mysql');
    }

    // Requirements: DSL-87.
    // Requirements: PRT-68, INT-20, INT-21, INT-22, INT-23, INT-24, INT-25, INT-26, INT-39.
    public function testPostgres(): void
    {
        $this->assertNativeConformanceVectors('postgres');
    }

    // Requirements: DSL-87.
    // Requirements: PRT-68, INT-20, INT-21, INT-22, INT-23, INT-24, INT-25, INT-26, INT-39.
    public function testSqlite(): void
    {
        $this->assertNativeConformanceVectors('sqlite');
    }

    private function assertNativeConformanceVectors(string $driver): void
    {
        Assert::assertTrue((new ReflectionClass(Model::class))->isInternal());
        $variable = 'BENCH_' . strtoupper($driver) . '_DSN';
        $dsn = getenv('ORM_FEATURE_DSN') ?: getenv($variable);
        if (!is_string($dsn) || $dsn === '') {
            throw new \RuntimeException(
                "ORM_FEATURE_DSN or $variable is required to run the native conformance vectors"
            );
        }

        $root = dirname(__DIR__, 3);
        $file = $driver === 'mysql' ? 'vectors.json' : "vectors.$driver.json";
        $recorded = coverageJson("$root/tests/conformance/$file", false);
        $expected = [];
        foreach ($recorded->vectors as $vector) {
            if (isset($expected[$vector->name]) || $vector->expect === null) {
                throw new \RuntimeException("$file: vector {$vector->name} is repeated or has no expectation");
            }
            $expected[$vector->name] = $vector->expect;
        }

        [$status, $stdout, $stderr] = coverageProcess(
            self::childCommand("$root/packages/php/testing/conformance/runner.php", '--dsn', $dsn),
            $root,
            self::childEnvironment(),
        );
        if ($status !== 0) {
            throw new \RuntimeException(
                str_replace($dsn, '[dsn]', "native conformance child exited $status: $stderr$stdout")
            );
        }

        $actual = json_decode($stdout, false, 512, JSON_THROW_ON_ERROR);
        Assert::assertSame(array_keys($expected), array_keys(get_object_vars($actual)), "native {$driver} vector set");
        foreach ($expected as $name => $expect) {
            Assert::assertTrue(
                \Polyspec\Orm\Tests\sameJson($actual->$name, $expect),
                "native extension vector $name differs from $file",
            );
        }
    }

    public function testConformanceChildLoadsTheNativeModelEntrypoint(): void
    {
        Assert::assertTrue((new ReflectionClass(Model::class))->isInternal());
        $root = dirname(__DIR__, 3);
        [$status, $stdout, $stderr] = coverageProcess(
            [
                PHP_BINARY,
                '-d',
                'extension=' . self::extensionPath(),
                '-r',
                'exit((new ReflectionClass("Polyspec\\Orm\\Model"))->isInternal() ? 0 : 1);',
            ],
            $root,
            self::childEnvironment(),
        );
        Assert::assertSame(0, $status, "native extension child failed: $stderr$stdout");
    }

    public function testRelationNullKeyRefusalMatchesRecordedVector(): void
    {
        Assert::assertTrue((new ReflectionClass(Model::class))->isInternal());
        $root = dirname(__DIR__, 3);
        $recorded = coverageJson("$root/tests/conformance/vectors.sqlite.json", false);
        $expected = null;
        foreach ($recorded->vectors as $vector) {
            if ($vector->name === 'relation_null_key') {
                $expected = $vector->expect;
                break;
            }
        }
        Assert::assertNotNull($expected, 'SQLite vectors lack relation_null_key');
        $path = tempnam(sys_get_temp_dir(), 'orm-relation-null-key-');
        if ($path === false) {
            throw new \RuntimeException('could not create the SQLite file for relation_null_key');
        }
        try {
            [$status, $stdout, $stderr] = coverageProcess(
                self::childCommand(
                    "$root/packages/php/testing/conformance/runner.php",
                    '--dsn',
                    'sqlite:///' . $path,
                    '--vector',
                    'relation_null_key',
                ),
                $root,
                self::childEnvironment(),
            );
            Assert::assertSame(0, $status, "native relation_null_key child failed: $stderr$stdout");
            $actual = json_decode($stdout, false, 512, JSON_THROW_ON_ERROR);
            Assert::assertSame(['relation_null_key'], array_keys(get_object_vars($actual)));
            Assert::assertTrue(
                \Polyspec\Orm\Tests\sameJson($actual->relation_null_key, $expected),
                'native extension relation_null_key differs from the recorded SQLite vector',
            );
        } finally {
            if (is_file($path) && !unlink($path)) {
                throw new \RuntimeException("could not remove the SQLite file for relation_null_key: $path");
            }
        }
    }

    // Requirements: CFG-8.
    // Requirements: DSL-1, DSL-2, DSL-3, DSL-4, DSL-5, DSL-6, DSL-7, DSL-10, DSL-11, DSL-12, DSL-13, DSL-14.
    // Requirements: DSL-15, DSL-16, DSL-17, DSL-18, DSL-19, DSL-20, DSL-21, DSL-22, DSL-23, DSL-24, DSL-25, DSL-26.
    // Requirements: DSL-27, DSL-28, DSL-29, DSL-30, DSL-31, DSL-34, DSL-35, DSL-36, DSL-45, DSL-46, DSL-47, DSL-48.
    // Requirements: DSL-51, DSL-53, DSL-54, DSL-55, DSL-56, DSL-57, DSL-58, DSL-59, DSL-60, DSL-61, DSL-62, DSL-63.
    // Requirements: DSL-64, DSL-65, DSL-67, DSL-68, DSL-69, DSL-70, DSL-71, DSL-72, DSL-73, DSL-74, DSL-75, DSL-76.
    // Requirements: DSL-77, DSL-79, DSL-80, DSL-81, DSL-82, DSL-83, DSL-84, DSL-85, DSL-86, DSL-87, DSL-88, DSL-89.
    // Requirements: DSL-90, DSL-91, DSL-92, DSL-93, DSL-94, DSL-95, DSL-96, DSL-97, DSL-98, DSL-99, DSL-100, DSL-101.
    // Requirements: DSL-102, DSL-103, DSL-104, DSL-105, DSL-106, DSL-107, DSL-108, DSL-109, DSL-110, DSL-111, DSL-112.
    // Requirements: DSL-114, DSL-115, DSL-118, DSL-119, DSL-123, DSL-131, DSL-132, DSL-133, DSL-134, DSL-135, DSL-136.
    // Requirements: DSL-137, DSL-139.
    // Requirements: DSL-140, DSL-143, DSL-144, DSL-145, DSL-146, DIA-1, DIA-2, DIA-3, DIA-4, DIA-5, DIA-8, DIA-9.
    // Requirements: DIA-10, DIA-11, DIA-13, DIA-14, DIA-15, DIA-16, DIA-18, DIA-19, DIA-22, DIA-23, DIA-24, DIA-26.
    // Requirements: DIA-27, DIA-29, DIA-35, DIA-36, DIA-37, DIA-41, DIA-43, DIA-46, DIA-48, DIA-54, COD-6, COD-15.
    // Requirements: COD-41, COD-42, PRT-5, PRT-8, PRT-9, PRT-11, PRT-15, PRT-19, PRT-36, PRT-38, PRT-39, PRT-40.
    // Requirements: PRT-42, PRT-67, PRT-70, DIA-108, DBS-59, DBS-87, DBS-113, DBS-117, CPX-3.
    public function testConformanceVector(): void
    {
        Assert::assertTrue((new ReflectionClass(Model::class))->isInternal());
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [$driver, $dsn] = coverageItem();
            $root = dirname(__DIR__, 3);
            [, $expected] = coverageRecordedConformanceVectors($driver, self::CONFORMANCE_VECTORS);
            $arguments = [];
            foreach (self::CONFORMANCE_VECTORS as $vector) {
                array_push($arguments, '--vector', $vector);
            }
            $command = self::childCommand(
                "$root/packages/php/testing/conformance/runner.php",
                '--dsn',
                (string) $dsn,
                ...$arguments,
            );
            [$status, $stdout, $stderr] = coverageProcess($command, $root, self::childEnvironment());
            if ($status !== 0) {
                throw new \RuntimeException(
                    str_replace((string) $dsn, '[dsn]', "native conformance child exited $status: $stderr$stdout")
                );
            }
            $actual = json_decode($stdout, false, 512, JSON_THROW_ON_ERROR);
            Assert::assertSame(
                array_keys($expected),
                array_keys(get_object_vars($actual)),
                'native conformance child returned a different selected vector set',
            );
            foreach ($expected as $name => $expect) {
                Assert::assertTrue(
                    \Polyspec\Orm\Tests\sameJson($actual->$name, $expect),
                    "native extension vector $name differs from $file",
                );
            }
        }
    }
}
