<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use InvalidArgumentException;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Dbspec;

/** Render dialect rejection through the PHP library or its native extension entry point. */
final class DbspecDialectRejectionCases
{
    public static function assertRenderRejectsUnknownDialect(TestCase $test): void
    {
        $parsed = Dbspec::parse("dbspec 1 dialect\n\ntable item {\n  id i64\n  primary key (id)\n}\n", []);
        $test->assertNotNull($parsed->document, json_encode($parsed->diagnostics, JSON_THROW_ON_ERROR));
        $exception = null;
        try {
            Dbspec::render([$parsed->document], 'oracle');
        } catch (InvalidArgumentException $caught) {
            $exception = $caught;
        }
        $test->assertInstanceOf(InvalidArgumentException::class, $exception);
        $test->assertStringContainsString('oracle', $exception->getMessage());
    }
}
