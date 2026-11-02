<?php

// Recipe conversion of the parameter chunking: FCV-3 and FCV-4 (docs/spec/feature-coverage.md), suite unit
// parameter_chunking-mysql.

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\ParameterChunkingMysqlTest;

// The parameter chunking recipe on mysql through the PHP extension (docs/spec/feature-coverage.md FCV-3 and FCV-4).
#[Medium]
final class ParameterChunkingMysqlRecipeExtensionTest extends ParameterChunkingMysqlTest
{
}
