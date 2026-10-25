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
    // Requirements: DBS-112, DBS-114.

    public function testGenerationToolingIsNotLoaded(): void
    {
        $classes = [
            \Polyspec\Orm\OrmGen::class,
            \Polyspec\Orm\Generator::class,
            \Polyspec\Orm\Scan::class,
            \Polyspec\Orm\ScanVisitor::class,
            \Polyspec\Orm\ChainDeclare::class,
            \Polyspec\Orm\UsageError::class,
        ];
        foreach ($classes as $class) {
            self::assertFalse(class_exists($class, false), "$class must not be loaded by extension startup");
        }

        $nativeClasses = [
            \Polyspec\Orm\Engine::class,
            \Polyspec\Orm\Assemble::class,
            \Polyspec\Orm\Config::class,
            \Polyspec\Orm\Dialect::class,
            \Polyspec\Orm\ParamCheck::class,
            \Polyspec\Orm\TxFrame::class,
            \Polyspec\Orm\DbState::class,
            \Polyspec\Orm\Dbspec\Meet::class,
        ];
        foreach ($nativeClasses as $class) {
            self::assertTrue(class_exists($class), "$class is not registered");
            self::assertTrue((new ReflectionClass($class))->isInternal(), "$class is provided by a userland fallback");
        }
    }

    public function testPhpGeneratedTypedGetterUsesInternalModelStorage(): void
    {
        $dir = sys_get_temp_dir() . '/orm-php-ext-generated-getter-' . getmypid();
        is_dir($dir) || mkdir($dir, 0o700, true);
        $namespace = 'Polyspec\\Orm\\Extension\\Tests\\GeneratedTypedGetter';
        try {
            $class = \Polyspec\Orm\Tests\OrmGenTestSupport::generateItemModel(
                $dir,
                $namespace,
                "dbspec 1 typed\n\ntable item {\n  price i32\n  primary key (price)\n}\n"
            );
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

    // Requirements: DBS-112, DBS-121, INT-2, INT-3, INT-4, INT-5, INT-6, INT-7, INT-8.
    public function testPhpGeneratedFieldTypesFollowTheRuntimeModel(): void
    {
        $dir = sys_get_temp_dir() . '/orm-php-ext-generated-types-' . getmypid();
        is_dir($dir) || mkdir($dir, 0o700, true);
        $namespace = 'Polyspec\\Orm\\Extension\\Tests\\GeneratedFieldTypes';
        try {
            $class = \Polyspec\Orm\Tests\OrmGenTestSupport::generateItemModel(
                $dir,
                $namespace,
                \Polyspec\Orm\Tests\OrmGenTestSupport::FIELD_TYPES_DOCUMENT
            );
            self::assertTrue((new ReflectionClass(Model::class))->isInternal());
            self::assertTrue(
                (new ReflectionClass($class))->getParentClass()->isInternal(),
                'the generated PHP model uses the native extension Model',
            );
            \Polyspec\Orm\Tests\OrmGenTestSupport::assertGeneratedFieldTypes($this, $class);
        } finally {
            exec('rm -rf ' . escapeshellarg($dir));
        }
    }

    // Requirements: DSL-129.
    public function testSharedPhpGeneratorRejectsTheMethodCollisionUsedWithNativeModels(): void
    {
        self::assertTrue((new ReflectionClass(Model::class))->isInternal(), 'the PHP extension Model is native');
        $dir = sys_get_temp_dir() . '/orm-php-ext-generated-collision-' . getmypid();
        is_dir($dir) || mkdir($dir, 0o700, true);
        try {
            $set = "$dir/dbspec-set.json";
            file_put_contents($set, json_encode(['schema' => 1, 'documents' => ['collision.dbs'], 'external' => []]));
            file_put_contents(
                "$dir/collision.dbs",
                "dbspec 1 collision\n\ntable item {\n  seq i64 identity\n  amount i32\n  sum_amount i32\n"
                . "  primary key (seq)\n}\n"
            );
            [$code, $output, $message] = \Polyspec\Orm\Tests\OrmGenTestSupport::run([
                'gen', '--set', $set, '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Extension\\Tests\\Collision'
            ]);
            self::assertNotSame(0, $code, "$output $message");
            self::assertStringContainsString(
                'item.sum_amount: the condition method sumAmount is also the model method sumAmount',
                $output . $message
            );
            self::assertDirectoryDoesNotExist("$dir/model");
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

    // Requirements: INT-88, INT-89.
    public function testTerminalReturnsTheFirstRecordedBuilderError(): void
    {
        require_once dirname(__DIR__, 2) . '/php/gen/bootstrap.php';

        $model = new \Polyspec\Orm\Tests\Model\Author();
        self::assertTrue((new \ReflectionMethod(Model::class, 'getCount'))->isInternal());
        self::assertSame($model, $model->limit(-1, 1)->limit(0, 0));
        self::assertNull($model->connection(), 'the terminal must fail before resolving a connection');
        try {
            $model->getCount();
            self::fail('the terminal must return the recorded builder error before issuing SQL');
        } catch (OrmException $error) {
            self::assertSame('CONFIG', $error->code_);
            self::assertSame(
                'CONFIG: limit requires a non-negative offset and a positive count',
                $error->getMessage()
            );
        }
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

    // Requirements: COD-20.
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

        $dir = sys_get_temp_dir() . '/orm-php-ext-generated-nonnull-styled-' . getmypid();
        is_dir($dir) || mkdir($dir, 0o700, true);
        try {
            $class = \Polyspec\Orm\Tests\OrmGenTestSupport::generateItemModel(
                $dir,
                'Polyspec\\Orm\\Extension\\Tests\\GeneratedNonnullStyled',
                "dbspec 1 styled\n\ntable item {\n  seq i64 identity\n"
                    . "  payload text\n  primary key (seq)\n  settings {\n"
                    . "    codec payload ordered_json\n  }\n}\n"
            );
            $generated = new $class();
            try {
                $generated->setPayload(\Polyspec\Orm\StyledValue::sqlNull());
                self::fail('generated non-null setter accepted SQL NULL');
            } catch (OrmException $error) {
                self::assertSame('CODEC_ENCODE', $error->code_);
            }
            try {
                $generated->getPayload();
                self::fail('rejected generated setter changed the model');
            } catch (OrmException $error) {
                self::assertSame('COLUMN_UNSELECTED', $error->code_);
            }
            $generated->setPayload(\Polyspec\Orm\StyledValue::value(null));
            self::assertSame(
                ['kind' => 'value', 'value' => null],
                $generated->getPayload()->jsonSerialize(),
            );
        } finally {
            exec('rm -rf ' . escapeshellarg($dir));
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
        self::assertSame(
            [['label', 'sample'], ['amount', '2.50']],
            (new \ReflectionMethod(Model::class, 'pairs'))->invoke($model),
        );
        self::assertSame('{"label":"sample","amount":"2.50"}', $model->toJson());
        self::assertEquals((object) ['label' => 'sample', 'amount' => '2.50'], $model->jsonSerialize());
    }

    // Requirements: COD-16.
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

    public function testDbspecMeetIsNative(): void
    {
        $reflection = new ReflectionClass(\Polyspec\Orm\Dbspec\Meet::class);
        self::assertTrue($reflection->isInternal());
        $method = $reflection->getMethod('kind');
        self::assertTrue($method->isInternal());
        self::assertTrue($method->isStatic());
        self::assertSame([
            'integer',
            'integer',
            'string',
            'string',
            'decimal scale 4',
            'time precision 3',
            'datetime precision 0',
            'uuid',
        ], [
            \Polyspec\Orm\Dbspec\Meet::kind('i16', 0, 0),
            \Polyspec\Orm\Dbspec\Meet::kind('i64', 0, 0),
            \Polyspec\Orm\Dbspec\Meet::kind('varchar', 0, 0),
            \Polyspec\Orm\Dbspec\Meet::kind('text', 0, 0),
            \Polyspec\Orm\Dbspec\Meet::kind('decimal', 4, 0),
            \Polyspec\Orm\Dbspec\Meet::kind('time', 0, 3),
            \Polyspec\Orm\Dbspec\Meet::kind('datetime', 0, 0),
            \Polyspec\Orm\Dbspec\Meet::kind('uuid', 0, 0),
        ]);
    }

    public function testConfigDialectAndFramesAreNative(): void
    {
        $reflection = new ReflectionClass(\Polyspec\Orm\Config::class);
        self::assertTrue($reflection->isInternal());
        foreach (['__construct', 'keyring'] as $method) {
            self::assertTrue($reflection->getMethod($method)->isInternal());
        }

        $config = new \Polyspec\Orm\Config(aesKeys: [1 => 'key-one', 2 => 'key-two'], aesVersion: 2);
        self::assertSame('key-two', $config->aesKey);
        self::assertSame('key-two', $config->keyring()->key(2));
        self::assertSame([1, 2], $config->keyring()->versions());

        try {
            new \Polyspec\Orm\Config(aesKey: 'different', aesKeys: [1 => 'key-one']);
            self::fail('Expected Config to reject different active AES keys');
        } catch (\Polyspec\Orm\OrmException $error) {
            self::assertSame('CONFIG', $error->code_);
            self::assertSame('CONFIG: aesKey differs from aesKeys[1]', $error->getMessage());
        }

        $stateReflection = new ReflectionClass(\Polyspec\Orm\DbState::class);
        self::assertTrue($stateReflection->isInternal());
        $state = new \Polyspec\Orm\DbState();
        self::assertFalse($state->closed);
        self::assertSame([], $state->stmts);
        self::assertSame(0, $state->transactions);

        $frameReflection = new ReflectionClass(\Polyspec\Orm\TxFrame::class);
        self::assertTrue($frameReflection->isInternal());
        self::assertTrue($frameReflection->getMethod('__construct')->isInternal());
        self::assertTrue($frameReflection->getMethod('recordInserted')->isInternal());

        require_once dirname(__DIR__, 2) . '/php/gen/bootstrap.php';
        $account = \Polyspec\Orm\Tests\Model\Account::class;
        $meta = $account::meta();
        $db = (new ReflectionClass(\Polyspec\Orm\Db::class))->newInstanceWithoutConstructor();
        $frame = new \Polyspec\Orm\TxFrame($db, false, 'serializable', 9);
        self::assertSame($db, $frame->db);
        self::assertSame(9, $frame->number);
        $request = new Request('insert', $meta['manifest_hash']);
        $request->ir['entity'] = $meta['entity'];
        \Polyspec\Orm\TxFrame::recordInserted($frame, $request, '12');
        self::assertSame([$meta['entity'] => [12 => true]], $frame->inserted);
        \Polyspec\Orm\TxFrame::recordInserted($frame, $request, 13);
        self::assertSame([$meta['entity'] => [12 => true, 13 => true]], $frame->inserted);

        $dialectReflection = new ReflectionClass(\Polyspec\Orm\Dialect::class);
        self::assertTrue($dialectReflection->isInternal());
        foreach (
            [
            '__construct', 'isValueFunction', 'quoteWith', 'quote', 'placeholder', 'limit', 'limitParams', 'forceIndex',
            'insertReturningId', 'now', 'handlesStyle', 'decodesStyle', 'hostNow', 'clockOperand', 'contains',
            'containsBinary', 'fulltext', 'upsert', 'readExpr', 'writeExpr', 'readTime', 'writeTime', 'readUuid',
            'writeUuid', 'rowLock', 'literal', 'restartIdentity', 'random', 'nullsOrder', 'tupleIn', 'columnFunction',
                'valueFunction',
            ] as $method
        ) {
            self::assertTrue($dialectReflection->getMethod($method)->isInternal());
        }
        self::assertTrue($dialectReflection->getProperty('name')->isReadOnly());
        $mysql = new \Polyspec\Orm\Dialect('mysql');
        $postgres = new \Polyspec\Orm\Dialect('postgres');
        $sqlite = new \Polyspec\Orm\Dialect('sqlite');
        self::assertSame('`a`.`b``c`', $mysql->quote('a.b`c'));
        self::assertSame('"a"."b"', $postgres->quote('a.b'));
        self::assertSame('"a__b"', $sqlite->quote('a.b'));
        self::assertSame('$3', $postgres->placeholder(3));
        self::assertSame(' LIMIT 2, 8', $mysql->limit(2, 8));
        self::assertSame(' FORCE INDEX (`ix`)', $mysql->forceIndex('ix'));
        self::assertSame('CURRENT_TIMESTAMP(3)', $mysql->now(3));
        self::assertSame('CURRENT_TIMESTAMP', $sqlite->now(3));
        self::assertSame(' FOR UPDATE NOWAIT', $postgres->rowLock('update_nowait'));
        self::assertSame('', $sqlite->rowLock('share'));
        self::assertSame(
            'NOW(6)',
            $mysql->valueFunction('now', static fn (): string => '?', static fn (): string => '?')
        );
        self::assertSame(
            'date(?)',
            $sqlite->valueFunction('today', static fn (): string => '?', static fn (): string => '?')
        );
        self::assertTrue(\Polyspec\Orm\Dialect::isValueFunction('months_later'));
        self::assertFalse(\Polyspec\Orm\Dialect::isValueFunction('day_of_week'));

        self::assertSame('?', $mysql->placeholder(3));
        self::assertSame(' LIMIT 2, 8', $mysql->limitParams('2', '8'));
        self::assertSame(' LIMIT 8 OFFSET 2', $postgres->limit(2, 8));
        self::assertSame(' LIMIT :count OFFSET :offset', $postgres->limitParams(':offset', ':count'));
        self::assertSame('`a``b`', $mysql->quote('a`b'));
        self::assertSame('"a""b"', $postgres->quote('a"b'));
        self::assertSame('<<a<<.<<b<<', \Polyspec\Orm\Dialect::quoteWith('<<', 'a.b'));
        self::assertSame('', $postgres->forceIndex('ix'));
        self::assertSame(' INDEXED BY "ix"', $sqlite->forceIndex('ix'));
        self::assertSame(' ON DUPLICATE KEY UPDATE x = ?', $mysql->upsert(['id'], 'x = ?'));
        self::assertSame(
            ' ON CONFLICT ("id", "scope") DO UPDATE SET x = ?',
            $postgres->upsert(['id', 'scope'], 'x = ?')
        );
        self::assertFalse($mysql->insertReturningId());
        self::assertTrue($postgres->insertReturningId());
        self::assertTrue($sqlite->insertReturningId());
        self::assertTrue($mysql->handlesStyle('ip'));
        self::assertFalse($postgres->handlesStyle('ip'));
        self::assertTrue($mysql->decodesStyle('ip'));
        self::assertFalse($sqlite->decodesStyle('ip'));
        self::assertTrue($postgres->hostNow());
        self::assertFalse($mysql->hostNow());
        self::assertSame('(created || \'.000000\')', $sqlite->clockOperand('created', 0));
        self::assertSame('(created || \'00\')', $sqlite->clockOperand('created', 4));
        self::assertSame('CURRENT_TIMESTAMP', $mysql->now(0));
        self::assertSame('REPLACE(REPLACE(', substr($mysql->contains('name', '?'), 0, 16));
        self::assertSame("name ILIKE ?", $postgres->contains('name', '?'));
        self::assertSame("name LIKE ? ESCAPE '\\'", $sqlite->contains('name', '?'));
        $binaryTags = [];
        self::assertSame(
            'name LIKE :pattern',
            $mysql->containsBinary('name', static function (string $tag) use (&$binaryTags): string {
                $binaryTags[] = $tag;
                return ':pattern';
            })
        );
        self::assertSame(['like_contains'], $binaryTags);
        self::assertSame(
            'instr(name, :value) > 0',
            $sqlite->containsBinary('name', static function (string $tag) use (&$binaryTags): string {
                $binaryTags[] = $tag;
                return ':value';
            })
        );
        self::assertSame(['like_contains', ''], $binaryTags);
        $fulltext = static fn(string $tag): string => '[' . $tag . ']';
        self::assertSame(
            'MATCH (name, body) AGAINST ([fulltext_boolean] IN BOOLEAN MODE)',
            $mysql->fulltext(['name', 'body'], $fulltext, true)
        );
        self::assertSame(
            "to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(body, '')) @@ plainto_tsquery('simple', [])",
            $postgres->fulltext(['name', 'body'], $fulltext, false)
        );
        self::assertNull($sqlite->fulltext(['name'], $fulltext, true));
        self::assertSame('INET6_NTOA(INET6_NTOA(ip))', $mysql->readExpr('ip', ['ip', 'ip']));
        self::assertSame('INET6_ATON(INET6_ATON(?))', $mysql->writeExpr('?', ['ip', 'ip']));
        self::assertSame('CAST(t AS CHAR)', $mysql->readTime('t', 3));
        self::assertSame("substr(to_char(t, 'HH24:MI:SS.US'), 1, 12)", $postgres->readTime('t', 3));
        self::assertSame('CAST(CAST(? AS text) AS time)', $postgres->writeTime('?'));
        self::assertSame('CAST(id AS text)', $postgres->readUuid('id'));
        self::assertSame('CAST(CAST(? AS text) AS uuid)', $postgres->writeUuid('?'));
        self::assertNull($sqlite->rowLock('invalid'));
        self::assertSame("'a''b'", \Polyspec\Orm\Dialect::literal("a'b"));
        self::assertSame('ALTER TABLE `users` AUTO_INCREMENT = 1', $mysql->restartIdentity('users', 'id'));
        self::assertSame(
            'SELECT setval(pg_get_serial_sequence(\'"users"\', \'id\'), '
                . 'COALESCE(MAX("id"), 0) + 1, false) FROM "users"',
            $postgres->restartIdentity('users', 'id')
        );
        self::assertSame(
            'UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX("id"), 0) FROM "users") WHERE name = \'users\'',
            $sqlite->restartIdentity('users', 'id')
        );
        self::assertSame('random()', $sqlite->random());
        self::assertSame(' NULLS FIRST', $postgres->nullsOrder(false));
        self::assertSame('', $sqlite->nullsOrder(true));
        self::assertSame(
            '(a, b) NOT IN ((?, ?), (?, ?))',
            $postgres->tupleIn(['a', 'b'], [['?', '?'], ['?', '?']], true)
        );
        self::assertSame('(a) IN (VALUES (?))', $sqlite->tupleIn(['a'], [['?']], false));
        self::assertSame('YEAR(created)', $mysql->columnFunction('year', 'created'));
        self::assertSame('EXTRACT(MONTH FROM created)::int', $postgres->columnFunction('month', 'created'));
        self::assertSame("date(created)", $sqlite->columnFunction('date', 'created'));
        self::assertNull($sqlite->columnFunction('unsupported', 'created'));
        self::assertNull($mysql->valueFunction('unsupported', static fn(): string => '?', static fn(): string => '?'));
        // A placeholder callback of valueFunction that counts its calls in $calls.
        $counted = static function (string $placeholder, int &$calls): \Closure {
            return static function () use ($placeholder, &$calls): string {
                $calls++;
                return $placeholder;
            };
        };
        $argCalls = $clockCalls = 0;
        $mysqlInterval = $mysql->valueFunction('days_ago', $counted('?', $argCalls), $counted('?', $clockCalls));
        self::assertStringContainsString('CASE WHEN ? BETWEEN -3652059 AND 3652059 THEN ?', $mysqlInterval);
        self::assertSame(4, $argCalls);
        self::assertSame(0, $clockCalls);
        $argCalls = $clockCalls = 0;
        $postgresInterval = $postgres->valueFunction(
            'days_later',
            $counted('$2', $argCalls),
            $counted('$1', $clockCalls)
        );
        self::assertStringContainsString(
            'make_interval(days => CAST(CASE WHEN CAST($2 AS bigint) BETWEEN -3652059 AND '
                . '3652059 THEN CAST($2 AS bigint) END AS integer))',
            $postgresInterval
        );
        self::assertSame(4, $argCalls);
        self::assertSame(2, $clockCalls);
        $argCalls = $clockCalls = 0;
        $sqliteInterval = $sqlite->valueFunction('months_ago', $counted('?', $argCalls), $counted('?', $clockCalls));
        self::assertStringContainsString("datetime(?, '-' || CAST(? AS TEXT) || ' months', 'floor')", $sqliteInterval);
        self::assertSame(2, $argCalls);
        self::assertSame(4, $clockCalls);
        try {
            new \Polyspec\Orm\Dialect('oracle');
            self::fail('Expected Dialect to reject an unknown database');
        } catch (\Polyspec\Orm\OrmException $error) {
            self::assertSame('DIALECT_UNKNOWN', $error->code_);
            self::assertSame('DIALECT_UNKNOWN: oracle', $error->getMessage());
        }
        $paramCheck = new ReflectionClass(\Polyspec\Orm\ParamCheck::class);
        self::assertTrue($paramCheck->isInternal());
        foreach (['bindSlotType', 'useSlotType', 'checkAssign', 'check'] as $method) {
            self::assertTrue($paramCheck->getMethod($method)->isInternal());
        }
        // The checked type of a non-null varchar slot of the column name.
        $nameSlot = static fn(int $precision, int $scale, int $length): array => [
            'type' => 'varchar',
            'precision' => $precision,
            'scale' => $scale,
            'length' => $length,
            'not_null' => true,
            'column' => 'name',
        ];
        self::assertSame(
            $nameSlot(4, 0, 2),
            \Polyspec\Orm\ParamCheck::bindSlotType([
                'col_type' => 'varchar', 'precision' => '4', 'scale' => null, 'length' => 2,
                'not_null' => true, 'column' => 'name',
            ])
        );
        self::assertSame(
            $nameSlot(4, 2, 20),
            \Polyspec\Orm\ParamCheck::useSlotType([
                'type' => 'varchar', 'assign' => true,
                'column' => ['type' => 'varchar', 'precision' => 4, 'scale' => 2, 'length' => 20,
                    'nullable' => false, 'name' => 'name'],
            ])
        );
        self::assertSame(
            ['type' => 'datetime', 'precision' => 6, 'scale' => 0, 'length' => 0],
            \Polyspec\Orm\ParamCheck::useSlotType(['type' => 'datetime', 'column' => null])
        );

        $zone = new \DateTimeZone('UTC');
        \Polyspec\Orm\ParamCheck::checkAssign(1, null, ['not_null' => false]);
        try {
            \Polyspec\Orm\ParamCheck::checkAssign(2, null, ['not_null' => true, 'column' => 'name']);
            self::fail('Expected ParamCheck to reject NULL for a non-null bind slot');
        } catch (\Polyspec\Orm\OrmException $error) {
            self::assertSame('CODEC_ENCODE', $error->code_);
            self::assertSame('CODEC_ENCODE: parameter 2 assigns NULL to the non-null name', $error->getMessage());
        }

        \Polyspec\Orm\ParamCheck::check(3, 32767, ['type' => 'i16'], $zone);
        \Polyspec\Orm\ParamCheck::check(3, 12.5, ['type' => 'f64'], $zone);
        \Polyspec\Orm\ParamCheck::check(3, false, ['type' => 'bool'], $zone);
        \Polyspec\Orm\ParamCheck::check(3, '12.30', ['type' => 'decimal', 'precision' => 4, 'scale' => 2], $zone);
        \Polyspec\Orm\ParamCheck::check(3, "éé", ['type' => 'varchar', 'length' => 2], $zone);
        \Polyspec\Orm\ParamCheck::check(3, "12:34:56.120", ['type' => 'time', 'precision' => 2], $zone);
        \Polyspec\Orm\ParamCheck::check(3, new \Polyspec\Orm\Bytes("\0\xFF"), ['type' => 'bytes'], $zone);

        try {
            \Polyspec\Orm\ParamCheck::check(4, 'value', ['type' => 'i32'], $zone);
            self::fail('Expected ParamCheck to reject a non-integer bind value');
        } catch (\Polyspec\Orm\OrmException $error) {
            self::assertSame('CODEC_ENCODE: parameter 4 (string) is not a i32 value', $error->getMessage());
        }
        try {
            \Polyspec\Orm\ParamCheck::check(5, '1.234', ['type' => 'decimal', 'precision' => 4, 'scale' => 2], $zone);
            self::fail('Expected ParamCheck to reject decimal precision loss');
        } catch (\Polyspec\Orm\OrmException $error) {
            self::assertSame(
                'CODEC_ENCODE: parameter 5: CODEC_ENCODE: decimal 1.234: fraction exceeds scale',
                $error->getMessage()
            );
            self::assertInstanceOf(\Polyspec\Orm\OrmException::class, $error->getPrevious());
            self::assertSame(
                'CODEC_ENCODE: decimal 1.234: fraction exceeds scale',
                $error->getPrevious()->getMessage()
            );
        }
        try {
            \Polyspec\Orm\ParamCheck::check(6, '12:34:56.123', ['type' => 'time', 'precision' => 2], $zone);
            self::fail('Expected ParamCheck to reject non-zero time precision loss');
        } catch (\Polyspec\Orm\OrmException $error) {
            self::assertSame(
                'CODEC_ENCODE: parameter 6: CODEC_ENCODE: time value "12:34:56.123" has a non-zero digit '
                    . 'past its 2 fraction digits',
                $error->getMessage()
            );
            self::assertInstanceOf(\Polyspec\Orm\OrmException::class, $error->getPrevious());
            self::assertSame(
                'CODEC_ENCODE: time value "12:34:56.123" has a non-zero digit '
                    . 'past its 2 fraction digits',
                $error->getPrevious()->getMessage()
            );
        }
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

    // Engine (the plan cache) and Assemble are classes of the extension, and Assemble::index stamps
    // the decode cells and indexes every assemble node in place as the PHP library does.
    public function testEngineAndAssembleAreNative(): void
    {
        foreach ([\Polyspec\Orm\Engine::class, \Polyspec\Orm\Assemble::class] as $class) {
            self::assertTrue((new \ReflectionClass($class))->isInternal(), "$class is a class of the extension");
        }
        $root = dirname(__DIR__, 3);
        $model = \Polyspec\Orm\RuntimeModel::build(\Polyspec\Orm\RuntimeModel::parse([
            'zone.dbs' => (string) file_get_contents("$root/contracts/fixtures/zone.dbs"),
        ]));
        \Polyspec\Orm\Registry::generated($model->manifestHash, $model->manifestText, $model->externalText);
        $engine = \Polyspec\Orm\Engine::for($model->manifestHash, 'sqlite', 4);
        self::assertSame(
            $engine,
            \Polyspec\Orm\Engine::for($model->manifestHash, 'sqlite', 4),
            'the engine is shared by manifest hash and dialect',
        );
        $request = [
            'ir_version' => 1,
            'manifest_hash' => $model->manifestHash,
            'kind' => 'one',
            'entity' => 'zone_event',
            'n_params' => 0,
        ];
        $compiled = $engine->compile($request);
        self::assertSame(
            'SELECT "a"."seq" AS "a__seq", "a"."start_dt" AS "a__start_dt", "a"."created_ts" AS '
                . '"a__created_ts" FROM "zone_event" AS "a" LIMIT 1 OFFSET 0',
            $compiled['steps'][0]['sql'],
        );
        self::assertArrayNotHasKey('idx', $compiled['steps'][0]['assemble']);
        self::assertArrayNotHasKey('decode', $compiled['steps'][0]);
        $indexed = $engine->plan($request);
        self::assertSame(['seq' => 0, 'start_dt' => 1, 'created_ts' => 2], $indexed['steps'][0]['assemble']['idx']);
        self::assertArrayHasKey('decode', $indexed['steps'][0]);
        self::assertSame([], $indexed['steps'][0]['decode']);
        $cached = $engine->plan($request);
        self::assertSame($indexed, $cached);
        self::assertCount(
            1,
            (new \ReflectionProperty(\Polyspec\Orm\Engine::class, 'plans'))->getValue($engine),
            'planning caches by request shape',
        );
        $uncached = new \Polyspec\Orm\Engine($model, 'sqlite', -1);
        $uncached->plan($request);
        self::assertCount(
            0,
            (new \ReflectionProperty(\Polyspec\Orm\Engine::class, 'plans'))->getValue($uncached),
            'a negative cache size evicts the first plan as the PHP engine does',
        );
        $plan = ['steps' => [
            ['kind' => 'select'],
            ['kind' => 'select', 'assemble' => [
                'entity' => 'zone_event',
                'columns' => [
                    ['name' => 'seq', 'column' => 'seq', 'index' => 0],
                    [
                        'name' => 'start_dt', 'column' => 'start_dt', 'index' => 1,
                        'styles' => ['hex', 'base64'], 'hidden' => true,
                    ],
                ],
                'children' => [['kind' => 'join', 'assemble' => [
                    'entity' => 'zone_event',
                    'columns' => [['name' => 'start_dt', 'column' => 'start_dt', 'index' => 2, 'styles' => ['aes']]],
                ]]],
            ]],
        ]];
        $unindexed = $plan;
        \Polyspec\Orm\Assemble::index($plan, $model);
        self::assertArrayNotHasKey('decode', $unindexed['steps'][0]);
        self::assertArrayNotHasKey('idx', $unindexed['steps'][1]['assemble']);
        self::assertSame([], $plan['steps'][0]['decode']);
        $node = $plan['steps'][1]['assemble'];
        self::assertSame(['seq' => 0, 'start_dt' => 1], $node['idx']);
        self::assertSame(['start_dt' => true], $node['hidden']);
        self::assertSame(['hex'], $node['columns'][1]['host']);
        self::assertSame(['base64'], $node['columns'][1]['codec']);
        $child = $node['children'][0]['assemble'];
        self::assertSame(['start_dt' => 2], $child['idx']);
        self::assertSame([], $child['hidden']);
        self::assertSame($node['node'] + 1, $child['node']);
        self::assertSame(
            [[1, ['hex'], ['base64'], false, null], [2, ['aes'], [], true, null]],
            $plan['steps'][1]['decode'],
        );
        self::assertSame([[2, ['aes'], [], true, null]], \Polyspec\Orm\Assemble::cells($child, $model));
    }

    public function testPublicValueClassesAreNative(): void
    {
        foreach (
            [
            \Polyspec\Orm\Bytes::class,
            \Polyspec\Orm\GoMap::class,
            \Polyspec\Orm\Go::class,
            \Polyspec\Orm\Decimal::class,
            \Polyspec\Orm\Transform::class,
            \Polyspec\Orm\Subscription::class,
            \Polyspec\Orm\Notification::class,
            ] as $class
        ) {
            $reflection = new ReflectionClass($class);
            self::assertTrue($reflection->isInternal(), "$class must be registered by polyspec_orm");
            self::assertTrue($reflection->isFinal());
        }
        foreach (
            [
            [\Polyspec\Orm\Bytes::class, '__construct'],
            [\Polyspec\Orm\GoMap::class, '__construct'],
            [\Polyspec\Orm\Go::class, 'quote'],
            [\Polyspec\Orm\Go::class, 'json'],
            [\Polyspec\Orm\Decimal::class, 'normalize'],
            [\Polyspec\Orm\Decimal::class, 'scaled'],
            [\Polyspec\Orm\Decimal::class, 'fromScaled'],
            [\Polyspec\Orm\Decimal::class, 'decode'],
            [\Polyspec\Orm\Transform::class, 'apply'],
            [\Polyspec\Orm\Transform::class, 'param'],
            [\Polyspec\Orm\Transform::class, 'fulltextBoolean'],
            [\Polyspec\Orm\Subscription::class, '__construct'],
            [\Polyspec\Orm\Subscription::class, 'checkChannel'],
            [\Polyspec\Orm\Subscription::class, 'quoteIdent'],
            [\Polyspec\Orm\Subscription::class, 'receive'],
            [\Polyspec\Orm\Subscription::class, 'unlisten'],
            [\Polyspec\Orm\Subscription::class, 'close'],
            [\Polyspec\Orm\Notification::class, '__construct'],
            ] as [$class, $method]
        ) {
            self::assertTrue((new \ReflectionMethod($class, $method))->isInternal(), "$class::$method must be native");
        }

        $bytes = new \Polyspec\Orm\Bytes("\x00\x7f\x80\xff");
        self::assertSame("\x00\x7f\x80\xff", $bytes->bytes);
        self::assertTrue((new \ReflectionProperty(\Polyspec\Orm\Bytes::class, 'bytes'))->isReadOnly());
        try {
            $bytes->bytes = 'changed';
            self::fail('Bytes::$bytes must be readonly');
        } catch (\Error) {
            self::assertSame("\x00\x7f\x80\xff", $bytes->bytes);
        }

        $map = new \Polyspec\Orm\GoMap(['z' => 1, 'a' => ['x' => true]]);
        self::assertSame(['z' => 1, 'a' => ['x' => true]], $map->items);
        $map->items['b'] = null;
        self::assertSame('{"a":{"x":true},"b":null,"z":1}', \Polyspec\Orm\Go::json($map));
        self::assertSame('{"-1":"negative","z":1}', \Polyspec\Orm\Go::json([-1 => 'negative', 'z' => 1]));

        self::assertSame(
            '"\\a\\b\\f\\n\\r\\t\\v\\x00\\x7f\\\\\\"é\\u200b"',
            \Polyspec\Orm\Go::quote("\x07\x08\x0c\n\r\t\x0b\x00\x7f\\\"é\u{200b}"),
        );
        self::assertSame(
            "{\n  \"z\": [\n    1,\n    \"\\u003c\\u003e\\u0026\"\n  ],\n  \"a\": true\n}",
            \Polyspec\Orm\Go::json(['z' => [1, '<>&'], 'a' => true], '  '),
        );
        self::assertSame('{"x":"\\ufffd"}', \Polyspec\Orm\Go::json(['x' => "\xff"]));
        try {
            \Polyspec\Orm\Go::json(1.5);
            self::fail('floating-point values are unsupported by Go::json');
        } catch (\InvalidArgumentException $error) {
            self::assertSame('unsupported JSON value float', $error->getMessage());
        }

        self::assertSame('12.30', \Polyspec\Orm\Decimal::normalize('+0012.3', 4, 2));
        self::assertSame(1230, \Polyspec\Orm\Decimal::scaled('12.30', 4, 2));
        self::assertSame('-12.30', \Polyspec\Orm\Decimal::fromScaled(-1230, 4, 2));
        self::assertSame('0.00', \Polyspec\Orm\Decimal::decode('-0', 4, 2));
        try {
            \Polyspec\Orm\Decimal::decode(12, 4, 2);
            self::fail('Expected exact decimal text');
        } catch (\Polyspec\Orm\OrmException $error) {
            self::assertSame(\Polyspec\Orm\Code::CODEC_DECODE, $error->code_);
        }

        self::assertSame('%a\\%b\\_c\\\\d%', \Polyspec\Orm\Transform::apply('like_contains', 'a%b_c\\d'));
        self::assertSame('a\\%b\\_c\\\\d%', \Polyspec\Orm\Transform::apply('like_starts', 'a%b_c\\d'));
        self::assertSame('%a\\%b\\_c\\\\d', \Polyspec\Orm\Transform::apply('like_ends', 'a%b_c\\d'));
        self::assertSame('value', \Polyspec\Orm\Transform::apply('unknown', 'value'));
        self::assertSame('+hello +world*', \Polyspec\Orm\Transform::fulltextBoolean('hello +world'));
        self::assertNull(\Polyspec\Orm\Transform::param('like_contains', null));
        self::assertSame('%needle%', \Polyspec\Orm\Transform::param('like_contains', 'needle'));
        try {
            \Polyspec\Orm\Transform::param('like_contains', 12);
            self::fail('Expected a non-text transform value to fail');
        } catch (\Polyspec\Orm\OrmException $error) {
            self::assertSame(\Polyspec\Orm\Code::CODEC_ENCODE, $error->code_);
        }
        try {
            \Polyspec\Orm\Transform::param('fulltext_boolean', ' + - ');
            self::fail('Expected empty fulltext search to fail');
        } catch (\Polyspec\Orm\OrmException $error) {
            self::assertSame(\Polyspec\Orm\Code::IR_INVALID, $error->code_);
        }

        $pdo = new class extends \PDO {
            public array $calls = [];
            public array|false $notification = ['message' => 'events', 'payload' => 'hello', 'pid' => 17];
            public function __construct()
            {
            }
            public function getNotify(int $fetchMode = \PDO::FETCH_BOTH, int $timeout = 0): array|false
            {
                $this->calls[] = ['notify', $fetchMode, $timeout];
                return $this->notification;
            }
            public function exec(string $statement): int|false
            {
                $this->calls[] = ['exec', $statement];
                return 0;
            }
        };
        $subscription = new \Polyspec\Orm\Subscription($pdo);
        $notification = $subscription->receive(0.001);
        self::assertSame(['events', 'hello', 17], [$notification->channel, $notification->payload, $notification->pid]);
        self::assertSame(['notify', \PDO::FETCH_ASSOC, 1], $pdo->calls[0]);
        $subscription->unlisten('a"b');
        self::assertSame(['exec', 'UNLISTEN "a""b"'], $pdo->calls[1]);
        $subscription->close();
        $subscription->close();
        self::assertSame(['exec', 'UNLISTEN *'], $pdo->calls[2]);
        try {
            $subscription->receive(0);
            self::fail('Expected a closed subscription to reject receive');
        } catch (\Polyspec\Orm\OrmException $error) {
            self::assertSame(\Polyspec\Orm\Code::CONFIG, $error->code_);
        }

        $expiredPdo = new class extends \PDO {
            public int $closed = 0;
            public function __construct()
            {
            }
            public function getNotify(int $fetchMode = \PDO::FETCH_BOTH, int $timeout = 0): array|false
            {
                return false;
            }
            public function exec(string $statement): int|false
            {
                $this->closed++;
                return 0;
            }
        };
        $expired = new \Polyspec\Orm\Subscription($expiredPdo);
        try {
            $expired->receive(0);
            self::fail('Expected an expired receive to fail');
        } catch (\Polyspec\Orm\OrmException $error) {
            self::assertSame(\Polyspec\Orm\Code::CANCELED, $error->code_);
            self::assertSame(1, $expiredPdo->closed);
        }
        $failedPdo = new class extends \PDO {
            public function __construct()
            {
            }
            public function getNotify(int $fetchMode = \PDO::FETCH_BOTH, int $timeout = 0): array|false
            {
                throw new \PDOException('notification connection lost');
            }
        };
        try {
            (new \Polyspec\Orm\Subscription($failedPdo))->receive(0);
            self::fail('Expected a PDO receive error to be mapped');
        } catch (\Polyspec\Orm\OrmException $error) {
            self::assertSame(\Polyspec\Orm\Code::CONNECTION_LOST, $error->code_);
            self::assertInstanceOf(\PDOException::class, $error->getPrevious());
            self::assertSame('notification connection lost', $error->getPrevious()->getMessage());
        }
        self::assertSame('"a""b"', \Polyspec\Orm\Subscription::quoteIdent('a"b'));
        \Polyspec\Orm\Subscription::checkChannel(str_repeat('x', 63));
        foreach (['', "bad\0channel"] as $invalidChannel) {
            try {
                \Polyspec\Orm\Subscription::checkChannel($invalidChannel);
                self::fail('Expected an invalid channel to fail');
            } catch (\Polyspec\Orm\OrmException $error) {
                self::assertSame(\Polyspec\Orm\Code::CONFIG, $error->code_);
            }
        }
        try {
            \Polyspec\Orm\Subscription::checkChannel(str_repeat('x', 64));
            self::fail('Expected an oversized channel to fail');
        } catch (\Polyspec\Orm\OrmException $error) {
            self::assertSame(\Polyspec\Orm\Code::CONFIG, $error->code_);
        }
    }
}
