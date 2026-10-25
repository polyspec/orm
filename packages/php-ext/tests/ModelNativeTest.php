<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Model;
use Polyspec\Orm\Frame;
use Polyspec\Orm\Request;
use Polyspec\Orm\OrmException;
use ReflectionClass;
use WeakReference;

final class ModelNativeTest extends TestCase
{
    public function testPhpGeneratedTypedGetterUsesInternalModelStorage(): void
    {
        $dir = sys_get_temp_dir() . '/orm-php-ext-generated-getter-' . getmypid();
        is_dir($dir) || mkdir($dir, 0o700, true);
        $namespace = 'Polyspec\\Orm\\Extension\\Tests\\GeneratedTypedGetter';
        try {
            $set = "$dir/dbspec-set.json";
            file_put_contents($set, json_encode(['schema' => 1, 'documents' => ['typed.dbs'], 'external' => []]));
            file_put_contents(
                "$dir/typed.dbs",
                "dbspec 1 typed\n\ntable item {\n  price i32\n  primary key (price)\n}\n"
            );
            $stderr = fopen('php://memory', 'w+');
            ob_start();
            $code = \Polyspec\Orm\OrmGen::run([
                'gen', '--set', $set, '--out', "$dir/model", '--namespace', $namespace
            ], $stderr);
            $output = (string) ob_get_clean();
            rewind($stderr);
            $message = (string) stream_get_contents($stderr);
            fclose($stderr);
            self::assertSame(0, $code, "$output $message");
            require_once "$dir/model/Item.php";

            $class = "$namespace\\Item";
            $model = new $class();
            $getter = new \ReflectionMethod($class, 'getPrice');
            self::assertSame('int', $getter->getReturnType()->getName());
            self::assertFalse($getter->isInternal());
            self::assertTrue((new \ReflectionMethod(Model::class, 'readColumn'))->isInternal());
            self::assertTrue((new \ReflectionMethod(Model::class, 'writeColumn'))->isInternal());
            self::assertTrue((new \ReflectionProperty(Model::class, 'values'))->isPrivate());
            $source = (string) file_get_contents("$dir/model/Item.php");
            self::assertStringContainsString("return \$this->readColumn('price');", $source);
            self::assertStringContainsString("return \$this->writeColumn('price', \$v);", $source);

            OrmGenTestSupport::assertGeneratedTypedGetter(
                $this,
                $model,
                'getPrice',
                'setPrice',
                'COLUMN_UNSELECTED'
            );
        } finally {
            exec('rm -rf ' . escapeshellarg($dir));
        }
    }

    public function testOrmGeneratorSubclassKeepsItsPhpMetaImplementation(): void
    {
        require_once dirname(__DIR__, 2) . '/php/gen/bootstrap.php';

        $generated = new \Polyspec\Orm\Tests\Model\Account();
        $generatedReflection = new ReflectionClass($generated);
        $meta = $generated::meta();

        self::assertSame('account', $meta['entity']);
        self::assertTrue($generatedReflection->getParentClass()->isInternal());
        self::assertFalse($generatedReflection->getMethod('meta')->isInternal());
        self::assertTrue((new ReflectionClass(Model::class))->getMethod('connect')->isInternal());
    }

    public function testSubclassInheritsExtensionOwnedModel(): void
    {
        $model = new NativeModelFixture();
        $reflection = new ReflectionClass(Model::class);

        self::assertTrue($reflection->isInternal());
        self::assertSame('polyspec_orm', $reflection->getExtensionName());
        self::assertTrue($reflection->isAbstract());
        self::assertTrue($reflection->getReflectionConstant('JSON_FLAGS')->getDeclaringClass()->isInternal());
        self::assertNull($model->connection());
        self::assertTrue((new ReflectionClass($model))->getParentClass()->isInternal());
        foreach (
            [
            'connect',
            '__invoke',
            'and',
            'or',
            'not',
            'andNot',
            'orNot',
            'on',
            'relation',
            'relations',
            'limit',
            'orderByRandom',
            'removeAllColumns',
            'addAllColumns',
            'parentNode',
            'groupLimit',
            'expectRevision',
            'deleteLock',
            'fetchKey',
            'fetchValue',
            'forUpdate',
            'forShare',
            'forUpdateNoWait',
            'forShareNoWait',
            'duplication',
            '__call',
            'registerJoins',
            'get',
            'gets',
            'getsCount',
            'getCount',
            'getSum',
            'getAvg',
            'getsPage',
            'getQuery',
            'encodeValue',
            'create',
            'creates',
            'update',
            'save',
            'delete',
            'deleteRow',
            'restore',
            'restoreOrCreate',
            'connection',
            'meta',
            'toArray',
            'toJson',
            'jsonText',
            'jsonSerialize',
            '__clone',
            'readColumn',
            'writeColumn',
            ] as $name
        ) {
            self::assertTrue($reflection->hasMethod($name), "Missing Model::$name");
            self::assertTrue($reflection->getMethod($name)->isInternal(), "Model::$name is not native");
            self::assertSame('polyspec_orm', $reflection->getMethod($name)->getExtensionName());
        }
        foreach (
            [
            'fail',
            'subject',
            'addItem',
            'negated',
            'connector',
            'addRelation',
            'prefixed',
            'arity',
            'outputName',
            'addColumnCall',
            'addJoin',
            'named',
            'whereChain',
            'predicate',
            'by',
            'revisionGuard',
            'value',
            'resolved',
            'putSet',
            'columnValue',
            'timeValue',
            'executor',
            'build',
            'resultName',
            'query',
            'relationIr',
            'columnsIr',
            'subqueryIr',
            'groupIr',
            'predIr',
            'newRow',
            'rowShape',
            'assembleRow',
            'joinChild',
            'relationChild',
            'collectionKey',
            'assemble',
            'matchValues',
            'matchKey',
            'attachExternal',
            'columnOrExtra',
            'load',
            'groupValue',
            'groupInteger',
            'groupFloat',
            'aggregate',
            'aggregateNumber',
            'manifestHash',
            'writeRequest',
            'assignIr',
            'keyValues',
            'keyWhere',
            'withAesColumns',
            'restoreStep',
            'restoreKeyValue',
            'pairs',
            'columnArrayValue',
            'sixFractionDigits',
            'arrayValue',
            'holdsOrderedJson',
            ] as $name
        ) {
            self::assertTrue($reflection->hasMethod($name), "Missing native Model helper $name");
            self::assertTrue($reflection->getMethod($name)->isInternal(), "Model::$name is not native");
        }

        self::assertSame($model, $model->limit(0, 4)->addAllColumns()->forUpdate());
    }

    public function testWeakScalarNullArgumentsKeepUserlandTypeErrors(): void
    {
        $model = new NativeModelFixture();
        $calls = [
            static fn() => modelWeakLimit($model, null, 2),
            static fn() => modelWeakLimit($model, 0, null),
            static fn() => modelWeakGroupLimit($model, null),
            static fn() => modelWeakExpectRevision($model, null, 1),
            static fn() => modelWeakExpectRevision($model, 'revision', null),
            static fn() => modelWeakGetsPage($model, null, 1),
            static fn() => modelWeakGetsPage($model, 1, null),
            static fn() => modelWeakCreates($model, [], null),
            static fn() => modelWeakUpdate($model, null),
            static fn() => modelWeakDelete($model, null),
            static fn() => modelWeakDeleteRow($model, null),
            static fn() => modelWeakCall($model, null, []),
        ];
        foreach ($calls as $call) {
            try {
                $call();
                self::fail('A weak caller null must fail the nonnullable scalar parameter type.');
            } catch (\TypeError) {
                self::assertSame($model, $model->limit(0, 1));
            }
        }
    }

    public function testWeakScalarArgumentsRetainSourceCoercion(): void
    {
        $model = new NativeModelFixture();
        self::assertSame($model, modelWeakLimit($model, '0', '2'));
        self::assertSame($model, modelWeakGroupLimit($model, '2'));
        self::assertSame($model, modelWeakExpectRevision($model, 12, 3));
        $model->setLabel(null);
        self::assertNull($model->label(), 'mixed column values continue to accept null');
        self::assertSame('null', Model::jsonText(null), 'mixed JSON values continue to accept null');
    }

    public function testUnselectedGeneratedColumnHasTheSourceError(): void
    {
        try {
            (new NativeModelFixture())->label();
            self::fail('An unselected column must fail.');
        } catch (OrmException $error) {
            self::assertSame('COLUMN_UNSELECTED', $error->code_);
            self::assertSame('COLUMN_UNSELECTED: label was not selected', $error->getMessage());
        }
    }

    public function testStyledColumnDistinguishesUnselectedSqlNullAndEncodedNull(): void
    {
        $model = new NativeModelFixture();
        try {
            $model->payload();
            self::fail('An unselected styled column must fail.');
        } catch (OrmException $error) {
            self::assertSame('COLUMN_UNSELECTED', $error->code_);
        }

        $model->setPayload(\Polyspec\Orm\StyledValue::sqlNull());
        self::assertSame(['kind' => 'sql-null'], $model->payload()->jsonSerialize());

        $model->setPayload(\Polyspec\Orm\StyledValue::value(null));
        self::assertSame(['kind' => 'value', 'value' => null], $model->payload()->jsonSerialize());
    }

    public function testDecimalNormalizationAndDatetimeUsesTheConnectionZone(): void
    {
        $model = new NativeModelFixture();
        $model->setAmount('+0001.2');
        $model->setHappened('2024-03-04 05:06:07.123');

        self::assertSame('1.20', $model->amount());
        self::assertInstanceOf(\DateTimeImmutable::class, $model->happened());
        self::assertSame('2024-03-04 05:06:07.123000', $model->happened()->format('Y-m-d H:i:s.u'));
        self::assertSame('UTC', $model->happened()->getTimezone()->getName());
    }

    public function testStateOwnedClosureCycleIsVisibleToGarbageCollector(): void
    {
        $model = new NativeModelFixture();
        $weak = WeakReference::create($model);
        $model->fetchKey(static function () use ($model): string {
            return spl_object_hash($model);
        });

        unset($model);
        gc_collect_cycles();

        self::assertNull($weak->get());
    }

    public function testNativeModelCanBeClonedAndCloneCanBeChained(): void
    {
        $model = (new NativeModelFixture())->setLabel('before')->limit(1, 5)->orderByRandom();
        $clone = clone $model;

        self::assertNotSame($model, $clone);
        self::assertSame(NativeModelFixture::class, $clone::class);
        self::assertSame('before', $clone->label());
        self::assertSame($clone, $clone->setLabel('after')->groupLimit(3)->removeAllColumns());
        self::assertSame('before', $model->label());
        self::assertSame($model, $model->addAllColumns());
    }

    public function testPrivateTypedStateUsesNativeObjectSerializationAndCOW(): void
    {
        $model = (new NativeModelFixture())->setLabel('original')->setAmount('1.20');
        $copy = unserialize(serialize($model));

        self::assertInstanceOf(NativeModelFixture::class, $copy);
        self::assertSame('original', $copy->label());
        self::assertSame('1.20', $copy->amount());
        $copy->setLabel('changed');
        self::assertSame('original', $model->label());
        self::assertSame('changed', $copy->label());
    }

    public function testArrayJsonAndJsonSerializePreserveColumnOrder(): void
    {
        $model = (new NativeModelFixture())->setLabel('sample')->setAmount('2.50');

        self::assertSame(['label' => 'sample', 'amount' => '2.50'], $model->toArray());
        self::assertSame(
            [['label', 'sample'], ['amount', '2.50']],
            (new \ReflectionMethod(Model::class, 'pairs'))->invoke($model),
        );
        self::assertSame('{"label":"sample","amount":"2.50"}', $model->toJson());
        self::assertEquals((object) ['label' => 'sample', 'amount' => '2.50'], $model->jsonSerialize());
    }

    public function testNativeModelJsonPreservesOrderedJsonNumberText(): void
    {
        $stored = '{"z":9007199254740993,"b":1.50,"a":1e2}';
        $model = (new NativeModelFixture())->setPayload(
            \Polyspec\Orm\StyledValue::value(\Polyspec\OrderedJson\parse($stored))
        );
        self::assertSame(
            '{"payload":{"kind":"value","value":' . $stored . '}}',
            $model->toJson(),
        );
    }

    public function testQueryTracksFullJoinPathsAndRejectsDuplicateResultNames(): void
    {
        $root = new NativeModelFixture();
        $child = new NativeModelFixture();
        $leaf = new NativeModelFixture();
        $root->joinIdWithId($child);
        $child->joinIdWithId($leaf);
        $request = new Request('all', 'sha256:model-query-test');
        $namesSnapshot = $request->names;
        $frame = new Frame($root, null);
        $query = new \ReflectionMethod(Model::class, 'query');
        $query->invoke($root, $request, $frame);

        self::assertSame([], $namesSnapshot, 'query name insertion separates the shared Request array');
        self::assertSame([
            'NativeModelFixture_model' => true,
            'NativeModelFixture_model/NativeModelFixture_model' => true,
        ], $request->names);

        $duplicate = new NativeModelFixture();
        $duplicate->joinIdWithId(new NativeModelFixture());
        $duplicate->joinIdWithId(new NativeModelFixture());
        $duplicateRequest = new Request('all', 'sha256:model-query-test');
        $duplicateSnapshot = $duplicateRequest->names;
        try {
            $query->invoke($duplicate, $duplicateRequest, new Frame($duplicate, null));
            self::fail('a repeated join path must fail before planning');
        } catch (OrmException $error) {
            self::assertSame('CONFIG', $error->code_);
            self::assertSame(
                'CONFIG: join result name NativeModelFixture_model is used twice; use alias<Name>()',
                $error->getMessage(),
            );
        }
        self::assertSame([], $duplicateSnapshot);
        self::assertSame(['NativeModelFixture_model' => true], $duplicateRequest->names);
    }

    public function testRelationAndSubqueryIrUseFramedQueryResults(): void
    {
        $model = new NativeModelFixture();
        $request = new Request('all', 'sha256:framed-model-query-test');
        $relationIr = new \ReflectionMethod(Model::class, 'relationIr');
        $relation = $relationIr->invoke($model, false, $request);
        self::assertIsArray($relation);

        $subqueryModel = (new NativeModelFixture())->addColumnId();
        $subqueryRequest = new Request('all', 'sha256:framed-subquery-test');
        $subqueryIr = new \ReflectionMethod(Model::class, 'subqueryIr');
        $subquery = $subqueryIr->invoke($subqueryModel, $subqueryRequest, $model, false);
        self::assertIsArray($subquery);
        self::assertArrayNotHasKey('columns', $subquery);
    }

    public function testColumnsIrIncludesAddedScalarSubquery(): void
    {
        $outer = (new NativeModelFixture())->removeAllColumns()
            ->addColumnTaskPoints(static fn (NativeModelFixture $parent) => (new NativeModelFixture())->addColumnId())
            ->orderByIdAsc();
        $outputs = (new \ReflectionProperty(Model::class, 'outputs'))->getValue($outer);
        $mode = (new \ReflectionProperty(Model::class, 'columnMode'))->getValue($outer);
        $request = new Request('all', 'sha256:columns-ir-subquery');
        $columns = (new \ReflectionMethod(Model::class, 'columnsIr'))->invoke($outer, $request);
        self::assertTrue((new \ReflectionMethod(Model::class, 'columnsIr'))->isInternal());
        self::assertSame('none', $mode);
        self::assertArrayHasKey('task_points', $outputs);
        self::assertIsArray($columns);
        self::assertArrayHasKey('sub', $columns);
        self::assertArrayHasKey('task_points', $columns['sub']);
    }
}
