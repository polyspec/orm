<?php

// The recipe contracts/fixtures/audit_triggers/audit_triggers.json on MariaDB, a server of the MySQL dialect
// (docs/spec/dialects.md DIA-200), as AuditTriggersRecipeTest runs it on MySQL (docs/spec/feature-coverage.md FCV-3).
// The entry of MariaDB is a class of its own, so the targets of the MySQL servers do not run it and the targets of the
// MariaDB servers run only it.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
class AuditTriggersMariadbRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/audit_triggers/audit_triggers.json';
    }

    #[DataProvider('casesOnMariadb')]
    public function testMariadb(string $id): void
    {
        $this->runCase($id, 'mariadb');
    }
}
