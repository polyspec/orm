<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\TransactionsRecipeTest;

// The transactions recipe through the PHP extension (docs/spec/feature-coverage.md FCV-3).
// Requirements: CFG-15, CFG-24, INT-155, DSL-118, DSL-119, DSL-123, DSL-125, DSL-126, INT-40, INT-41, INT-42, INT-43,
// Requirements: INT-45, INT-46, INT-72,, CFG-12, CFG-42 INT-48, INT-49, PLN-13, PLN-16, PLN-17, PLN-20, PLN-21, PLN-24,
// Requirements: PLN-44.
#[Medium]
final class TransactionsRecipeTestExtensionTest extends TransactionsRecipeTest
{
}
