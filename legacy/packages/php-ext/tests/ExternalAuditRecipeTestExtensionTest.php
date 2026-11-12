<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\ExternalAuditRecipeTest;

// The external_audit recipe through the PHP extension (docs/spec/feature-coverage.md FCV-3).
// Requirements: SCH-14, DBS-110.
#[Medium]
final class ExternalAuditRecipeTestExtensionTest extends ExternalAuditRecipeTest
{
}
