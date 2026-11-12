<?php

// The recipe contracts/fixtures/conformance_verification/conformance_verification.json on MariaDB, a server of the
// MySQL dialect (docs/spec/dialects.md DIA-200), as ConformanceVerificationMysqlRecipeTest runs it on MySQL
// (docs/spec/feature-coverage.md FCV-3). The entry of MariaDB is a class of its own, so the targets of the MySQL
// servers do not run it and the targets of the MariaDB servers run only it.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
class ConformanceVerificationMariadbRecipeTest extends TestCase
{
    use RecipeCases;

    // The recipe peaks at 152.5 MB in this run: 106.5 MB of recipe and harness, and the 21846 models of
    // creates_batch_too_large, above the 128M default of PHP.
    public static function setUpBeforeClass(): void
    {
        self::requireMemoryLimit('256M');
    }

    protected static function recipe(): string
    {
        return 'contracts/fixtures/conformance_verification/conformance_verification.json';
    }

    #[DataProvider('casesOnMariadb')]
    public function testMariadb(string $id): void
    {
        $this->runCase($id, 'mariadb');
    }
}
