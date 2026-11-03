<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\RefusalBeforeRequestTest;

// The refusal of the errors vector before any request through the PHP extension: the extension runs the chains of the
// same test class.
// Requirements: DSL-10, DSL-19, DSL-47, DSL-67, DSL-96, DSL-98, DSL-123, PRT-14.
#[Medium]
final class RefusalBeforeRequestExtensionTest extends RefusalBeforeRequestTest
{
}
