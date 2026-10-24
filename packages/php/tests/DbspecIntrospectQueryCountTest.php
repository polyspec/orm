<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;
use Polyspec\Orm\Dbspec\Dbspec;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class DbspecIntrospectQueryCountTest extends TestCase
{
    // Requirements: DIA-198.
    public function testSQLiteMemoryCountIndependentOfTableCount(): void
    {
        DbspecIntrospectQueryCountCases::assertIndependentOfTableCount(
            static fn(PDO $pdo) => Dbspec::introspect($pdo, 'sqlite', 'introspected')
        );
    }
}
