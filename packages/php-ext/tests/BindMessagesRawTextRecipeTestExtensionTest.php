<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Tests\BindMessagesRawTextRecipeTest;

// The markdown message recipe of a text that is not UTF-8, tests/bind/messages-raw-text.json, through the PHP extension
// (docs/spec/feature-coverage.md FCV-3, FCV-4). Requirements: PRT-67.
#[\PHPUnit\Framework\Attributes\Medium]
final class BindMessagesRawTextRecipeTestExtensionTest extends BindMessagesRawTextRecipeTest
{
}
