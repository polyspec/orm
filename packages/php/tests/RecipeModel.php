<?php

// The generated-model ops of the recipe helper (docs/spec/feature-coverage.md FCV-4 model ops, FCV-14). Each op calls
// the generated model that its model name names, through the connection that model.connect bound. A model or a column
// without an entry here fails the case by name, so no recipe passes on a call that the helper does not make. The trait
// is used by Recipe, so its methods reach the value helpers of Recipe.

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Orm;

trait RecipeModel
{
    /** The connections that model.connect opened; the case closes them when it ends. */
    private static array $modelConnections = [];

    /** The keys that the generated models of the bench set read their encrypted columns with. */
    private const BENCH_AES_KEY = 'bench-salt';
    private const BENCH_BLIND_INDEX_KEY = 'bench-blind-index';

    /** Closes the connections that the model ops of the case opened. */
    private static function closeModelConnections(): void
    {
        foreach (self::$modelConnections as $db) {
            $db->close();
        }
        self::$modelConnections = [];
    }

    /** Runs one model op of s and returns the fields that its expect compares. */
    private static function modelOp(array $s, array $context): array
    {
        if ($s['op'] === 'model.connect') {
            // The case schema is registered on the connection, as the statement-event ops need it (FCV-4, model.connect).
            $db = Orm::connectSchema(
                $context['dsn'],
                $context['schema'],
                new Config(aesKey: self::BENCH_AES_KEY, blindIndexKey: self::BENCH_BLIND_INDEX_KEY),
            );
            self::$modelConnections[] = $db;
            return ['bind' => $db];
        }
        if (!isset($s['connection']) && isset($s['row'])) {
            return self::rowOp($s, $context);
        }
        if (isset(self::TABLE_MODELS[$s['model'] ?? ''])) {
            return self::tableModelOp($s, $context);
        }
        $db = $context['bound'][$s['connection']] ?? null;
        if (!$db instanceof Db) {
            Assert::fail("model op {$s['op']}: connection {$s['connection']} is not bound by model.connect");
        }
        return match ($s['model']) {
            'CompositeAccount' => self::compositeAccountOp($s, $context, $db),
            'Author' => self::authorOp($s, $context, $db),
            default => Assert::fail("model {$s['model']} has no recipe entry"),
        };
    }

    private static function modelValue(mixed $value, array $context): mixed
    {
        return self::nativeValue(self::databaseValue(self::stepArgument($value, $context), $context));
    }

    /** The native values of an object of column names, in column order (every row of a batch sets the same order). */
    private static function modelValues(?array $object, array $context): array
    {
        $values = [];
        foreach ($object ?? [] as $column => $value) {
            $values[$column] = self::modelValue($value, $context);
        }
        ksort($values);
        return $values;
    }

    private static function modelWrapper(mixed $value): array
    {
        return is_int($value) ? ['int' => (string) $value] : ['text' => (string) $value];
    }

    private static function compositeAccountSet(Db $db, array $values): \Polyspec\Orm\Tests\Model\CompositeAccount
    {
        $model = (new \Polyspec\Orm\Tests\Model\CompositeAccount())($db);
        foreach ($values as $column => $value) {
            match ($column) {
                'tenant_id' => $model->setTenantId($value),
                'account_id' => $model->setAccountId($value),
                'name' => $model->setName($value),
                default => Assert::fail("CompositeAccount column $column has no recipe setter"),
            };
        }
        return $model;
    }

    /** The CompositeAccount chain of the equalities of where, joined by and(). */
    private static function compositeAccountFilter(Db $db, array $where): \Polyspec\Orm\Tests\Model\CompositeAccount
    {
        $model = (new \Polyspec\Orm\Tests\Model\CompositeAccount())($db);
        $first = true;
        foreach ($where as $column => $value) {
            if (!$first) {
                $model = $model->and();
            }
            $first = false;
            match ($column) {
                'tenant_id' => $model->tenantId($value),
                'account_id' => $model->accountId($value),
                default => Assert::fail("CompositeAccount column $column has no recipe filter"),
            };
        }
        return $model;
    }

    private static function compositeAccountOp(array $s, array $context, Db $db): array
    {
        $CA = \Polyspec\Orm\Tests\Model\CompositeAccount::class;
        switch ($s['op']) {
            case 'model.create':
                self::compositeAccountSet($db, self::modelValues($s['values'], $context))->create();
                return [];
            case 'model.save':
                self::compositeAccountSet($db, self::modelValues($s['values'], $context))->save();
                return [];
            case 'model.duplicate_create':
                $model = self::compositeAccountSet($db, self::modelValues($s['values'], $context));
                $model->duplication(
                    self::compositeAccountSet($db, self::modelValues($s['duplication'], $context))
                )->create();
                return [];
            case 'model.creates':
                $rows = array_map(
                    static fn (array $row): object => self::compositeAccountSet($db, self::modelValues($row, $context)),
                    $s['rows'],
                );
                $count = (new $CA())($db)->creates($rows, $s['batch']);
                return ['value' => ['int' => (string) $count]];
            case 'model.update':
                $key = self::modelValues($s['key'], $context);
                $row = (new $CA())($db)->getByTenantIdAndAccountId($key['tenant_id'], $key['account_id']);
                if ($row === null) {
                    Assert::fail('model.update: the key names no row');
                }
                foreach (self::modelValues($s['set'], $context) as $column => $value) {
                    if ($column !== 'name') {
                        Assert::fail("CompositeAccount column $column has no recipe update");
                    }
                    $row->setName($value);
                }
                $row->update();
                return [];
            case 'model.delete':
                self::compositeAccountFilter($db, self::modelValues($s['where'], $context))->gets()->delete();
                return [];
            case 'model.count':
                $count = self::compositeAccountFilter($db, self::modelValues($s['where'], $context))->getCount();
                return ['value' => ['int' => (string) $count]];
            case 'model.get_by':
                $key = self::modelValues($s['key'], $context);
                $row = (new $CA())($db)->getByTenantIdAndAccountId($key['tenant_id'], $key['account_id']);
                return ['rows' => $row === null ? [] : [self::compositeAccountCells($row, $s['columns'])]];
            case 'model.query':
                $rows = [];
                foreach (self::compositeAccountFilter($db, self::modelValues($s['where'], $context))->gets() as $row) {
                    $rows[] = self::compositeAccountCells($row, $s['columns']);
                }
                return ['rows' => $rows];
        }
        Assert::fail("OP_UNKNOWN {$s['op']}");
    }

    private static function compositeAccountCells(object $row, array $columns): array
    {
        return array_map(static function (string $column) use ($row): array {
            if ($column !== 'name') {
                Assert::fail("CompositeAccount column $column has no recipe getter");
            }
            return self::modelWrapper($row->getName());
        }, $columns);
    }

    private static function authorOp(array $s, array $context, Db $db): array
    {
        $Author = \Polyspec\Orm\Tests\Model\Author::class;
        switch ($s['op']) {
            case 'model.get_by':
                $key = self::modelValues($s['key'], $context);
                $row = (new $Author())($db)->getBySeq($key['seq']);
                if ($row === null) {
                    return ['rows' => []];
                }
                return ['rows' => [array_map(static function (string $column) use ($row): array {
                    if ($column !== 'read_count') {
                        Assert::fail("Author column $column has no recipe getter");
                    }
                    return self::modelWrapper($row->getReadCount());
                }, $s['columns'])]];
            case 'model.arithmetic':
                if ($s['column'] !== 'read_count') {
                    Assert::fail("Author column {$s['column']} has no recipe arithmetic");
                }
                $key = self::modelValues($s['key'], $context);
                $row = (new $Author())($db)->getBySeq($key['seq']);
                if ($row === null) {
                    Assert::fail('model.arithmetic: the key names no row');
                }
                $amount = self::modelValue($s['amount'], $context);
                if ($s['operation'] === 'plus') {
                    $row->plusReadCount($amount);
                } else {
                    $row->minusReadCount($amount);
                }
                $row->update();
                return [];
        }
        Assert::fail("OP_UNKNOWN {$s['op']}");
    }
}
