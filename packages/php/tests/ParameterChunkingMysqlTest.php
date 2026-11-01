<?php

// Recipe conversion of the parameter chunking: FCV-3 and FCV-4 (docs/spec/feature-coverage.md), suite unit
// parameter_chunking-mysql.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
class ParameterChunkingMysqlTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/parameter_chunking/parameter_chunking.json';
    }

    #[DataProvider('cases')]
    public function testMysql(array $case): void
    {
        $this->runCase($case, 'mysql');
    }
}
