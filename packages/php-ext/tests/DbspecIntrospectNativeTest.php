<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;
use PDOStatement;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Dbspec;
use ReflectionMethod;

#[Small]
final class DbspecIntrospectNativeTest extends TestCase
{
    // Requirements: DIA-198.
    public function testSQLiteMemoryCountIndependentOfTableCount(): void
    {
        self::assertTrue(
            (new ReflectionMethod(Dbspec::class, 'introspect'))->isInternal()
        );
        foreach ([1, 5] as $tableCount) {
            $pdo = new class (
                'sqlite::memory:',
                null,
                null,
                [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
            ) extends PDO {
                public int $queries = 0;

                public function query(
                    string $query,
                    ?int $fetchMode = null,
                    mixed ...$fetchModeArgs
                ): PDOStatement|false {
                    $this->queries++;
                    return parent::query($query, $fetchMode, ...$fetchModeArgs);
                }
            };
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
                $result = Dbspec::introspect(
                    $pdo,
                    'sqlite',
                    'introspected'
                );
                self::assertSame([], $result->unsupported);
                self::assertCount($tableCount, $result->document->tables);
                self::assertSame(3, $pdo->queries, "$tableCount tables: native catalog query count");
            } finally {
                $pdo = null;
            }
        }
    }
}
