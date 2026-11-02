<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\GeneratorScanTest;

// The generator scan recipe, contracts/fixtures/generator_scan/generator_scan.json, through the PHP extension (docs/spec/feature-coverage.md FCV-3).
// Requirements: DSL-44, DSL-151, DSL-152.
#[Medium]
final class GeneratorScanTestExtensionTest extends GeneratorScanTest
{
}
