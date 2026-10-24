<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Model;
use ReflectionMethod;

require_once dirname(__DIR__, 2) . '/php/tests/CoverageConstraintsAndRelationsTest.php';

#[Medium]
final class CoverageConstraintsAndRelationsExtensionTest extends CoverageConstraintsAndRelationsTest
{
    public function test_native_methods_are_internal(): void
    {
        foreach (['get', 'update', 'delete'] as $method) {
            Assert::assertTrue(
                (new ReflectionMethod(Model::class, $method))->isInternal(),
                "Model::$method must run through the native extension"
            );
        }
    }
}
