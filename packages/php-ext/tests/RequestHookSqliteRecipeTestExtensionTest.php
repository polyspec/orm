<?php

// Recipe conversion of the request hook: FCV-8, FCV-9, FCV-10,
// FCV-11, FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md).

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\RequestHookSqliteRecipeTest;

// The request hook recipe on sqlite through the PHP extension (docs/spec/feature-coverage.md FCV-3 and FCV-4).
// Requirements: INT-78, PRT-2, PRT-4, PRT-5, PRT-6, PRT-41, CFG-21, INT-36, INT-37, PLN-16, DIA-161, INT-38.
#[Medium]
final class RequestHookSqliteRecipeTestExtensionTest extends RequestHookSqliteRecipeTest
{
}
