<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

require_once __DIR__ . '/../../php/tests/collection-weak-caller.php';

use DateTimeImmutable;
use DateTimeZone;
use Polyspec\Orm\Bytes;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

final class CollectionFakePdo extends \PDO
{
    public bool $active = false;
    public array $statements = [];
    public bool $suspendFirstStart = false;

    public function __construct() {}

    public function setAttribute(int $attribute, mixed $value): bool
    {
        return true;
    }

    public function exec(string $statement): int|false
    {
        $this->statements[] = $statement;
        if (str_starts_with($statement, 'START TRANSACTION')) {
            $this->active = true;
            if ($this->suspendFirstStart) {
                $this->suspendFirstStart = false;
                \Fiber::suspend();
            }
        } elseif ($statement === 'COMMIT' || $statement === 'ROLLBACK') {
            $this->active = false;
        }
        return 0;
    }

    public function inTransaction(): bool
    {
        return $this->active;
    }
}
use Polyspec\Orm\Collection;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Model;
use Polyspec\Orm\OrmException;
use function Polyspec\Orm\Tests\collectionWeakPut;

class CollectionFixtureModel extends Model
{
    public ?Collection $collectionCycle = null;
    public ?Db $connectedTo = null;
    public array $deleted = [];

    public function __construct(public string $label) {}

    public static function meta(): array
    {
        return [];
    }

    public function toArray(): array
    {
        return ['label' => $this->label];
    }

    public function toJson(): string
    {
        return json_encode($this->toArray(), JSON_THROW_ON_ERROR);
    }

    public function connect(Db $db): static
    {
        parent::connect($db);
        $this->connectedTo = $db;
        return $this;
    }

    public function deleteRow(bool $recursive): void
    {
        $this->deleted[] = $recursive;
    }
}

#[Small]
final class CollectionTest extends TestCase
{
    private static function model(string $label): Model
    {
        return new CollectionFixtureModel($label);
    }

    /** @return list<array<string, mixed>> */
    private static function identityCases(): array
    {
        $source = file_get_contents(__DIR__ . '/../../../tests/collection/keys.json');
        self::assertIsString($source, 'tests/collection/keys.json is unreadable');
        $data = json_decode($source, true, 512, JSON_THROW_ON_ERROR);
        return $data['keys'];
    }

    private static function identityValue(array $case): mixed
    {
        return match ($case['type']) {
            'text', 'bool', 'int' => $case['value'],
            'bytes' => new Bytes(hex2bin($case['hex'])),
            'datetime' => new DateTimeImmutable($case['value']),
            default => self::fail("unknown collection identity type {$case['type']}"),
        };
    }

    public function testCollectionAndIteratorAreOwnedByTheNativeExtension(): void
    {
        $collectionClass = new \ReflectionClass(Collection::class);
        self::assertTrue($collectionClass->isInternal());
        self::assertSame('polyspec_orm', $collectionClass->getExtensionName());
        foreach ($collectionClass->getMethods(\ReflectionMethod::IS_PUBLIC) as $method) {
            self::assertTrue($method->isInternal(), $method->getName());
            self::assertSame('polyspec_orm', $method->getExtensionName(), $method->getName());
        }

        $iterator = (new Collection())->getIterator();
        $iteratorClass = new \ReflectionClass($iterator);
        self::assertTrue($iteratorClass->isInternal());
        self::assertSame('polyspec_orm', $iteratorClass->getExtensionName());
        foreach ($iteratorClass->getMethods(\ReflectionMethod::IS_PUBLIC) as $method) {
            self::assertTrue($method->isInternal(), $method->getName());
            self::assertSame('polyspec_orm', $method->getExtensionName(), $method->getName());
        }
    }

    public function testSharedIdentityVectorsPreserveEveryKeyType(): void
    {
        $seen = [];
        foreach (self::identityCases() as $case) {
            $identity = Collection::identityOf(self::identityValue($case));
            self::assertSame($identity, Collection::identityOf(self::identityValue($case)));
            $expected = match ($case['type']) {
                'text' => 's' . $case['value'],
                'bool' => $case['value'] ? 'b1' : 'b0',
                'int' => 'i' . $case['value'],
                'bytes' => 'x' . $case['hex'],
                'datetime' => 'd2026-10-18 09:30:00.123456',
            };
            self::assertSame($expected, $identity, $case['name']);
            if (isset($case['same_as'])) {
                self::assertSame($seen[$case['same_as']], $identity);
                continue;
            }
            foreach ($seen as $other => $otherIdentity) {
                self::assertNotSame($otherIdentity, $identity, "{$case['name']} collides with $other");
            }
            $seen[$case['name']] = $identity;
        }
    }

    public function testTypedIdentityOrderedReplacementAndArrayViews(): void
    {
        $collection = new Collection();
        $integer = self::model('integer');
        $text = self::model('text');
        $replacement = self::model('replacement');
        $collection->put(7, $integer);
        $collection->put('7', $text);
        $collection->put(7, $replacement);

        self::assertSame(2, count($collection));
        self::assertSame($replacement, $collection->get(7));
        self::assertSame($text, $collection->get('7'));
        self::assertSame([7, '7'], $collection->keys());
        self::assertSame([$replacement, $text], $collection->all());
        self::assertSame([[7, $replacement], ['7', $text]], $collection->entries());
        self::assertSame([['label' => 'replacement'], ['label' => 'text']], $collection->toArray());
        self::assertSame('[{"label":"replacement"},{"label":"text"}]', $collection->toJson());
        self::assertSame([$replacement, $text], $collection->jsonSerialize());
    }

    public function testBoolAndDateTimeKeysRetainTypeAndInstantIdentity(): void
    {
        $collection = new Collection();
        $boolModel = self::model('bool');
        $intModel = self::model('int');
        $dateModel = self::model('date');
        $sameInstant = new DateTimeImmutable('2025-03-04 12:30:01.123456', new DateTimeZone('+01:00'));
        $utcInstant = new DateTimeImmutable('2025-03-04 11:30:01.123456', new DateTimeZone('UTC'));
        $collection->put(true, $boolModel);
        $collection->put(1, $intModel);
        $collection->put($sameInstant, $dateModel);
        $collection->put($utcInstant, self::model('replacement'));

        self::assertSame(3, count($collection));
        self::assertSame($boolModel, $collection->get(true));
        self::assertSame($intModel, $collection->get(1));
        self::assertSame('replacement', $collection->get($sameInstant)?->label);
        self::assertSame($utcInstant, $collection->keys()[2]);
        $iterator = $collection->getIterator();
        $iterator->rewind();
        $iterator->next();
        $iterator->next();
        self::assertSame($utcInstant, $iterator->key());
    }

    public function testStringKeysPreserveEmbeddedNulAndCloneSeparatesArrays(): void
    {
        $collection = new Collection();
        $binaryKey = "a\0b";
        $originalModel = self::model('shared');
        $collection->put($binaryKey, $originalModel);
        $collection->fetchValues(static fn(Model $model): string => $model->toArray()['label']);
        $copy = clone $collection;
        $copy->put('new', self::model('copy'));
        $copy->fetchValues(static fn(Model $model): string => strtoupper($model->toArray()['label']));

        self::assertSame($originalModel, $copy->get($binaryKey));
        self::assertSame([$binaryKey], $collection->keys());
        self::assertSame([$binaryKey, 'new'], $copy->keys());
        self::assertSame(['shared'], $collection->fetchedValues());
        self::assertSame(['SHARED', 'COPY'], $copy->fetchedValues());

        $restored = unserialize(serialize($collection), ['allowed_classes' => true]);
        self::assertInstanceOf(Collection::class, $restored);
        self::assertSame([$binaryKey], $restored->keys());
        self::assertSame('shared', $restored->fetchedValue($binaryKey));
    }

    public function testNullIdentityUsesTheCodecDecodeOrmError(): void
    {
        try {
            Collection::keyOf(null);
            self::fail('SQL NULL cannot identify a collection row');
        } catch (OrmException $exception) {
            self::assertSame(Code::CODEC_DECODE, $exception->code_);
            self::assertSame('CODEC_DECODE: collection row identity contains SQL NULL', $exception->getMessage());
        }
    }

    public function testTypedKeyAndModelArgumentsRejectValuesOutsideTheirDeclaredTypes(): void
    {
        $collection = new Collection();

        try {
            $collection->put(null, self::model('null-key'));
            self::fail('strict callers cannot pass a null collection key');
        } catch (\TypeError) {
            self::assertSame(0, count($collection));
        }

        try {
            $collection->put(1.5, self::model('invalid-key'));
            self::fail('strict callers cannot pass a float collection key');
        } catch (\TypeError) {
            self::assertSame(0, count($collection));
        }

        try {
            $collection->put(1, new \stdClass());
            self::fail('put requires a Model instance');
        } catch (\TypeError) {
            self::assertSame(0, count($collection));
        }
    }

    public function testCollectionOwnedValuesParticipateInCycleCollection(): void
    {
        $collection = new Collection();
        $model = self::model('cycle');
        $model->collectionCycle = $collection;
        $collection->put(1, $model);
        $reference = \WeakReference::create($collection);
        unset($model, $collection);

        gc_collect_cycles();

        self::assertNull($reference->get());
    }

    public function testMalformedSerializedEntryFailsWithoutReadingInvalidZendValues(): void
    {
        $collection = new Collection();
        $property = new \ReflectionProperty(Collection::class, 'items');
        $property->setValue($collection, ['corrupt-slot' => 'not an entry array']);
        $malformed = unserialize(serialize($collection), ['allowed_classes' => true]);
        self::assertInstanceOf(Collection::class, $malformed);

        $this->expectException(\UnexpectedValueException::class);
        $malformed->all();
    }

    public function testMalformedReferencedEntryValuesFailSafely(): void
    {
        $invalidKey = null;
        $invalidModel = 'not a model';
        $entry = [&$invalidKey, &$invalidModel];
        $collection = new Collection();
        (new \ReflectionProperty(Collection::class, 'items'))->setValue($collection, ['slot' => $entry]);

        $this->expectException(\UnexpectedValueException::class);
        $collection->all();
    }

    public function testWeakAndStrictTypedKeyCoercionBoundaries(): void
    {
        $weak = new Collection();
        collectionWeakPut($weak, 2.0, self::model('weak-float'));
        self::assertTrue($weak->has(2));

        $deprecations = [];
        set_error_handler(static function (int $severity, string $message) use (&$deprecations): bool {
            if ($severity === E_DEPRECATED) {
                $deprecations[] = $message;
                return true;
            }
            return false;
        });
        try {
            collectionWeakPut($weak, 3.5, self::model('weak-lossy-float'));
        } finally {
            restore_error_handler();
        }
        self::assertTrue($weak->has(3));
        self::assertCount(1, $deprecations);
        self::assertStringContainsString('Implicit conversion from float 3.5 to int loses precision', $deprecations[0]);

        $stringable = new class implements \Stringable {
            public function __toString(): string { return 'weak-stringable'; }
        };
        collectionWeakPut($weak, $stringable, self::model('weak-stringable'));
        self::assertSame('weak-stringable', $weak->keys()[2]);

        try {
            collectionWeakPut($weak, null, self::model('invalid'));
            self::fail('weak caller must reject null');
        } catch (\TypeError) {
            self::assertCount(3, $weak);
        }

        try {
            $weak->put($stringable, self::model('strict-stringable'));
            self::fail('strict caller must reject Stringable key coercion');
        } catch (\TypeError) {
            self::assertCount(3, $weak);
        }
    }

    public function testIteratorTakesSnapshotAtFirstRewindAndKeepsItDuringMutation(): void
    {
        $collection = new Collection();
        self::assertNull($collection->first());
        self::assertSame([], iterator_to_array($collection));
        $collection->put(1, self::model('first'));
        $iterator = $collection->getIterator();
        self::assertInstanceOf(\Iterator::class, $iterator);
        self::assertTrue((new \ReflectionClass($iterator))->isInternal());
        $collection->put(2, self::model('before-start'));

        $seen = [];
        foreach ($iterator as $key => $model) {
            $seen[$key] = $model->label;
            $collection->put(3, self::model('after-start'));
        }

        self::assertSame([1 => 'first', 2 => 'before-start'], $seen);
        self::assertSame(3, count($collection));

        $iterator->rewind();
        $rewound = [];
        foreach ($iterator as $key => $model) {
            $rewound[$key] = $model->label;
        }
        self::assertSame([1 => 'first', 2 => 'before-start'], $rewound);
    }

    public function testIteratorClonePreservesItsSnapshotAndPosition(): void
    {
        $collection = new Collection();
        $first = self::model('first');
        $second = self::model('second');
        $collection->put(1, $first);
        $collection->put(2, $second);
        $iterator = $collection->getIterator();
        $iterator->rewind();
        self::assertSame($first, $iterator->current());
        $iterator->next();
        $copy = clone $iterator;
        $collection->put(3, self::model('later'));
        $iterator->next();

        self::assertSame(2, $copy->key());
        self::assertSame($second, $copy->current());
        self::assertTrue($copy->valid());
        self::assertFalse($iterator->valid());
    }

    public function testNativeHelpersRejectSerializationWhileCollectionRoundTrips(): void
    {
        $collection = new Collection();
        $collection->put(1, self::model('round-trip'));
        $restored = unserialize(serialize($collection), ['allowed_classes' => true]);
        self::assertInstanceOf(Collection::class, $restored);
        self::assertSame('round-trip', $restored->get(1)?->label);

        $helpers = [$collection->getIterator(), new \Polyspec\Orm\CollectionDeleteCallback()];
        foreach ($helpers as $helper) {
            try {
                serialize($helper);
                self::fail('native helper state must not be serialized');
            } catch (\Exception $exception) {
                self::assertStringContainsString('Serialization of', $exception->getMessage());
            }
        }
    }

    public function testFetchValuesAreAddressedByIdentityAndPropagateCallbackExceptions(): void
    {
        $collection = new Collection();
        $one = self::model('one');
        $collection->put(1, $one);
        $collection->put('1', self::model('text-one'));
        $collection->fetchValues(static fn(Model $model): string => strtoupper($model->toArray()['label']));

        self::assertSame('ONE', $collection->fetchedValue(1));
        self::assertSame(['ONE', 'TEXT-ONE'], $collection->fetchedValues());

        $exception = new \RuntimeException('callback failed');
        try {
            $collection->fetchValues(static function () use ($exception): never { throw $exception; });
            self::fail('fetchValues must propagate the callback exception');
        } catch (\RuntimeException $caught) {
            self::assertSame($exception, $caught);
        }
    }

    public function testConnectAndInvokeReachEachModelAndReturnTheCollection(): void
    {
        $collection = new Collection();
        $first = self::model('first');
        $second = self::model('second');
        $collection->put(1, $first);
        $collection->put(2, $second);
        $db = new Db(null, 'mysql', new Config(), new DateTimeZone('UTC'));

        self::assertSame($collection, $collection->connect($db));
        self::assertSame($db, $first->connectedTo);
        self::assertSame($db, $second->connectedTo);
        self::assertSame($collection, $collection($db));
    }

    public function testDeleteUsesTransactionEntryPointAndEmptyDeleteIsANoop(): void
    {
        $empty = new Collection();
        $empty->delete();
        self::assertSame([], $empty->all());

        $collection = new Collection();
        $model = self::model('unconnected');
        $collection->put(1, $model);
        try {
            $collection->delete(true);
            self::fail('an unconnected model cannot enter a transaction');
        } catch (OrmException $exception) {
            self::assertSame(Code::CONFIG, $exception->code_);
            self::assertSame([], $model->deleted);
        }
    }

    public function testDeleteRunsInTransactionAndRollsBackCallbackFailure(): void
    {
        $pdo = new CollectionFakePdo();
        $db = new Db($pdo, 'mysql', new Config(), new DateTimeZone('UTC'));
        $collection = new Collection();
        $first = self::model('first');
        $second = self::model('second');
        $collection->put('first', $first);
        $collection->put('second', $second);
        $collection->connect($db)->delete(true);

        self::assertSame([true], $first->deleted);
        self::assertSame([true], $second->deleted);
        self::assertSame(['START TRANSACTION', 'COMMIT'], $pdo->statements);
        self::assertFalse($pdo->inTransaction());

        $pdo->statements = [];
        $failure = new \RuntimeException('delete callback failed');
        $failing = new class('failing') extends CollectionFixtureModel {
            public ?\Throwable $failure = null;

            public function deleteRow(bool $recursive): void
            {
                throw $this->failure;
            }
        };
        $failing->failure = $failure;
        $collection = new Collection();
        $collection->put(1, $failing);
        $collection->connect($db);

        try {
            $collection->delete();
            self::fail('delete must propagate a callback exception');
        } catch (\RuntimeException $caught) {
            self::assertSame($failure, $caught);
        }
        self::assertSame(['START TRANSACTION', 'ROLLBACK'], $pdo->statements);
        self::assertFalse($pdo->inTransaction());
    }

    public function testDeleteCallbacksKeepTheirOwnContextAcrossFibers(): void
    {
        $pdo = new CollectionFakePdo();
        $pdo->suspendFirstStart = true;
        $db = new Db($pdo, 'mysql', new Config(), new DateTimeZone('UTC'));
        $left = new Collection();
        $leftModel = self::model('left');
        $left->put('left', $leftModel);
        $left->connect($db);
        $right = new Collection();
        $rightModel = self::model('right');
        $right->put('right', $rightModel);
        $right->connect($db);

        $leftFiber = new \Fiber(static fn() => $left->delete(true));
        $rightFiber = new \Fiber(static fn() => $right->delete(false));
        $leftFiber->start();
        self::assertTrue($leftFiber->isSuspended());
        $rightFiber->start();
        $leftFiber->resume();

        self::assertSame([true], $leftModel->deleted);
        self::assertSame([false], $rightModel->deleted);
        self::assertSame(['START TRANSACTION', 'START TRANSACTION', 'COMMIT', 'COMMIT'], $pdo->statements);
        self::assertFalse($pdo->inTransaction());
    }
}
