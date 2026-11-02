<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Tests\BindMessagesUntypedNullRecipeTest;

// The markdown message and control recipe, tests/bind/messages-untyped-null.json, through the PHP extension
// (docs/spec/feature-coverage.md FCV-3, FCV-4). Requirements: PRT-67.
#[\PHPUnit\Framework\Attributes\Medium]
final class BindMessagesUntypedNullRecipeTestExtensionTest extends BindMessagesUntypedNullRecipeTest
{
}
