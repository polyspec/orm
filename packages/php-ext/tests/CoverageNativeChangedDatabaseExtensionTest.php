<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\SchemaUtils;
use ReflectionClass;
use ReflectionMethod;

#[Medium]
final class CoverageNativeChangedDatabaseExtensionTest extends TestCase
{
    public function testInstallChangedDatabase(): void
    {
        $this->assertNativeSchemaInstallEntryPoints();
        \Polyspec\Orm\Tests\SchemaSetTest::setUpBeforeClass();
        $owner = new \Polyspec\Orm\Tests\SchemaSetTest('testInstallVerifiesTheDatabase');
        foreach (\Polyspec\Orm\Tests\SchemaSetTest::changedDatabaseCases() as [$case]) {
            $owner->testInstallVerifiesTheDatabase($case);
        }
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
