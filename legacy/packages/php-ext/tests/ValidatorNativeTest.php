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

        $root = ormLegacyRoot();
        $model = RuntimeModel::build(RuntimeModel::files(["$root/contracts/fixtures/bench/bench.dbs"]));
        return [$model, new Validator($model)];
    }

    // T334-3-4-7: the constructor of a Validator releases what it looks up, so 1000 Validators keep no memory (before
    // the fix, each one left a 56-byte string: 56 KB in all).
    public function testConstructingValidatorsReleasesWhatItLooksUp(): void
    {
        [$model] = $this->nativeValidator();
        new Validator($model);
        $before = memory_get_usage();
        for ($i = 0; $i < 1000; $i++) {
            $validator = new Validator($model);
            unset($validator);
        }
        self::assertLessThan(16 * 1024, memory_get_usage() - $before, 'constructing Validators grows memory');
    }
}
