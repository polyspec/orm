<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\Attributes\RunTestsInSeparateProcesses;
use Polyspec\Orm\Db;
use Polyspec\Orm\Model;
use Polyspec\Orm\Tests\RequestHookTest;
use ReflectionClass;
use ReflectionMethod;

// The native cases of the request hook in the PHP extension, and that its entry points are native. The registry holds
// one class per entity of a manifest and the recipe of a process has its own namespace, so each case runs in a process
// of its own.
// Requirements: INT-78.
#[Medium]
#[RunTestsInSeparateProcesses]
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
