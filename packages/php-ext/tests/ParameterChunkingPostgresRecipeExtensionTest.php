<?php

// Recipe conversion of the parameter chunking: FCV-3 and FCV-4 (docs/spec/feature-coverage.md), suite unit
// parameter_chunking-postgres.

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\ParameterChunkingPostgresTest;

// The parameter chunking recipe on postgres through the PHP extension (docs/spec/feature-coverage.md FCV-3 and FCV-4).
#[Medium]
final class ParameterChunkingPostgresRecipeExtensionTest extends ParameterChunkingPostgresTest
{
}
