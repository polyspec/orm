<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Planner;
use Polyspec\Orm\Tests\ColumnFunctionMetadataAssertions;
use Polyspec\Orm\Validator;

#[Small]
final class ColumnFunctionMetadataTest extends TestCase
{
    public static function setUpBeforeClass(): void
    {
        parent::setUpBeforeClass();
        require_once dirname(__DIR__, 2) . '/php/tests/ColumnFunctionMetadataAssertions.php';
    }

    private static function assertNativePlannerAndValidator(): void
    {
        foreach ([Validator::class, Planner::class] as $class) {
            $reflection = new \ReflectionClass($class);
            self::assertTrue($reflection->isInternal(), "$class is implemented by the extension");
            self::assertSame('polyspec_orm', $reflection->getExtensionName(), "$class comes from polyspec_orm");
        }
    }

    public function testColumnFunctionPlannerMissingPostValidationFieldIsInternal(): void
    {
        self::assertNativePlannerAndValidator();
        ColumnFunctionMetadataAssertions::assertPlannerMissingPostValidationFieldIsInternal();
    }

    public function testColumnFunctionParamUsesMissingPostValidationFieldIsInternal(): void
    {
        self::assertNativePlannerAndValidator();
        ColumnFunctionMetadataAssertions::assertParamUsesMissingPostValidationFieldIsInternal();
    }

    public function testColumnFunctionOutputMissingPostValidationFieldIsInternal(): void
    {
        self::assertNativePlannerAndValidator();
        ColumnFunctionMetadataAssertions::assertOutputMissingPostValidationFieldIsInternal();
    }
}
