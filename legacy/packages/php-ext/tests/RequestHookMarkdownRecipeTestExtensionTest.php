<?php

// Recipe conversion of the request hook: FCV-8, FCV-9, FCV-10,
// FCV-11, FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md).
// Requirements: INT-78, PRT-65.

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\RequestHookMarkdownRecipeTest;

// The request hook recipe on flowmark through the PHP extension (docs/spec/feature-coverage.md FCV-3 and FCV-4).
#[Medium]
final class RequestHookMarkdownRecipeTestExtensionTest extends RequestHookMarkdownRecipeTest
{
}
