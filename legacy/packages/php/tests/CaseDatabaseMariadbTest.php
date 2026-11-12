<?php

// The drop of a case database on MariaDB, a server of the MySQL dialect (docs/spec/dialects.md DIA-212, DIA-200): the
// next session of the admin connection has foreign_key_checks 1 (case_database_next_admin_checks of case_database.php).
// The entry of MariaDB is a class of its own, so the targets of the MySQL servers do not run it and make
// mariadb-recipes-check/php runs it.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
class CaseDatabaseMariadbTest extends TestCase
{
    public function testMariadbDropLeavesTheNextAdminSessionWithForeignKeyChecks(): void
    {
        self::assertSame(1, case_database_next_admin_checks('mariadb', static function (): void {
        }));
    }
}
