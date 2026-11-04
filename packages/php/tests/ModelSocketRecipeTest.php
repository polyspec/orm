<?php

// The model socket recipe, contracts/fixtures/model_socket/model_socket.json, on mysql
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: FCV-3, FCV-4, FCV-9, FCV-13, CFG-10, CFG-19.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
class ModelSocketRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/model_socket/model_socket.json';
    }

    #[DataProvider('casesOnMysql')]
    public function testMysql(string $id): void
    {
        $this->runCase($id, 'mysql');
    }
}
