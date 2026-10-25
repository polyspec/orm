<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Tests\PgsqlPdoAdapterCases;
use ReflectionMethod;

#[Medium]
final class PgsqlPdoAdapterNativeTest extends TestCase
{
    use PgsqlPdoAdapterCases;

    public function testNativePgsqlAdapterExecutesAndRollsBackOnSameConnection(): void
    {
        self::assertTrue((new ReflectionMethod(\Polyspec\Orm\Orm::class, 'connect'))->isInternal());
        $this->assertPgsqlAdapterExecutesBoundValuesAndRollsBack(true);
    }

    public function testNativePgsqlAdapterPublicSurfaceIsInternalAndInitialized(): void
    {
        self::assertTrue((new ReflectionMethod(\Polyspec\Orm\Orm::class, 'connect'))->isInternal());
        $this->assertPdoPublicSurfaceIsOverridden(true);
    }

    public function testNativePgsqlAdapterFetchModesAndMetadata(): void
    {
        self::assertTrue((new ReflectionMethod(\Polyspec\Orm\Orm::class, 'connect'))->isInternal());
        $this->assertPgsqlAdapterFetchModesAndMetadata(true);
    }

    public function testNativePgsqlAdapterLastInsertIdTracksSequence(): void
    {
        self::assertTrue((new ReflectionMethod(\Polyspec\Orm\Orm::class, 'connect'))->isInternal());
        $this->assertPgsqlAdapterLastInsertIdTracksSequence();
    }

    public function testNativePgsqlAdapterStatementErrorCarriesItsSqlState(): void
    {
        self::assertTrue((new ReflectionMethod(\Polyspec\Orm\Orm::class, 'connect'))->isInternal());
        $this->assertPgsqlAdapterStatementErrorCarriesItsSqlState();
    }

    public function testNativePgsqlAdapterBoundParametersPreserveReferencesAndTypes(): void
    {
        self::assertTrue((new ReflectionMethod(\Polyspec\Orm\Orm::class, 'connect'))->isInternal());
        $this->assertPgsqlAdapterBoundParametersPreserveReferencesAndTypes(true);
    }

    public function testNativePgsqlAdapterPostgresConnectionMethods(): void
    {
        self::assertTrue((new ReflectionMethod(\Polyspec\Orm\Orm::class, 'connect'))->isInternal());
        $this->assertPgsqlAdapterPostgresConnectionMethods(true);
    }

    public function testNativePgsqlAdapterCopiesFilesAndRoundTripsLargeObjects(): void
    {
        self::assertTrue((new ReflectionMethod(\Polyspec\Orm\Orm::class, 'connect'))->isInternal());
        $this->assertPgsqlAdapterCopyAndLargeObjectMethods(true);
    }
}
