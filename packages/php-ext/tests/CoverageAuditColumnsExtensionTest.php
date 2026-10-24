<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Db;
use Polyspec\Orm\Model;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use ReflectionMethod;

require_once dirname(__DIR__, 2) . '/php/tests/CoverageAuditColumnsTest.php';

#[Medium]
final class CoverageAuditColumnsExtensionTest extends CoverageAuditColumnsTest
{
    protected static function coverageTestFile(): string
    {
        return __FILE__;
    }

    public function test_native_methods_are_internal(): void
    {
        Assert::assertTrue((new ReflectionMethod(Db::class, 'transaction'))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'get'))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'update'))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'delete'))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'restore'))->isInternal());
    }
}
