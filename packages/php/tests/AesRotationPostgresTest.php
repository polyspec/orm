<?php

// Requirements: COD-7, COD-8, PLN-44, INT-60, INT-75, INT-131.
// Recipe conversion of the AES rotation: FCV-3 and FCV-4 (docs/spec/feature-coverage.md), suite unit
// aes_rotation-postgres.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
class AesRotationPostgresTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/aes_rotation/aes_rotation.json';
    }

    #[DataProvider('casesOnPostgres')]
    public function testPostgres(string $id): void
    {
        $this->runCase($id, 'postgres');
    }
}
