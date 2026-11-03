<?php

// The public interface recipe, contracts/fixtures/public_interface/public_interface.json, without a database
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: INT-74, INT-88, INT-89, INT-130.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
class PublicInterfaceRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/public_interface/public_interface.json';
    }

    #[DataProvider('cases')]
    public function testNone(string $id): void
    {
        $this->runCase($id, Recipe::NONE);
    }
}
