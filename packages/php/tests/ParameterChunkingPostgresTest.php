<?php

// Recipe conversion of the parameter chunking: FCV-3 and FCV-4 (docs/spec/feature-coverage.md), suite unit
// parameter_chunking-postgres.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
class ParameterChunkingPostgresTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/parameter_chunking/parameter_chunking.json';
    }

    #[DataProvider('cases')]
    public function testPostgres(array $case): void
    {
        $this->runCase($case, 'postgres');
    }
}
