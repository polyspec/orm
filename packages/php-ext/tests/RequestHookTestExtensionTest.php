<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Db;
use Polyspec\Orm\Model;
use Polyspec\Orm\Tests\RequestHookTest;
use ReflectionClass;
use ReflectionMethod;

// The native cases of the request hook in the PHP extension, and that its entry points are native.
// Requirements: INT-78.
#[Medium]
final class RequestHookTestExtensionTest extends RequestHookTest
{
    public function testNativeMethodsAreInternal(): void
    {
        Assert::assertTrue((new ReflectionMethod(Db::class, 'withRequestHook'))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'get'))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'matchValues'))->isInternal());
        Assert::assertTrue((new ReflectionClass(Model::class))->isInternal());
    }
}
