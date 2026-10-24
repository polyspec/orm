<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use DateTimeImmutable;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Dbspec;
use function Polyspec\Orm\Tests\verify_errors_case;
use function Polyspec\Orm\Tests\verify_errors_plan;

#[Small]
final class DbspecVerifyErrorsTest extends TestCase
{
    public function testNativeVerificationErrorsPreserveCauseAndDistinguishDrift(): void
    {
        self::assertTrue(extension_loaded('polyspec_orm'));
        Assert::assertTrue((new \ReflectionClass(Dbspec::class))->isInternal());
        self::assertFalse(function_exists('mermaid_test_import'), 'release extension omits private Mermaid test hooks');

        verify_errors_case(
            verify_errors_plan(),
            static fn(): DateTimeImmutable => new DateTimeImmutable('2026-10-01T00:00:00.123456789Z')
        );
    }
}
