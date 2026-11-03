<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Tests\DbspecApplyVerificationErrorsRecipeTest;

// The apply verification errors of tests/dbspec/apply-verification-errors.json on a memory connection, through the PHP extension (docs/spec/feature-coverage.md FCV-3).
// Requirements: PLN-92, PLN-93, PLN-96, PLN-106.
#[\PHPUnit\Framework\Attributes\Medium]
final class DbspecApplyVerificationErrorsRecipeTestExtensionTest extends DbspecApplyVerificationErrorsRecipeTest
{
}
