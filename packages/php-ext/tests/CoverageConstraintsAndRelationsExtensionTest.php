<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// CFG-33: database constraints map to stable error codes and leave rejected rows unchanged.
// DBS-84: renderer-installed immutable write triggers reject updates without changing stored rows.

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Model;
use ReflectionMethod;

#[Medium]
final class CoverageConstraintsAndRelationsExtensionTest extends CoverageConstraintsAndRelationsTest
{
    public function testNativeMethodsAreInternal(): void
    {
        foreach (['get', 'update', 'delete', 'relation', 'gets'] as $method) {
            Assert::assertTrue(
                (new ReflectionMethod(Model::class, $method))->isInternal(),
                "Model::$method must run through the native extension"
            );
        }
    }
}
