<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Tests\PgsqlPdoAdapterCases;
use ReflectionMethod;

#[Medium]
final class PgsqlPdoAdapterNativeTest extends TestCase
{
    use PgsqlPdoAdapterCases;

    public function testNativePgsqlAdapterExecutesAndRollsBackOnSameConnection(): void
    {
        self::assertTrue((new ReflectionMethod(\Polyspec\Orm\Orm::class, 'connect'))->isInternal());
        $this->assertPgsqlAdapterExecutesBoundValuesAndRollsBack(true);
    }

    public function testNativePgsqlAdapterPublicSurfaceIsInternalAndInitialized(): void
    {
        self::assertTrue((new ReflectionMethod(\Polyspec\Orm\Orm::class, 'connect'))->isInternal());
        $this->assertPdoPublicSurfaceIsOverridden(true);
    }

    public function testNativePgsqlAdapterFetchModesAndMetadata(): void
    {
        self::assertTrue((new ReflectionMethod(\Polyspec\Orm\Orm::class, 'connect'))->isInternal());
        $this->assertPgsqlAdapterFetchModesAndMetadata(true);
    }

    public function testNativePgsqlAdapterSettingsMatchPdoMetadata(): void
    {
        $adapterClass = new \ReflectionClass(\Polyspec\Orm\Internal\PgsqlPdoAdapter::class);
        foreach (
            [
                'caseMode' => 'int',
                'defaultFetchMode' => 'array',
                'errorMode' => 'int',
                'nullMode' => 'int',
            ] as $method => $returnType
        ) {
            $reflection = $adapterClass->getMethod($method);
            self::assertTrue($reflection->isPublic());
            self::assertTrue($reflection->isInternal());
            self::assertSame($returnType, (string) $reflection->getReturnType());
        }
        foreach (['caseMode', 'defaultFetchMode', 'errmode', 'nullMode'] as $property) {
            self::assertTrue($adapterClass->getProperty($property)->isPrivate(), $property);
        }
        self::assertNull($adapterClass->getMethod('lobOpen')->getReturnType());
        self::assertTrue(
            (new \ReflectionProperty(\Polyspec\Orm\DbState::class, 'sqliteCancellationLoaded'))->isPrivate()
        );

        self::onPostgresDb(static function (\Polyspec\Orm\Db $db): void {
            $pdo = $db->pdo();
            self::assertSame(\PDO::CASE_NATURAL, $pdo->getAttribute(\PDO::ATTR_CASE));
            self::assertSame(\PDO::NULL_NATURAL, $pdo->getAttribute(\PDO::ATTR_ORACLE_NULLS));
            self::assertSame(\PDO::FETCH_BOTH, $pdo->getAttribute(\PDO::ATTR_DEFAULT_FETCH_MODE));
            self::assertSame([\PDO::FETCH_BOTH], $pdo->defaultFetchMode());

            self::assertTrue($pdo->setAttribute(\PDO::ATTR_CASE, \PDO::CASE_UPPER));
            self::assertSame(\PDO::CASE_UPPER, $pdo->getAttribute(\PDO::ATTR_CASE));
            self::assertSame(\PDO::CASE_UPPER, $pdo->caseMode());
            self::assertSame(['MIXED' => 3], $pdo->query('SELECT 3 AS mixed')->fetch(\PDO::FETCH_ASSOC));
            self::assertFalse($pdo->setAttribute(\PDO::ATTR_CASE, 999));
            self::assertSame(\PDO::CASE_UPPER, $pdo->getAttribute(\PDO::ATTR_CASE));

            $warnings = [];
            set_error_handler(static function (int $severity, string $message) use (&$warnings): bool {
                $warnings[] = [$severity, $message];
                return true;
            });
            try {
                foreach ([\PDO::ATTR_ERRMODE, \PDO::ATTR_CASE, \PDO::ATTR_ORACLE_NULLS] as $attribute) {
                    self::assertFalse($pdo->setAttribute($attribute, new \stdClass()));
                }
            } finally {
                restore_error_handler();
            }
            self::assertSame([], $warnings);
            self::assertSame(\PDO::CASE_UPPER, $pdo->getAttribute(\PDO::ATTR_CASE));

            self::assertTrue($pdo->setAttribute(\PDO::ATTR_ORACLE_NULLS, \PDO::NULL_TO_STRING));
            self::assertSame(\PDO::NULL_TO_STRING, $pdo->getAttribute(\PDO::ATTR_ORACLE_NULLS));
            self::assertSame(\PDO::NULL_TO_STRING, $pdo->nullMode());
            self::assertSame('', $pdo->query('SELECT NULL::text')->fetchColumn());

            self::assertTrue($pdo->setAttribute(
                \PDO::ATTR_DEFAULT_FETCH_MODE,
                ['mode' => \PDO::FETCH_NUM, 'argument' => 1],
            ));
            self::assertSame(\PDO::FETCH_NUM, $pdo->getAttribute(\PDO::ATTR_DEFAULT_FETCH_MODE));
            self::assertSame([5], $pdo->query('SELECT 5')->fetch());
            self::assertSame([\PDO::FETCH_NUM, 1], $pdo->defaultFetchMode());

            self::assertFalse($pdo->setAttribute(\PDO::ATTR_ERRMODE, 999));
            self::assertSame(\PDO::ERRMODE_EXCEPTION, $pdo->errorMode());
            self::assertTrue($pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_SILENT));
            self::assertSame(\PDO::ERRMODE_SILENT, $pdo->errorMode());
            self::assertSame(\PDO::ERRMODE_SILENT, $pdo->getAttribute(\PDO::ATTR_ERRMODE));
            self::assertFalse($pdo->getAttribute(-1));
            self::assertFalse($pdo->setAttribute(-1, true));
        });
    }

    public function testNativePgsqlAdapterLastInsertIdTracksSequence(): void
    {
        self::assertTrue((new ReflectionMethod(\Polyspec\Orm\Orm::class, 'connect'))->isInternal());
        $this->assertPgsqlAdapterLastInsertIdTracksSequence();
    }

    public function testNativePgsqlAdapterStatementErrorCarriesItsSqlState(): void
    {
        // Requirements: PRT-79
        self::assertTrue((new ReflectionMethod(\Polyspec\Orm\Orm::class, 'connect'))->isInternal());
        $this->assertPgsqlAdapterStatementErrorCarriesItsSqlState();
    }

    public function testNativePgsqlAdapterReportErrorRespectsPdoErrorMode(): void
    {
        self::onPostgresDb(static function (\Polyspec\Orm\Db $db): void {
            $adapter = $db->pdo();
            self::assertInstanceOf(\Polyspec\Orm\Internal\PgsqlPdoAdapter::class, $adapter);
            $error = new \PDOException('native adapter error');

            $adapter->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_SILENT);
            $adapter->reportError($error);

            $warning = null;
            set_error_handler(static function (int $severity, string $message) use (&$warning): bool {
                $warning = [$severity, $message];
                return true;
            });
            try {
                $adapter->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_WARNING);
                $adapter->reportError($error);
            } finally {
                restore_error_handler();
            }
            self::assertSame([E_USER_WARNING, 'native adapter error'], $warning);

            $adapter->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
            try {
                $adapter->reportError($error);
                self::fail('exception mode did not throw the supplied PDOException');
            } catch (\PDOException $caught) {
                self::assertSame($error, $caught);
            }
        });
    }

    public function testNativePgsqlAdapterBoundParametersPreserveReferencesAndTypes(): void
    {
        self::assertTrue((new ReflectionMethod(\Polyspec\Orm\Orm::class, 'connect'))->isInternal());
        $this->assertPgsqlAdapterBoundParametersPreserveReferencesAndTypes(true);
    }

    public function testNativePgsqlAdapterPostgresConnectionMethods(): void
    {
        self::assertTrue((new ReflectionMethod(\Polyspec\Orm\Orm::class, 'connect'))->isInternal());
        $this->assertPgsqlAdapterPostgresConnectionMethods(true);
    }

    public function testNativePgsqlAdapterCopiesFilesAndRoundTripsLargeObjects(): void
    {
        self::assertTrue((new ReflectionMethod(\Polyspec\Orm\Orm::class, 'connect'))->isInternal());
        $this->assertPgsqlAdapterCopyAndLargeObjectMethods(true);
    }
}
