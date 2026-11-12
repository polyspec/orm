<?php

// The drop of a case database on MySQL (docs/spec/dialects.md DIA-212, DIA-200): the next session of
// the admin connection has foreign_key_checks 1 (case_database_next_admin_checks of case_database.php).
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
class CaseDatabaseMysqlTest extends TestCase
{
    public function testMysqlDropLeavesTheNextAdminSessionWithForeignKeyChecks(): void
    {
        self::assertSame(1, case_database_next_admin_checks('mysql', static function (): void {
        }));
    }
}
