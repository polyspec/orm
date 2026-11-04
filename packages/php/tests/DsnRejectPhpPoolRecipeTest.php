<?php

// The recipe contracts/fixtures/dsn_reject/dsn_reject_php_pool.json without a database (docs/spec/feature-coverage.md FCV-3).
// PHP keeps no pool, so a pool option that the other runtimes take is refused here; it also means the client owns no idle
// connection for a server to end.
// Requirements: CFG-4, CFG-5, CFG-5b, INT-92.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
class DsnRejectPhpPoolRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/dsn_reject/dsn_reject_php_pool.json';
    }

    #[DataProvider('cases')]
    public function testNone(string $id): void
    {
        $this->runCase($id, Recipe::NONE);
    }
}
