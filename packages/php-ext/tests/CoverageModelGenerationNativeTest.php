<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Code;
use Polyspec\Orm\Generator;
use Polyspec\Orm\Model;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\TestCase;

final class CoverageModelGenerationNativeTest extends TestCase
{
    // Requirements: DBS-112, INT-66.
    public function testModelGenerationCheck(): void
    {
        $manifest = RuntimeModel::build(RuntimeModel::parse([
            'native_model.dbs' => <<<'DBSPEC'
dbspec 1 native_model

table item {
  id i64 identity
  label varchar(32)
  primary key (id)
}
DBSPEC,
        ]));
        $directory = sys_get_temp_dir() . '/orm-php-ext-model-generation-' . getmypid();
        $namespace = 'Polyspec\\Orm\\Extension\\GeneratedNative';
        if (!mkdir($directory, 0o700, true)) {
            throw new \RuntimeException("cannot create $directory");
        }

        try {
            Generator::generate($manifest, $directory, $namespace);
            $source = file_get_contents("$directory/Item.php");
            Assert::assertIsString($source);
            Assert::assertStringContainsString("return \$this->readColumn('label');", $source);
            foreach (['@phpstan-ignore', 'phpcs:ignore'] as $suppression) {
                Assert::assertStringNotContainsString($suppression, $source, "generated PHP carries $suppression");
            }
            require "$directory/Item.php";

            $class = "$namespace\\Item";
            $reflection = new \ReflectionClass($class);
            Assert::assertTrue((new \ReflectionClass(Model::class))->isInternal());
            Assert::assertTrue($reflection->getParentClass()->isInternal());
            Assert::assertSame($manifest->manifestHash, $class::meta()['manifest_hash']);
            Assert::assertSame('item', $class::meta()['entity']);
            Assert::assertSame('int', $reflection->getMethod('getId')->getReturnType()?->__toString());
            Assert::assertSame('string', $reflection->getMethod('getLabel')->getReturnType()?->__toString());
            Assert::assertSame('static', $reflection->getMethod('setLabel')->getReturnType()?->__toString());
            Assert::assertFalse($reflection->getMethod('getLabel')->isInternal());
            Assert::assertTrue((new \ReflectionMethod(Model::class, 'readColumn'))->isInternal());
            Assert::assertTrue((new \ReflectionMethod(Model::class, 'writeColumn'))->isInternal());

            $model = new $class();
            try {
                $model->getLabel();
                Assert::fail('an unselected generated field was readable');
            } catch (OrmException $error) {
                Assert::assertSame(Code::COLUMN_UNSELECTED, $error->code_);
            }
            Assert::assertSame($model, $model->setLabel('native model storage'));
            Assert::assertSame('native model storage', $model->getLabel());
            Assert::assertSame($model, $model->setId(41));
            Assert::assertSame(41, $model->getId());
        } finally {
            foreach (glob("$directory/*") ?: [] as $file) {
                unlink($file);
            }
            rmdir($directory);
        }
    }
}
