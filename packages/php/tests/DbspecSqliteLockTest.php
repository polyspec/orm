<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\TestCase;

final class DbspecSqliteLockTest extends TestCase
{
    // Requirements: PLN-89, PLN-90.
    public function testOnlySqliteBusyAndLockedErrorInfoCodesAreClassifiedAsLocks(): void
    {
        DbspecSqliteLockCases::assertLockCodes($this);
    }

    // Requirements: PLN-89, PLN-90.
    public function testNonLockAndMissingPdoCodesPreserveTheOriginalException(): void
    {
        DbspecSqliteLockCases::assertNonLockCauses($this);
    }
}
