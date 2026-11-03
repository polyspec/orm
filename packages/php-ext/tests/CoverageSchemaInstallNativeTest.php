<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class CoverageSchemaInstallNativeTest extends TestCase
{
    private static bool $nativeSchemaSetFixtureReady = false;

    private static function runNativeAddTablesAndColumns(string $method): void
    {
        \Polyspec\Orm\Extension\Tests\PhpExtensionBootstrapAssertions::requireLoaded();
        coverageAssertEntryClassesAreInternal();
        $owner = new \Polyspec\Orm\Tests\AddTablesAndColumnsTest($method);
        foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
            $owner->{$method}($driver);
        }
    }

    // Requirements: SCH-9.
    public function testNativeAddTablesAndColumnsDiffers(): void
    {
        self::runNativeAddTablesAndColumns('testAddTablesAndColumnsDiffers');
    }

    // Requirements: SCH-8, SCH-9.
    public function testNativeAddTablesAndColumnsIndex(): void
    {
        self::runNativeAddTablesAndColumns('testAddTablesAndColumnsIndex');
    }

    // Requirements: SCH-8.
    public function testNativeAddTablesAndColumnsTransaction(): void
    {
        self::runNativeAddTablesAndColumns('testAddTablesAndColumnsTransaction');
    }

    // Requirements: SCH-8.
    public function testNativeAddTablesAndColumnsEditedManifest(): void
    {
        self::runNativeAddTablesAndColumns('testAddTablesAndColumnsEditedManifest');
    }

    // Requirements: DBS-108, SCH-7.
    public function testSchemaSetSeveralSchemas(): void
    {
        self::runNativeSchemaSet('testSeveralSchemas');
    }

    // Requirements: DBS-119.
    public function testSchemaSetUnregisteredSchema(): void
    {
        self::runNativeSchemaSet('testUnregisteredSchema');
    }

    // Requirements: DBS-120, SCH-7, SCH-11.
    public function testSchemaSetEditedManifest(): void
    {
        self::runNativeSchemaSet('testEditedManifest');
    }

    /** Runs the library-owned scenario with the loaded native entry points and the same per-driver case databases. */
    private static function runNativeSchemaSet(string $method): void
    {
        \Polyspec\Orm\Extension\Tests\PhpExtensionBootstrapAssertions::requireLoaded();
        coverageAssertEntryClassesAreInternal();
        if (!self::$nativeSchemaSetFixtureReady) {
            \Polyspec\Orm\Tests\SchemaSetTest::setUpBeforeClass();
            self::$nativeSchemaSetFixtureReady = true;
        }
        $owner = new \Polyspec\Orm\Tests\SchemaSetTest($method);
        foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
            $owner->{$method}($driver);
        }
    }
}
