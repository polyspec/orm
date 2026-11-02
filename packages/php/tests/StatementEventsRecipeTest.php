<?php

// The statement events recipe, contracts/fixtures/statement_events/statement_events.json, on each database
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: INT-55, INT-77, INT-91, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13,
// FCV-14 (docs/spec/feature-coverage.md).
// Requirements: INT-55, INT-77, INT-91, INT-96.

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;

#[Medium]
class StatementEventsRecipeTest extends DatabaseRecipeTestCase
{
    protected static function recipe(): string
    {
        return 'contracts/fixtures/statement_events/statement_events.json';
    }
}
