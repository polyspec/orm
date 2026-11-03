<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\GeneratorTest;

// The generator recipe, contracts/fixtures/generator/generator.json, through the PHP extension
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: DSL-37, DSL-116, DSL-127, DSL-129, DSL-130, PLN-22.
#[Medium]
final class GeneratorTestExtensionTest extends GeneratorTest
{
}
