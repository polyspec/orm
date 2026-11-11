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

        foreach (['3.45.999', '2.999.999', '003.045.999.0'] as $version) {
            try {
                $method->invoke(null, $version);
                self::fail("SQLite $version must be refused as older");
            } catch (OrmException $error) {
                self::assertSame(Code::CAPABILITY_UNSUPPORTED, $error->code_, $version);
            }
        }
        $malformed = ['', '3.46', '3.46.0.0.0', '3..0', '.46.0', ' 3.46.0', '3.46.0 ', "3.46.0\n", "3.46.0\r",
            "3.46.0\u{2028}", "3.46.0\u{2029}", '+3.46.0', '3.46.0-rc1', '3.4294967296.0', '3.46.0.4294967296',
            '3.46.0.', "\u{0663}.46.0", "3.46.0\0", '3.46.0.0.'];
        foreach ($malformed as $version) {
            try {
                $method->invoke(null, $version);
                self::fail('SQLite ' . json_encode($version) . ' must be refused as malformed');
            } catch (OrmException $error) {
                self::assertSame(Code::INTERNAL, $error->code_, json_encode($version));
            }
        }
        try {
            $method->invoke(null, "3.46.0\n");
            self::fail('a malformed SQLite version must be refused');
        } catch (OrmException $error) {
            self::assertSame(
                'INTERNAL: SQLite library version "3.46.0\n" is invalid; '
                    . 'expected three or four decimal components that each fit u32',
                $error->getMessage()
            );
        }

        foreach (['3.46.0', '3.100.0', '4.0.0', '3.046.000.0', '4294967295.0.0'] as $version) {
            $method->invoke(null, $version);
        }
    }
}
