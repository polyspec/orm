<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Validator;
use ReflectionClass;

#[Small]
final class ValidatorNativeTest extends TestCase
{
    /** @return iterable<string, array{array<string, mixed>}> */
    public static function validateCases(): iterable
    {
        require_once dirname(__DIR__, 2) . '/php/tests/EngineTest.php';
        return EngineTest::validateCases();
    }

    // Requirements: INT-24, PRT-18.
    /** @param array<string, mixed> $case */
    #[DataProvider('validateCases')]
    public function testValidate(array $case): void
    {
        self::assertTrue((new ReflectionClass(Validator::class))->isInternal());

        $root = dirname(__DIR__, 3);
        $model = RuntimeModel::build(RuntimeModel::files(["$root/contracts/fixtures/bench/bench.dbs"]));
        $validator = new Validator($model);
        try {
            $validator->validate($case['request'] + ['manifest_hash' => $model->manifestHash]);
            $got = 'no error';
        } catch (OrmException $error) {
            $got = $error->code_;
        }

        self::assertSame(!empty($case['valid']) ? 'no error' : $case['error'], $got);
    }
}
