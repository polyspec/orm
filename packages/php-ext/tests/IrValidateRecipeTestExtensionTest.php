<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use Polyspec\Orm\Tests\IrValidateRecipeTest;

// The request validation recipe, tests/ir/validate.json, through the PHP extension (docs/spec/protocol.md PRT-22).
// Requirements: INT-24, PRT-4, PRT-6, PRT-8, PRT-10, PRT-12, PRT-14, PRT-16, PRT-17, PRT-18, PRT-20, PRT-21, PRT-22, PRT-24, PRT-78,
// DBS-59, DBS-113, DSL-113, DSL-128.
#[Small]
final class IrValidateRecipeTestExtensionTest extends IrValidateRecipeTest
{
}
