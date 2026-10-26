<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Code;
use Polyspec\Orm\Model;
use Polyspec\Orm\OrmException;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\TestCase;

final class CoverageModelGenerationNativeTest extends TestCase
{
    // Requirements: DBS-104, DBS-111, DBS-112, DBS-120, INT-66.
    // Requirements: DBS-175.
    public function testModelGenerationCheck(): void
    {
        $document = <<<'DBSPEC'
dbspec 1 native_model

table item {
  id i64 identity
  label varchar(32)
  primary key (id)
}
DBSPEC;
        $directory = sys_get_temp_dir() . '/orm-php-ext-model-generation-' . getmypid();
        $namespace = 'Polyspec\\Orm\\Extension\\GeneratedNative';
        if (!mkdir($directory, 0o700, true)) {
            throw new \RuntimeException("cannot create $directory");
        }
        try {
            $set = \Polyspec\Orm\Tests\OrmGenTestSupport::setFile($directory, ['native_model.dbs']);
            file_put_contents("$directory/native_model.dbs", $document);
            $generated = "$directory/generated";
            [$code, $stdout, $stderr] = \Polyspec\Orm\Tests\OrmGenTestSupport::run([
                'gen', '--set', $set, '--out', $generated, '--namespace', $namespace
            ]);
            Assert::assertSame(0, $code, "$stdout $stderr");
            $source = file_get_contents("$generated/Item.php");
            Assert::assertIsString($source);
            Assert::assertStringContainsString("return \$this->readColumn('label');", $source);
            foreach (['@phpstan-ignore', 'phpcs:ignore'] as $suppression) {
                Assert::assertStringNotContainsString($suppression, $source, "generated PHP carries $suppression");
            }
            require "$generated/Item.php";

            $class = "$namespace\\Item";
            Assert::assertSame(
                'sha256:8720acfc93bf4a7c51d823095148191030b07e040e0e0fd44f32c25ee52b3797',
                $class::meta()['manifest_hash']
            );
            $reflection = new \ReflectionClass($class);
            Assert::assertTrue((new \ReflectionClass(Model::class))->isInternal());
            Assert::assertTrue($reflection->getParentClass()->isInternal());
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
            \Polyspec\Orm\Tests\OrmGenTestSupport::removeWorkDirectory($directory);
        }
    }
}
