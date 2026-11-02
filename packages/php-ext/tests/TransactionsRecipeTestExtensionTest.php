<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\TransactionsRecipeTest;

// The transactions recipe through the PHP extension (docs/spec/feature-coverage.md FCV-3).
// Requirements: DSL-118, DSL-119, DSL-123, DSL-125, DSL-126, INT-40, INT-41, INT-42, INT-43, INT-45, INT-46, INT-47,
// INT-48, PLN-13, PLN-16, PLN-17, PLN-20, PLN-21, PLN-24, PLN-44.
#[Medium]
final class TransactionsRecipeTestExtensionTest extends TransactionsRecipeTest
{
}
