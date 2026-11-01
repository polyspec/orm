<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Engine;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Validator;
use ReflectionClass;

#[Small]
final class ValidatorNativeTest extends TestCase
{
    /** @return array{RuntimeModel, Validator} */
    private function nativeValidator(): array
    {
        self::assertTrue((new ReflectionClass(Validator::class))->isInternal());

        $root = dirname(__DIR__, 3);
        $model = RuntimeModel::build(RuntimeModel::files(["$root/contracts/fixtures/bench/bench.dbs"]));
        return [$model, new Validator($model)];
    }

    // Requirements: PRT-1.
    public function testRequestWithAnotherManifestHashIsRejected(): void
    {
        [$model, $validator] = $this->nativeValidator();
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

    // Requirements: DIA-33.
    public function testAllColumnsSelectAesVersionOnce(): void
    {
        require_once dirname(__DIR__, 2) . '/php/tests/EngineTest.php';
        self::assertTrue((new ReflectionClass(Engine::class))->isInternal());
        assertAllColumnsSelectAesVersionOnce(dirname(__DIR__, 3));
    }
}
