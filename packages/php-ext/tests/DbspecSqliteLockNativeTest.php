<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\PlanApply;
use Polyspec\Orm\Tests\DbspecSqliteLockCases;
use ReflectionMethod;

final class DbspecSqliteLockNativeTest extends TestCase
{
    // Requirements: PLN-89, PLN-90.
    public function testOnlySqliteBusyAndLockedErrorInfoCodesAreClassifiedAsLocks(): void
    {
        self::assertTrue((new ReflectionMethod(PlanApply::class, 'apply'))->isInternal());
        DbspecSqliteLockCases::assertLockCodes($this);
    }

    // Requirements: PLN-89, PLN-90.
    public function testNonLockAndMissingPdoCodesPreserveTheOriginalException(): void
    {
        self::assertTrue((new ReflectionMethod(PlanApply::class, 'apply'))->isInternal());
        DbspecSqliteLockCases::assertNonLockCauses($this);
    }
}
