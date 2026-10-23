<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use ReflectionClass;
use Polyspec\Orm\Chain;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Registry;

#[Small]
final class ChainNativeSurfaceTest extends TestCase
{
    private const MANIFEST = "dbspec 1\n";
    private static string $manifestHash;

    public static function setUpBeforeClass(): void
    {
        self::$manifestHash = 'sha256:' . hash('sha256', self::MANIFEST);
        Registry::generated(self::$manifestHash, self::MANIFEST);
        Registry::register(ChainNativeRegistryFixture::class);
    }

    private function meta(string $entity, array $columns): array
    {
        return ['entity' => $entity, 'manifest_hash' => 'chain-test', 'columns' => $columns];
    }

    private function column(string $type): array
    {
        return ['type' => $type, 'codec' => []];
    }

    public function test_native_class_owns_the_complete_public_chain_surface(): void
    {
        $class = new ReflectionClass(Chain::class);
        self::assertTrue($class->isInternal());
        self::assertTrue($class->isFinal());
        foreach ([
            'words', 'pascal', 'snake', 'functionColumn', 'parse', 'parseMeta', 'order', 'orderMeta',
            'pair', 'pairMeta', 'columnName', 'schemaColumnName',
        ] as $method) {
            $reflection = $class->getMethod($method);
            self::assertTrue($reflection->isInternal(), $method);
            self::assertTrue($reflection->isStatic(), $method);
            self::assertSame($class->getName(), $reflection->getDeclaringClass()->getName(), $method);
        }
        self::assertSame([
            '' => 'eq', 'ne' => 'not_eq', 'gt' => 'gt', 'lt' => 'lt', 'ge' => 'gte', 'le' => 'lte',
            'lk' => 'contains', 'lb' => 'contains_binary', 'between' => 'between',
        ], Chain::ENGINE_OP);
    }

    public function test_words_and_name_conversions_keep_the_chain_grammar(): void
    {
        self::assertSame(['Created', 'At', 'And', 'Owner', 'Id'], Chain::words('CreatedAtAndOwnerId'));
        self::assertSame('CreatedAt', Chain::pascal('created_at'));
        self::assertSame('created_at', Chain::snake('CreatedAt'));
        self::assertSame('createdat', Chain::snake('createdat'));
    }

    public function test_native_parser_accepts_connectors_comparisons_and_tuples(): void
    {
        $meta = $this->meta('User', [
            'id' => $this->column('i64'), 'age' => $this->column('i32'), 'active' => $this->column('bool'),
        ]);
        $schema = [$meta];
        self::assertSame([
            ['conn' => '', 'op' => 'gt', 'column' => 'age', 'columns' => [], 'compare' => ''],
            ['conn' => 'and', 'op' => '', 'column' => 'active', 'columns' => [], 'compare' => ''],
            ['conn' => 'or', 'op' => '', 'column' => 'id', 'columns' => [], 'compare' => ''],
        ], Chain::parseMeta($meta, $schema, 'GtAgeAndActiveOrId'));
        self::assertSame([
            ['conn' => '', 'op' => '', 'column' => 'age', 'columns' => [], 'compare' => 'id'],
        ], Chain::parseMeta($meta, $schema, 'AgeEqId'));
        self::assertSame([
            ['conn' => '', 'op' => 'tuple', 'column' => '', 'columns' => ['id', 'age'], 'compare' => ''],
        ], Chain::parseMeta($meta, $schema, 'TupleIdWithAge'));
        self::assertSame([
            ['conn' => '', 'op' => 'ne_tuple', 'column' => '', 'columns' => ['id', 'age'], 'compare' => ''],
        ], Chain::parseMeta($meta, $schema, 'NeTupleIdWithAge'));
    }

    public function test_native_parser_rejects_unknown_and_disallowed_operators_as_config(): void
    {
        $meta = $this->meta('User', ['active' => $this->column('bool')]);
        try {
            Chain::parseMeta($meta, [$meta], 'Missing');
            self::fail('Unknown condition was accepted');
        } catch (OrmException $exception) {
            self::assertSame('CONFIG', $exception->code_);
            self::assertSame('CONFIG: Missing is not a column of User', $exception->getMessage());
        }
        try {
            Chain::parseMeta($meta, [$meta], 'TupleActive');
            self::fail('One-column tuple was accepted');
        } catch (OrmException $exception) {
            self::assertSame('CONFIG', $exception->code_);
            self::assertSame('CONFIG: TupleActive: CONFIG: a tuple needs two or more columns of User joined by With', $exception->getMessage());
        }
        try {
            Chain::orderMeta($meta, 'Active');
            self::fail('Incomplete order key was accepted');
        } catch (OrmException $exception) {
            self::assertSame('CONFIG', $exception->code_);
            self::assertSame('CONFIG: orderByActive: each key needs a column and Asc or Desc', $exception->getMessage());
        }
        try {
            Chain::parseMeta($meta, [$meta], 'GtActive');
            self::fail('Invalid boolean comparison was accepted');
        } catch (OrmException $exception) {
            self::assertSame('CONFIG', $exception->code_);
            self::assertSame('CONFIG: GtActive: CONFIG: User.active does not accept the gt operator', $exception->getMessage());
        }
    }

    public function test_native_order_pair_and_column_lookup_return_exact_names(): void
    {
        $left = $this->meta('User', ['user_id' => $this->column('i64'), 'age' => $this->column('i32')]);
        $left['manifest_hash'] = self::$manifestHash;
        $right = $this->meta('Order', ['owner_id' => $this->column('i64')]);
        self::assertSame([
            ['column' => 'age', 'desc' => true], ['column' => 'user_id', 'desc' => false],
        ], Chain::orderMeta($left, 'AgeDescAndUserIdAsc'));
        self::assertSame(['user_id', 'owner_id'], Chain::pairMeta($left, $right, [$left, $right], 'UserIdWithOwnerId'));
        self::assertSame('user_id', Chain::columnName($left, 'UserId'));
        self::assertSame('seq', Chain::schemaColumnName(self::$manifestHash, 'Seq'));
        self::assertSame([['conn' => '', 'op' => '', 'column' => 'seq', 'columns' => [], 'compare' => '']], Chain::parse(ChainNativeRegistryFixture::class, 'Seq'));
        self::assertSame([['column' => 'seq', 'desc' => true]], Chain::order(ChainNativeRegistryFixture::class, 'SeqDesc'));
        self::assertSame(['seq', 'seq'], Chain::pair(null, ChainNativeRegistryFixture::meta(), 'SeqWithSeq'));
        self::assertTrue(Chain::functionColumn(['codec' => [], 'type' => 'date']));
        self::assertFalse(Chain::functionColumn(['codec' => ['aes'], 'type' => 'date']));
    }
}

final class ChainNativeRegistryFixture
{
    public static function meta(): array
    {
        return [
            'entity' => 'chain_native_fixture',
            'manifest_hash' => 'sha256:' . hash('sha256', "dbspec 1\n"),
            'columns' => ['seq' => ['type' => 'i64', 'codec' => []]],
        ];
    }
}
