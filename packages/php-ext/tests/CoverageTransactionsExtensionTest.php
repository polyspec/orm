<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Db;
use ReflectionMethod;

require_once dirname(__DIR__, 2) . '/php/tests/CoverageTransactionsTest.php';

#[Medium]
final class CoverageTransactionsExtensionTest extends CoverageTransactionsTest
{
    public function test_native_methods_are_internal(): void
    {
        Assert::assertTrue((new ReflectionMethod(Db::class, 'transaction'))->isInternal());
    }
}
