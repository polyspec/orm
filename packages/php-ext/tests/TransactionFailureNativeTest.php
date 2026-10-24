<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Db;
use Polyspec\Orm\Tests\TransactionFailureCases;
use ReflectionClass;

final class TransactionFailureNativeTest extends TestCase
{
    use TransactionFailureCases;

    protected function setUp(): void
    {
        self::assertTrue((new ReflectionClass(Db::class))->isInternal());
    }
}
