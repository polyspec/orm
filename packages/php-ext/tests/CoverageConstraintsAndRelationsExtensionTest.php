<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Model;
use ReflectionMethod;

#[Medium]
final class CoverageConstraintsAndRelationsExtensionTest extends CoverageConstraintsAndRelationsTest
{
    public function testNativeMethodsAreInternal(): void
    {
        foreach (['get', 'update', 'delete'] as $method) {
            Assert::assertTrue(
                (new ReflectionMethod(Model::class, $method))->isInternal(),
                "Model::$method must run through the native extension"
            );
        }
    }
}
