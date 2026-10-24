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
        foreach ([1, 5] as $tableCount) {
            $pdo = new CountingPdo('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            try {
                for ($index = 0; $index < $tableCount; $index++) {
                    $pdo->exec(sprintf('CREATE TABLE "item_%d" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "label" TEXT NULL)', $index));
                }
                $pdo->queries = 0;
                $result = Dbspec::introspect($pdo, 'sqlite', 'introspected');
                self::assertSame([], $result->unsupported);
                self::assertCount($tableCount, $result->document->tables);
                self::assertSame(3, $pdo->queries, "$tableCount tables: catalog query count");
            } finally {
                $pdo = null;
            }
        }
    }
}
