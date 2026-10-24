<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use Polyspec\Orm\Db;
use Polyspec\Orm\Model;
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
}
