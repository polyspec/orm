<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

// The MySQL introspection of the checks of SHOW CREATE TABLE on the canned catalog of tests/dbspec/show-create.json,
// the recipe tests/dbspec/show-create-introspect.json (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: DIA-84.
#[Small]
class DbspecShowCreateIntrospectTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/dbspec/show-create-introspect.json';
    }

    #[DataProvider('cases')]
    public function testNone(string $id): void
    {
        $this->runCase($id, Recipe::NONE);
    }
}
