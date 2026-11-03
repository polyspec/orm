<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

// The limit and stress recipe, tests/dbspec/limits.json, without a database
// (docs/spec/feature-coverage.md FCV-3, FCV-4). Requirements: DBS-123, DBS-144, DBS-151, DBS-170.
#[Medium]
class DbspecLimitsRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/dbspec/limits.json';
    }

    #[DataProvider('cases')]
    public function testNone(string $id): void
    {
        // A case holds several copies of a 32 MiB text, its emission and the expected text, and the stress document
        // takes 512M as DbspecStressTest measures, which the default 128M of the CLI cannot hold.
        self::assertNotFalse(ini_set('memory_limit', '512M'));
        $this->runCase($id, Recipe::NONE);
    }
}
