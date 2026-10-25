<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\Planner;
use Polyspec\Orm\Tests\ColumnFunctionMetadataAssertions;
use Polyspec\Orm\Tests\Model\Author;
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

    public function testOrmFactoriesPreserveColumnFunctionMetadataInGeneratedQueries(): void
    {
        self::assertNativePlannerAndValidator();
        $functions = [
            [Orm::now(), false],
            [Orm::today(), false],
            [Orm::secondsAgo(1), false],
            [Orm::minutesAgo(1), false],
            [Orm::hoursAgo(1), false],
            [Orm::daysAgo(1), false],
            [Orm::monthsAgo(1), false],
            [Orm::secondsLater(1), false],
            [Orm::minutesLater(1), false],
            [Orm::hoursLater(1), false],
            [Orm::daysLater(1), false],
            [Orm::monthsLater(1), false],
            [Orm::dayOfWeek(), true],
            [Orm::year(), true],
            [Orm::month(), true],
            [Orm::date(), true],
        ];
        foreach ($functions as [$function, $column]) {
            self::assertSame($column, $function->column, $function->name);
        }

        $path = tempnam(sys_get_temp_dir(), 'orm-column-function-');
        if ($path === false) {
            throw new \RuntimeException('could not create the SQLite file for column-function planning');
        }
        $db = null;
        try {
            $db = \Polyspec\Orm\Tests\Model\connect('sqlite://' . $path, new Config());
            $query = (new Author())
                ->connect($db)
                ->removeAllColumns()
                ->addColumnStartDtAliasStartYear(Orm::year())
                ->getQuery();
            self::assertStringContainsString('start_year', $query['sql']);
            self::assertSame([], $query['binds']);
        } finally {
            try {
                $db?->close();
            } finally {
                foreach (['', '-journal', '-wal', '-shm'] as $suffix) {
                    $file = $path . $suffix;
                    if (file_exists($file) && !unlink($file)) {
                        throw new \RuntimeException("could not remove the SQLite file for column-function planning: $file");
                    }
                }
            }
        }
    }
}
