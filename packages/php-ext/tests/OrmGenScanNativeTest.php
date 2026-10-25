<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// Requirements: DSL-152.

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Model;
use ReflectionClass;

#[Small]
final class OrmGenScanNativeTest extends TestCase
{
    use OrmGenScanFailureCase;

    protected function exerciseGeneratedModelRuntime(string $root, string $work): void
    {
        self::assertTrue(extension_loaded('polyspec_orm'));
        $dir = "$work/native-model";
        $namespace = 'Polyspec\\Orm\\Extension\\Tests\\GeneratedScanFailure';
        $set = OrmGenTestSupport::setFile($dir, ['typed.dbs']);
        file_put_contents(
            "$dir/typed.dbs",
            "dbspec 1 typed\n\ntable item {\n  price i32\n  primary key (price)\n}\n"
        );
        [$code, $stdout, $stderr] = OrmGenTestSupport::run([
            'gen', '--set', $set, '--out', "$dir/model", '--namespace', $namespace
        ]);
        self::assertSame(0, $code, $stdout . $stderr);
        require_once "$dir/model/Item.php";

        $class = "$namespace\\Item";
        $model = new $class();
        self::assertTrue((new ReflectionClass(Model::class))->isInternal());
        self::assertSame(Model::class, (new ReflectionClass($class))->getParentClass()->getName());
        OrmGenTestSupport::assertGeneratedTypedGetter(
            $this,
            $model,
            'getPrice',
            'setPrice',
            Code::COLUMN_UNSELECTED
        );
    }
}
