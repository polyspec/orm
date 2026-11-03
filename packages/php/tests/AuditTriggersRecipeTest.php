<?php

// The audit_triggers recipe, contracts/fixtures/audit_triggers/audit_triggers.json, on each database
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: CFG-8, DBS-67, DBS-85, DBS-87, DBS-88, DBS-89, DBS-93, DBS-94, DBS-96, DBS-117, DIA-161, DSL-118, DSL-119,
// DSL-126, INT-38, INT-44.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;

#[Medium]
class AuditTriggersRecipeTest extends DatabaseRecipeTestCase
{
    protected static function recipe(): string
    {
        return 'contracts/fixtures/audit_triggers/audit_triggers.json';
    }
}
