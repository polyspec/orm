<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\SchemaUtils;
use ReflectionClass;
use ReflectionMethod;
use RuntimeException;

#[Medium]
final class CoverageNativeChangedDatabaseExtensionTest extends TestCase
{
    /** @return iterable<string, array{string}> */
    public static function installChangedDatabaseVectors(): iterable
    {
        $seen = [];
        foreach (\Polyspec\Orm\Tests\SchemaSetTest::changedDatabaseCases() as [$case]) {
            $id = $case['id'] ?? null;
            if (!is_string($id) || $id === '' || isset($seen[$id])) {
                throw new RuntimeException('changed-database fixture cases must have non-empty unique IDs');
            }
            $seen[$id] = true;
            yield $id => [$id];
        }
        if ($seen === []) {
            throw new RuntimeException('changed-database fixture has no cases');
        }
    }

    public function testInstallChangedDatabase(): void
    {
        $this->assertNativeSchemaInstallEntryPoints();
        \Polyspec\Orm\Tests\SchemaSetTest::setUpBeforeClass();
        $owner = new \Polyspec\Orm\Tests\SchemaSetTest('testInstallVerifiesTheDatabase');
        foreach (\Polyspec\Orm\Tests\SchemaSetTest::changedDatabaseCases() as [$case]) {
            $this->assertChangedDatabaseCase($owner, $case);
        }
    }

    #[DataProvider('installChangedDatabaseVectors')]
    public function testInstallChangedDatabaseVector(string $id): void
    {
        $this->assertNativeSchemaInstallEntryPoints();
        \Polyspec\Orm\Tests\SchemaSetTest::setUpBeforeClass();
        $owner = new \Polyspec\Orm\Tests\SchemaSetTest('testInstallVerifiesTheDatabase');
        $match = null;
        foreach (\Polyspec\Orm\Tests\SchemaSetTest::changedDatabaseCases() as [$case]) {
            if ($case['id'] === $id) {
                if ($match !== null) {
                    throw new RuntimeException("changed-database fixture repeats case $id");
                }
                $match = $case;
            }
        }
        if ($match === null) {
            throw new RuntimeException("changed-database fixture has no case $id");
        }
        $this->assertChangedDatabaseCase($owner, $match);
    }

    /** @param array<string, mixed> $case */
    private function assertChangedDatabaseCase(\Polyspec\Orm\Tests\SchemaSetTest $owner, array $case): void
    {
        $owner->testInstallVerifiesTheDatabase($case);
    }

    public function testInstallChangedDatabaseSqlite(): void
    {
        $this->assertNativeSchemaInstallEntryPoints();
        \Polyspec\Orm\Tests\SchemaSetTest::setUpBeforeClass();
        $method = new \ReflectionMethod(\Polyspec\Orm\Tests\SchemaSetTest::class, 'installVerifiesTheDatabase');
        foreach (\Polyspec\Orm\Tests\SchemaSetTest::changedDatabaseCases() as [$case]) {
            \Polyspec\Orm\Tests\with_case_database(
                'sqlite',
                static function (string $step): void {
                },
                static fn(string $dsn) => $method->invoke(null, $dsn, $case)
            );
        }
    }

    private function assertNativeSchemaInstallEntryPoints(): void
    {
        Assert::assertTrue((new ReflectionClass(SchemaUtils::class))->isInternal());
        Assert::assertTrue((new ReflectionMethod(SchemaUtils::class, 'install'))->isInternal());
    }
}
