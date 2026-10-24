<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;
use PHPUnit\Framework\Assert;
use Polyspec\Orm\Dbspec\IntrospectResult;

/** The SQLite-memory query-count case shared by the PHP library and extension entry points. */
final class DbspecIntrospectQueryCountCases
{
    /** @param callable(PDO): IntrospectResult $introspect */
    public static function assertIndependentOfTableCount(callable $introspect): void
    {
        foreach ([1, 5] as $tableCount) {
            $pdo = new CountingPdo('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            try {
                for ($index = 0; $index < $tableCount; $index++) {
                    $pdo->exec(
                        sprintf(
                            'CREATE TABLE "item_%d" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, '
                                . '"label" TEXT NULL)',
                            $index
                        )
                    );
                }
                $pdo->queries = 0;
                $result = $introspect($pdo);
                Assert::assertSame([], $result->unsupported);
                Assert::assertCount($tableCount, $result->document->tables);
                Assert::assertSame(3, $pdo->queries, "$tableCount tables: catalog query count");
            } finally {
                $pdo = null;
            }
        }
    }
}
