<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Internal\PgsqlPdoAdapter;
use ReflectionMethod;
use RuntimeException;
use Throwable;

#[Medium]
final class PgsqlPdoAdapterTest extends TestCase
{
    use PgsqlPdoAdapterCases;

    public function testDiagnosticCaptureRestoresTheHandlerAndPropagatesExceptions(): void
    {
        $diagnostic = new ReflectionMethod(PgsqlPdoAdapter::class, 'withPhpDiagnostic');
        $handled = [];
        set_error_handler(static function (int $level, string $message) use (&$handled): bool {
            $handled[] = [$level, $message];
            return true;
        });
        try {
            self::assertSame(
                [null, 'libpq notice'],
                $diagnostic->invoke(null, static function (): null {
                    trigger_error('libpq notice', E_USER_NOTICE);
                    return null;
                }, E_USER_NOTICE)
            );
            self::assertSame([], $handled, 'the requested notice is returned to the caller');

            $cause = new RuntimeException('operation failed');
            try {
                $diagnostic->invoke(null, static function () use ($cause): never {
                    throw $cause;
                }, E_USER_NOTICE);
                self::fail('the operation exception must propagate');
            } catch (RuntimeException $error) {
                self::assertSame($cause, $error);
            }

            trigger_error('outside notice', E_USER_NOTICE);
            self::assertSame([[E_USER_NOTICE, 'outside notice']], $handled);
        } finally {
            restore_error_handler();
        }
    }

    public function testPgsqlAdapterExecutesBoundValuesAndRollsBackOnSameConnection(): void
    {
        $this->assertPgsqlAdapterExecutesBoundValuesAndRollsBack(false);
    }

    public function testPgsqlAdapterOverridesEveryPublicPdoMethod(): void
    {
        $this->assertPdoPublicSurfaceIsOverridden(false);
    }

    public function testPgsqlAdapterFetchModesAndMetadata(): void
    {
        $this->assertPgsqlAdapterFetchModesAndMetadata(false);
    }

    public function testPgsqlAdapterLastInsertIdTracksSequence(): void
    {
        $this->assertPgsqlAdapterLastInsertIdTracksSequence();
    }

    public function testPgsqlAdapterStatementErrorCarriesItsSqlState(): void
    {
        $this->assertPgsqlAdapterStatementErrorCarriesItsSqlState();
    }

    public function testPgsqlAdapterBoundParametersPreserveReferencesAndTypes(): void
    {
        $this->assertPgsqlAdapterBoundParametersPreserveReferencesAndTypes(false);
    }

    public function testPgsqlAdapterPostgresConnectionMethods(): void
    {
        $this->assertPgsqlAdapterPostgresConnectionMethods(false);
    }

    public function testPgsqlAdapterCopiesFilesAndRoundTripsLargeObjects(): void
    {
        $this->assertPgsqlAdapterCopyAndLargeObjectMethods(false);
    }
}
