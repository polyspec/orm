<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\AuditTriggersRecipeTest;

// The audit_triggers recipe through the PHP extension (docs/spec/feature-coverage.md FCV-3).
// Requirements: CFG-8, DBS-67, DBS-85, DBS-87, DBS-88, DBS-89, DBS-93, DBS-94, DBS-96, DBS-117, DIA-161, DSL-118, DSL-119,
// DSL-126, INT-38, INT-44.
#[Medium]
final class AuditTriggersRecipeTestExtensionTest extends AuditTriggersRecipeTest
{
}
