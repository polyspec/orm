<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use Polyspec\Orm\Db;
use Polyspec\Orm\Engine;
use Polyspec\Orm\Model;
use Polyspec\Orm\RuntimeModel;
use ReflectionClass;
use ReflectionMethod;

trait NativeMethodAssertions
{
    protected function assertAuditMethodsAreInternal(): void
    {
        Assert::assertTrue((new ReflectionMethod(Db::class, 'transaction'))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'get'))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'update'))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'delete'))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'restore'))->isInternal());
    }

    /** The classes that run the decimal model are the native extension classes. */
    protected static function assertNativeDecimalClasses(): void
    {
        foreach ([Db::class, Engine::class, Model::class, RuntimeModel::class] as $class) {
            Assert::assertTrue((new ReflectionClass($class))->isInternal(), "$class is the native extension class");
        }
    }
}
