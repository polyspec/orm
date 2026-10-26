<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
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

    // Requirements: INT-24, PRT-1, PRT-18, PRT-22.
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

    // Requirements: PRT-1.
    public function testRequestWithAnotherManifestHashIsRejected(): void
    {
        self::assertTrue((new ReflectionClass(Validator::class))->isInternal());

        $root = dirname(__DIR__, 3);
        $model = RuntimeModel::build(RuntimeModel::files(["$root/contracts/fixtures/bench/bench.dbs"]));
        $validator = new Validator($model);
        try {
            $validator->validate([
                'ir_version' => 1,
                'manifest_hash' => 'sha256:' . str_repeat('0', 64),
                'kind' => 'all',
                'entity' => 'author',
                'n_params' => 0,
            ]);
            self::fail('a request with another manifest hash was accepted');
        } catch (OrmException $error) {
            self::assertSame(Code::SCHEMA_HASH_MISMATCH, $error->code_);
        }
    }
}
