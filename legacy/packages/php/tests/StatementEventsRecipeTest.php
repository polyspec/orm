<?php

// The statement events recipe, contracts/fixtures/statement_events/statement_events.json, on each database
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: DBS-108, DBS-119, DBS-120, INT-55, INT-77, INT-91, SCH-7, SCH-11, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12,
// Requirements: FCV-13,, INT-149 FCV-14 (docs/spec/feature-coverage.md).
// Requirements: DBS-108, DBS-119, DBS-120, INT-55, INT-77, INT-91, SCH-7, SCH-11, INT-96.

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
