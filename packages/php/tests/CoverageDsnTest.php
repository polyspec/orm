<?php

declare(strict_types=1);

// dsn feature coverage: an unsupported DSN scheme is refused with the config code, and the DSN of the selected database
// (ORM_FEATURE_DATABASE, ORM_FEATURE_DSN) connects to that database.


use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;

#[Medium]
final class CoverageDsnTest extends TestCase
{
    // Requirements: CFG-1.
    public function testDsnConnection(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [$driver, $dsn] = coverageItem();
            $this->assertSame(
                Code::CONFIG,
                coverageCode(static fn() => Orm::parseDsn('invalid://database')),
                'unsupported DSN scheme'
            );
            $db = Orm::connect($dsn, new Config());
            try {
                $this->assertSame($driver, $db->driver(), 'DSN selected the wrong database');
                $this->assertSame(
                    1,
                    (int) $db->pdo()->query('SELECT 1')->fetchColumn(),
                    'DSN selected the wrong connection'
                );
            } finally {
                $db->close();
            }
        }
    }
}
