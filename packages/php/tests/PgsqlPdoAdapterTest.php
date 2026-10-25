<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class PgsqlPdoAdapterTest extends TestCase
{
    use PgsqlPdoAdapterCases;

    public function testPgsqlAdapterExecutesBoundValuesAndRollsBackOnSameConnection(): void
    {
        $this->assertPgsqlAdapterExecutesBoundValuesAndRollsBack(false);
    }

    public function testPgsqlAdapterOverridesEveryPublicPdoMethod(): void
    {
        $this->assertPdoPublicSurfaceIsOverridden(false);
    }

    public function testPgsqlAdapterFetchModesAndMetadata(): void
    {
        $this->assertPgsqlAdapterFetchModesAndMetadata(false);
    }

    public function testPgsqlAdapterLastInsertIdTracksSequence(): void
    {
        $this->assertPgsqlAdapterLastInsertIdTracksSequence();
    }

    public function testPgsqlAdapterStatementErrorCarriesItsSqlState(): void
    {
        $this->assertPgsqlAdapterStatementErrorCarriesItsSqlState();
    }

    public function testPgsqlAdapterBoundParametersPreserveReferencesAndTypes(): void
    {
        $this->assertPgsqlAdapterBoundParametersPreserveReferencesAndTypes(false);
    }

    public function testPgsqlAdapterPostgresConnectionMethods(): void
    {
        $this->assertPgsqlAdapterPostgresConnectionMethods(false);
    }

    public function testPgsqlAdapterCopiesFilesAndRoundTripsLargeObjects(): void
    {
        $this->assertPgsqlAdapterCopyAndLargeObjectMethods(false);
    }
}
