<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// The SQLite minimum version check (DSL-150) stays native in every runtime (docs/spec/feature-coverage.md FCV-2): each
// runtime reads the version from its own driver, and the comparison has no public call that a recipe op could name. A
// refused scheme and the DSN of each database are the cases of contracts/fixtures/dsn_connection/dsn_connection.json
// and contracts/fixtures/dsn_reject/dsn_reject.json.

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use ReflectionMethod;

#[Medium]
class CoverageDsnTest extends TestCase
{
    // Requirements: DSL-150.
    public function testSqliteMinimumVersionValidation(): void
    {
        $method = new ReflectionMethod(Orm::class, 'assertSqliteVersion');
        try {
            $method->invoke(null, '3.9.0');
            self::fail('SQLite 3.9.0 must be refused');
        } catch (OrmException $error) {
            self::assertSame(Code::CAPABILITY_UNSUPPORTED, $error->code_);
            self::assertSame('CAPABILITY_UNSUPPORTED: SQLite 3.9.0 is older than 3.46', $error->getMessage());
        }

        $method->invoke(null, '3.46.0');
        $method->invoke(null, '3.100.0');
    }
}
