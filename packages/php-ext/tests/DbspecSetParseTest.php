<?php

declare(strict_types=1);

// The extension's set parse (Polyspec\Orm\Dbspec\Native\Dbspec::parseSet) against the shared vectors
// tests/dbspec/set-parse.json. The PHP client is the specification, so on every case the native result equals the
// PHP client's: the same names, external marks, documents, positions and diagnostics, and the same set diagnostics.

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Native\Dbspec as NativeDbspec;

require_once dirname(__DIR__, 2) . '/php/tests/dbspec_set_parse_cases.php';

#[Small]
final class DbspecSetParseTest extends TestCase
{
    public static function setParseCases(): iterable
    {
        return dbspec_set_parse_sets(dirname(__DIR__, 3));
    }

    #[DataProvider('setParseCases')]
    public function test_set_parse(array $case): void
    {
        dbspec_set_parse_check($case, static fn(array $owned, array $external): array => NativeDbspec::parseSet($owned, $external), function (array $native, array $case): void {
            $want = dbspec_set_parse_described(Dbspec::parseSet($case['owned'], $case['external']));
            $this->assertSame($want, dbspec_set_parse_described($native), 'the extension differs from the PHP client');
        });
    }
}
