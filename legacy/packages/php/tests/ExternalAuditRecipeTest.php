<?php

// The external_audit recipe, contracts/fixtures/external_audit/external_audit.json, on each database
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: SCH-14, DBS-110.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;

#[Medium]
class ExternalAuditRecipeTest extends DatabaseRecipeTestCase
{
    protected static function recipe(): string
    {
        return 'contracts/fixtures/external_audit/external_audit.json';
    }
}
