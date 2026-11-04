<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Tests\DslDynamicRecipeTest;

// The chain values that Go and Rust refuse at compile time, contracts/fixtures/dsl/dsl-dynamic.json, through the PHP extension
// (docs/spec/feature-coverage.md FCV-3, FCV-4). Requirements: DSL-49, DSL-50, DSL-160, PLN-4.
#[\PHPUnit\Framework\Attributes\Medium]
final class DslDynamicRecipeTestExtensionTest extends DslDynamicRecipeTest
{
}
