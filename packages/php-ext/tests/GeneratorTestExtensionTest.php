<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\GeneratorTest;

// The generator recipe, contracts/fixtures/generator/generator.json, through the PHP extension
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: DBS-175, DSL-37, DSL-38, DSL-116, DSL-127, DSL-129, DSL-130, DSL-154, DBS-103, DBS-104, DBS-110,
// Requirements: DBS-173, INT-66, PLN-1, PLN-22.
#[Medium]
final class GeneratorTestExtensionTest extends GeneratorTest
{
}
