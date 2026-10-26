<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Closure;
use Throwable;
use PDO;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Orm;
use Polyspec\Orm\Code;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Model;
use PHPUnit\Framework\Assert;

trait DatabaseTestAssertions
{
    private static function check(bool $ok, string $message): void
    {
        Assert::assertTrue($ok, $message);
    }

    private static function raised(callable $operation): ?Throwable
    {
        try {
            $operation();
        } catch (Throwable $error) {
            return $error;
        }
        return null;
    }

    /** The error must be an OrmException; return it for each case's code and cause assertions. */
    private static function checkedOrmException(?Throwable $error, string $subject): ?OrmException
    {
        self::check(
            $error instanceof OrmException,
            "$subject raises " . ($error === null ? 'nothing' : $error::class . ': ' . $error->getMessage())
        );
        return $error instanceof OrmException ? $error : null;
    }

    /** @return array<string, mixed> */
    protected static function readJsonFixture(string $path, bool $castContentsToString = false): array
    {
        $contents = file_get_contents($path);
        if ($castContentsToString) {
            $contents = (string) $contents;
        }
        return json_decode($contents, true, 512, JSON_THROW_ON_ERROR);
    }

    /** @param array<string, mixed> $fixture @return iterable<string, array{array<string, mixed>}> */
    protected static function fixtureCases(array $fixture): iterable
    {
        foreach ($fixture['cases'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    /** @return array{mysql: non-empty-string, postgres: non-empty-string, sqlite: non-empty-string} */
    protected static function benchDatabaseVariables(): array
    {
        return [
            'mysql' => 'BENCH_MYSQL_DSN',
            'postgres' => 'BENCH_POSTGRES_DSN',
            'sqlite' => 'BENCH_SQLITE_DSN',
        ];
    }

    /** @param Closure(Db): void $case */
    protected function forEachBenchDatabase(Closure $case): void
    {
        foreach (self::benchDatabaseVariables() as $driver => $variable) {
            $db = \Polyspec\Orm\Tests\Model\connect(
                requiredDsn($variable),
                new Config(aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index')
            );
            try {
                Assert::assertSame($driver, $db->driver(), 'DSN selected the wrong database');
                $case($db);
            } finally {
                $db->close();
            }
        }
    }

    protected static function assertColumnUnselected(callable $read, string $column): void
    {
        try {
            $read();
        } catch (OrmException $error) {
            Assert::assertSame(Code::COLUMN_UNSELECTED, $error->code_, "unselected $column: {$error->getMessage()}");
            return;
        }
        Assert::fail("unselected $column returned a value");
    }

    protected function assertTuplePredicatePadsByRepeatingLastRow(Model $model): void
    {
        $request = new \Polyspec\Orm\Request('all', 'sha256:tuple-padding');
        $predicate = (new \ReflectionMethod(Model::class, 'predIr'))->invoke($model, [
            'kind' => 'tuple',
            'column' => '',
            'op' => 'tuple_in',
            'cols' => ['tenant_id', 'account_id'],
            'value' => [[10, 1], [10, 2], [10, 3]],
        ], $request, new \Polyspec\Orm\Frame($model, null));

        Assert::assertSame(range(0, 7), $predicate['ps']);
        Assert::assertSame([10, 1, 10, 2, 10, 3, 10, 3], $request->params);
    }

    protected function assertIpHostStyleValidation(string $rejectedInputMessage): void
    {
        $column = ['codec' => ['ip']];
        Assert::assertSame('10.0.0.1', Model::encodeValue($column, '10.0.0.1'));
        try {
            Model::encodeValue($column, '10. 0.0.1');
            Assert::fail($rejectedInputMessage);
        } catch (OrmException $error) {
            Assert::assertSame(Code::CODEC_ENCODE, $error->code_);
        }
    }

    /** @return array{string, PDO} the parsed driver and a direct test connection */
    private static function nativeConnection(string $dsn): array
    {
        [$driver, $pdoDsn, $user, $password] = Orm::parseDsn($dsn);
        return [$driver, new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION])];
    }
}
