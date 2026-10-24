<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;
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
        DbspecIntrospectQueryCountCases::assertIndependentOfTableCount(
            static fn(PDO $pdo) => Dbspec::introspect($pdo, 'sqlite', 'introspected')
        );
    }

    public function testPostgresSequenceAndRoutineCatalogNamesAreReported(): void
    {
        $pdo = new class ('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]) extends PDO {
            public function query(
                string $query,
                ?int $fetchMode = null,
                mixed ...$fetchModeArgs
            ): PDOStatement|false {
                $name = null;
                if (str_contains($query, "c.relkind = 'S'")) {
                    $name = 'loose_sequence';
                } elseif (str_contains($query, 'FROM pg_proc p WHERE p.pronamespace')) {
                    $name = 'loose_routine';
                }
                if ($name === null) {
                    return parent::query('SELECT NULL WHERE 0', $fetchMode, ...$fetchModeArgs);
                }
                $statement = parent::prepare('SELECT ?');
                $statement->execute([$name]);
                $statement->setFetchMode(PDO::FETCH_NUM);
                return $statement;
            }
        };
        $result = Dbspec::introspect($pdo, 'postgres', 'introspected');

        self::assertSame([], $result->document->tables);
        self::assertSame([
            ['routine', '', 'loose_routine', 'a function outside the renderer triggers has no dbspec definition'],
            ['sequence', '', 'loose_sequence', 'a sequence outside identity has no dbspec definition'],
        ], array_map(
            static fn($unsupported): array => [
                $unsupported->kind,
                $unsupported->table,
                $unsupported->name,
                $unsupported->reason,
            ],
            $result->unsupported
        ));
    }
}
