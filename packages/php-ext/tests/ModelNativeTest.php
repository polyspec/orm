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

require_once __DIR__ . '/model-weak-caller.php';

final class NativeModelFixture extends Model
{
    public static function meta(): array
    {
        return [
            'entity' => 'NativeModelFixture',
            'columns' => [
                'id' => ['type' => 'i64', 'codec' => [], 'nullable' => false],
                'label' => ['type' => 'text', 'codec' => [], 'nullable' => true],
                'amount' => ['type' => 'decimal', 'precision' => 8, 'scale' => 2, 'codec' => [], 'nullable' => true],
                'happened' => ['type' => 'datetime', 'codec' => [], 'nullable' => true],
            ],
        ];
    }

    public function setLabel(mixed $value): static
    {
        return $this->writeColumn('label', $value);
    }

    public function label(): mixed
    {
        return $this->readColumn('label');
    }

    public function setAmount(mixed $value): static
    {
        return $this->writeColumn('amount', $value);
    }

    public function amount(): mixed
    {
        return $this->readColumn('amount');
    }

    public function setHappened(mixed $value): static
    {
        return $this->writeColumn('happened', $value);
    }

    public function happened(): mixed
    {
        return $this->readColumn('happened');
    }
}

final class ModelNativeTest extends TestCase
{
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
        foreach (['connect', '__invoke', 'and', 'or', 'not', 'andNot', 'orNot', 'on', 'relation', 'relations', 'limit', 'orderByRandom', 'removeAllColumns', 'addAllColumns', 'parentNode', 'groupLimit', 'expectRevision', 'deleteLock', 'fetchKey', 'fetchValue', 'forUpdate', 'forShare', 'forUpdateNoWait', 'forShareNoWait', 'duplication', '__call', 'registerJoins', 'get', 'gets', 'getsCount', 'getCount', 'getSum', 'getAvg', 'getsPage', 'getQuery', 'encodeValue', 'create', 'creates', 'update', 'save', 'delete', 'deleteRow', 'restore', 'restoreOrCreate', 'connection', 'meta', 'toArray', 'toJson', 'jsonText', 'jsonSerialize', '__clone', 'readColumn', 'writeColumn'] as $name) {
            self::assertTrue($reflection->hasMethod($name), "Missing Model::$name");
            self::assertTrue($reflection->getMethod($name)->isInternal(), "Model::$name is not native");
            self::assertSame('polyspec_orm', $reflection->getMethod($name)->getExtensionName());
        }
        foreach (['fail', 'subject', 'addItem', 'negated', 'connector', 'addRelation', 'prefixed', 'arity', 'outputName', 'addColumnCall', 'addJoin', 'named', 'whereChain', 'predicate', 'by', 'revisionGuard', 'value', 'resolved', 'putSet', 'columnValue', 'timeValue', 'executor', 'build', 'resultName', 'query', 'relationIr', 'columnsIr', 'subqueryIr', 'groupIr', 'predIr', 'newRow', 'rowShape', 'assembleRow', 'joinChild', 'relationChild', 'collectionKey', 'assemble', 'matchValues', 'matchKey', 'attachExternal', 'columnOrExtra', 'load', 'groupValue', 'groupInteger', 'groupFloat', 'aggregate', 'aggregateNumber', 'manifestHash', 'writeRequest', 'assignIr', 'keyValues', 'keyWhere', 'withAesColumns', 'restoreStep', 'restoreKeyValue', 'pairs', 'columnArrayValue', 'sixFractionDigits', 'arrayValue', 'holdsOrderedJson'] as $name) {
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
        self::assertSame('{"label":"sample","amount":"2.50"}', $model->toJson());
        self::assertEquals((object) ['label' => 'sample', 'amount' => '2.50'], $model->jsonSerialize());
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
}
