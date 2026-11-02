<?php

// Requirements: INT-101.
// The one native check of catalog_connection (FCV-2, docs/spec/feature-coverage.md "Catalog connection exclusions"):
// the MySQL server refuses a TIME(7) (DIA-54). The recipe's sql.exec step has no expect that a server refusal can
// meet, so the check stays here. It takes its MySQL database from ORM_TEST_MYSQL_DSN, as the recipe entries do.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class CoverageCatalogConnectionTest extends TestCase
{
    public function testMysqlTemporalPrecisionLimit(): void
    {
        $dsn = (string) getenv('ORM_TEST_MYSQL_DSN');
        if ($dsn === '') {
            self::fail('ORM_TEST_MYSQL_DSN is required; database tests never skip');
        }
        $setup = Orm::connect($dsn, new Config());
        $name = 'catalog_temporal_precision_invalid_' . bin2hex(random_bytes(6));
        try {
            try {
                $setup->pdo()->exec("CREATE TABLE `{$name}` (id BIGINT PRIMARY KEY, t TIME(7))");
                self::fail('MySQL accepted temporal precision 7');
            } catch (\PDOException $error) {
                self::assertStringContainsString('precision', strtolower($error->getMessage()));
            }
        } finally {
            $setup->pdo()->exec("DROP TABLE IF EXISTS `{$name}`");
            $setup->close();
        }
    }
}
