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
