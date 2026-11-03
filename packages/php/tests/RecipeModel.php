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

    /** The Author equality conditions that the recipes name, by column: the condition method of the chain grammar. */
    private const AUTHOR_CONDITIONS = [
        'seq' => 'seq',
        'user_seq' => 'userSeq',
        'service_seq' => 'serviceSeq',
        'service_region_seq' => 'serviceRegionSeq',
        'service_member_seq' => 'serviceMemberSeq',
    ];

    /** The Author columns that a recipe may read, by column: the method that adds it to the projection, and its getter. */
    private const AUTHOR_COLUMNS = [
        'seq' => ['addColumnSeq', 'getSeq'],
        'name' => ['addColumnName', 'getName'],
        'user_seq' => ['addColumnUserSeq', 'getUserSeq'],
        'service_seq' => ['addColumnServiceSeq', 'getServiceSeq'],
        'service_region_seq' => ['addColumnServiceRegionSeq', 'getServiceRegionSeq'],
        'service_member_seq' => ['addColumnServiceMemberSeq', 'getServiceMemberSeq'],
        'read_count' => ['addColumnReadCount', 'getReadCount'],
        'like_count' => ['addColumnLikeCount', 'getLikeCount'],
        'uuid' => ['addColumnUuid', 'getUuid'],
        'aes_key_version' => ['addColumnAesKeyVersion', 'getAesKeyVersion'],
        'aes_hex_email' => ['addColumnAesHexEmail', 'getAesHexEmail'],
        'aes_hex_phone' => ['addColumnAesHexPhone', 'getAesHexPhone'],
    ];

    /** The Author orders that a recipe may name, by column: a name is ascending, and a name with a leading "-" is descending (FCV-4). */
    private const AUTHOR_ORDERS = [
        'seq' => 'orderBySeqAsc', 'name' => 'orderByNameAsc', '-seq' => 'orderBySeqDesc', '-name' => 'orderByNameDesc',
    ];

    /** Closes the connections that the model ops of the case opened. */
    private static function closeModelConnections(): void
    {
        foreach (self::$modelConnections as $db) {
            $db->close();
        }
        self::$modelConnections = [];
    }

    /**
     * The audit source of the audit_source of a model.connect (FCV-4, CFG-8): it returns its values or fails with its
     * own error.
     */
    private static function auditSourceOf(array $s, array $context): ?\Closure
    {
        $spec = $s['audit_source'] ?? null;
        if ($spec === null) {
            return null;
        }
        if ($spec['fail'] ?? false) {
            return static fn (): array => throw new CallbackFailed('the audit source failed');
        }
        $values = self::mapAssignments($spec['values'], $context);
        return static fn (): array => $values;
    }

    /** Runs one model op of s and returns the fields that its expect compares. */
    private static function modelOp(array $s, array $context): array
    {
        if ($s['op'] === 'model.connect') {
            // The case schema is registered on the connection, as the statement-event ops need it
            // (FCV-4, model.connect).
            // A step with aes_keyring connects with that keyring in place of the bench key (FCV-4, model.connect).
            $source = self::auditSourceOf($s, $context);
            $config = isset($s['aes_keyring'])
                ? new Config(
                    blindIndexKey: self::BENCH_BLIND_INDEX_KEY,
                    aesVersion: self::aesKeyring($s['aes_keyring'])->currentVersion,
                    aesKeys: self::aesKeys($s['aes_keyring']),
                    auditSource: $source,
                )
                : new Config(aesKey: self::BENCH_AES_KEY, blindIndexKey: self::BENCH_BLIND_INDEX_KEY, auditSource: $source);
            $dsn = self::connectDsn($s['dsn'] ?? null, $context['database'], $context['dsn']);
            $db = Orm::connectSchema($dsn, $context['schema'], $config);
            self::$modelConnections[] = $db;
            return ['bind' => $db];
        }
        if ($context['tablePath']) {
            return self::tableModelOp($s, $context);
        }
        $db = $context['bound'][$s['connection']] ?? null;
        if (!$db instanceof Db) {
            Assert::fail("model op {$s['op']}: connection {$s['connection']} is not bound by model.connect");
        }
        return match ($s['model']) {
            'CompositeAccount' => self::compositeAccountOp($s, $context, $db),
            'CompositeMembership' => self::compositeMembershipOp($s, $context, $db),
            'Author' => self::authorOp($s, $context, $db),
            'User' => self::userOp($s, $context, $db),
            'NoteReader' => self::noteReaderOp($s, $context, $db),
            default => Assert::fail("model {$s['model']} has no recipe entry"),
        };
    }

    /** The affected count of the last write on $db, the value that the expect of a model write names (F15, PRT-61). */
    private static function affected(Db $db): array
    {
        // The package autoloader does not map the test entry point.
        require_once dirname(__DIR__) . '/testing/Faults.php';
        return ['value' => ['int' => (string) \Polyspec\Orm\Testing\Faults::lastAffected($db)]];
    }

    /** The DSN that a model.connect opens (FCV-4): the case database, unless its dsn is case-socket or the DSN text. */
    public static function connectDsn(?string $dsn, string $database, string $caseDsn, ?string $socket = null): string
    {
        if ($dsn === null || $dsn === 'case') {
            return $caseDsn;
        }
        if ($dsn !== 'case-socket') {
            return $dsn;
        }
        if ($database !== 'mysql') {
            Assert::fail("dsn case-socket needs mysql, not $database");
        }
        $socket ??= (string) getenv('ORM_TEST_MYSQL_SOCKET');
        if ($socket === '') {
            Assert::fail('dsn case-socket: ORM_TEST_MYSQL_SOCKET is unset; run make orm-test-servers');
        }
        if (preg_match('#^mysql://([^@/]+)@[^/]+/([^?]+)#', $caseDsn, $match) !== 1) {
            Assert::fail("dsn case-socket: the case DSN $caseDsn is not a mysql DSN");
        }
        return "mysql://{$match[1]}@localhost/{$match[2]}?socket=$socket";
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

    /** The order and getter methods of the CompositeAccount model ops, by recipe column. */
    private const COMPOSITE_ORDERS = [
        'tenant_id' => 'orderByTenantIdAsc',
        'account_id' => 'orderByAccountIdAsc',
        'name' => 'orderByNameAsc',
    ];
    private const COMPOSITE_GETTERS = [
        'tenant_id' => 'getTenantId', 'account_id' => 'getAccountId', 'name' => 'getName',
    ];
    /** The getter methods of the CompositeMembership columns that a relation of CompositeAccount reads. */
    private const COMPOSITE_MEMBERSHIP_GETTERS = [
        'tenant_id' => 'getTenantId', 'account_id' => 'getAccountId', 'role' => 'getRole',
    ];
    /** The lock methods of a model.query, by recipe lock name. */
    private const LOCKS = [
        'update' => 'forUpdate',
        'share' => 'forShare',
        'update_nowait' => 'forUpdateNoWait',
        'share_nowait' => 'forShareNoWait',
    ];

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
                return self::affected($db);
            case 'model.delete':
                self::compositeAccountFilter($db, self::modelValues($s['where'], $context))->gets()->delete();
                return self::affected($db);
            case 'model.count':
                $count = self::compositeAccountFilter($db, self::modelValues($s['where'], $context))->getCount();
                return ['value' => ['int' => (string) $count]];
            case 'model.get_by':
                $key = self::modelValues($s['key'], $context);
                $row = (new $CA())($db)->getByTenantIdAndAccountId($key['tenant_id'], $key['account_id']);
                return ['rows' => $row === null ? [] : [self::compositeAccountCells($row, $s['columns'])]];
            case 'model.query':
                $where = self::modelValues($s['where'] ?? null, $context);
                $model = self::compositeAccountFilter($db, $where);
                if (isset($s['tuples'])) {
                    // The tuples are joined by and() to the equalities of where that come before them (DSL-82).
                    if ($where !== []) {
                        $model = $model->and();
                    }
                    $model = $model->tupleTenantIdWithAccountId(self::compositeAccountTuples($s['tuples'], $context));
                }
                foreach ($s['order'] ?? [] as $column) {
                    $order = self::COMPOSITE_ORDERS[$column]
                        ?? Assert::fail("CompositeAccount column $column has no recipe order");
                    $model = $model->$order();
                }
                // The relation of the query (INT-87): each child row gives one output row.
                if (isset($s['relation'])) {
                    $child = self::compositeMembershipRelation($s['relation'], $db);
                    $model = ($s['relation']['many'] ?? false) ? $model->relations($child) : $model->relation($child);
                }
                // The lock of a model.query (INT-47): a lock outside a transaction is refused with CONFIG.
                if (isset($s['lock'])) {
                    $lock = self::LOCKS[$s['lock']] ?? Assert::fail("lock {$s['lock']} is not a lock of the recipe");
                    $model = $model->$lock();
                }
                $rows = [];
                foreach ($model->gets() as $row) {
                    $cells = self::compositeAccountCells($row, $s['columns']);
                    if (!isset($s['relation'])) {
                        $rows[] = $cells;
                        continue;
                    }
                    // A parent row with no child row is left out of the result.
                    foreach (self::compositeMembershipChildren($row, $s['relation']) as $child) {
                        $rows[] = [...$cells, ...self::compositeMembershipCells($child, $s['relation']['columns'])];
                    }
                }
                return ['rows' => $rows];
        }
        Assert::fail("OP_UNKNOWN {$s['op']}");
    }

    /** The CompositeAccount tuple groups of a model.query: each group holds the key values in the recipe column order. */
    private static function compositeAccountTuples(array $tuples, array $context): array
    {
        if (($tuples['columns'] ?? null) !== ['tenant_id', 'account_id']) {
            Assert::fail('CompositeAccount tuple ' . implode(',', $tuples['columns'] ?? []) . ' has no recipe filter');
        }
        $groups = [];
        foreach ($tuples['values'] as $tuple) {
            if (count($tuple) !== 2) {
                Assert::fail('a CompositeAccount tuple has ' . count($tuple) . ' values, not 2');
            }
            $groups[] = [self::modelValue($tuple[0], $context), self::modelValue($tuple[1], $context)];
        }
        return $groups;
    }

    /**
     * The CompositeMembership relation of a CompositeAccount query: one match call per pair in the written order,
     * connected to the connection of the query when connect is true (INT-87).
     */
    private static function compositeMembershipRelation(
        array $relation,
        Db $db,
    ): \Polyspec\Orm\Tests\Model\CompositeMembership {
        if (($relation['model'] ?? null) !== 'CompositeMembership') {
            Assert::fail("CompositeAccount relation {$relation['model']} has no recipe entry");
        }
        $child = new \Polyspec\Orm\Tests\Model\CompositeMembership();
        foreach ($relation['match'] as $pair) {
            $child = match ($pair) {
                ['tenant_id', 'tenant_id'] => $child->matchTenantIdWithTenantId(),
                ['account_id', 'account_id'] => $child->matchAccountIdWithAccountId(),
                default => Assert::fail('CompositeMembership match ' . implode(',', $pair) . ' has no recipe entry'),
            };
        }
        $alias = $relation['alias'] ?? null;
        if ($alias === 'memberships') {
            $child = $child->aliasMemberships();
        } elseif ($alias !== null) {
            Assert::fail("CompositeMembership alias $alias has no recipe entry");
        }
        if ($relation['connect']) {
            $child->connect($db);
        }
        return $child;
    }

    /**
     * The CompositeMembership rows of one parent: through the generated getter of the alias, or of the result name of a
     * relation without one. A parent without a child gives none.
     */
    private static function compositeMembershipChildren(object $row, array $relation): array
    {
        $many = $relation['many'] ?? false;
        $result = match (true) {
            ($relation['alias'] ?? null) === 'memberships' => $row->getMemberships(),
            $many => $row->getCompositeMembershipModels(),
            default => $row->getCompositeMembershipModel(),
        };
        if ($result === null) {
            return [];
        }
        return $many ? iterator_to_array($result, false) : [$result];
    }

    private static function compositeAccountCells(object $row, array $columns): array
    {
        return array_map(static function (string $column) use ($row): array {
            $getter = self::COMPOSITE_GETTERS[$column]
                ?? Assert::fail("CompositeAccount column $column has no recipe getter");
            return self::modelWrapper($row->$getter());
        }, $columns);
    }

    /** The recipe wrappers of the named columns of one CompositeMembership row, in the order of columns. */
    private static function compositeMembershipCells(object $row, array $columns): array
    {
        return array_map(static function (string $column) use ($row): array {
            $getter = self::COMPOSITE_MEMBERSHIP_GETTERS[$column]
                ?? Assert::fail("CompositeMembership column $column has no recipe getter");
            return self::modelWrapper($row->$getter());
        }, $columns);
    }

    private static function compositeMembershipSet(Db $db, array $values): \Polyspec\Orm\Tests\Model\CompositeMembership
    {
        $model = (new \Polyspec\Orm\Tests\Model\CompositeMembership())($db);
        foreach ($values as $column => $value) {
            match ($column) {
                'tenant_id' => $model->setTenantId($value),
                'account_id' => $model->setAccountId($value),
                'role' => $model->setRole($value),
                default => Assert::fail("CompositeMembership column $column has no recipe setter"),
            };
        }
        return $model;
    }

    /** Runs the model ops of the composite keys recipe on CompositeMembership: model.creates and model.count by tenant_id. */
    private static function compositeMembershipOp(array $s, array $context, Db $db): array
    {
        switch ($s['op']) {
            case 'model.creates':
                $rows = array_map(
                    static fn (array $row): object => self::compositeMembershipSet(
                        $db,
                        self::modelValues($row, $context),
                    ),
                    $s['rows'],
                );
                $count = (new \Polyspec\Orm\Tests\Model\CompositeMembership())($db)->creates($rows, $s['batch']);
                return ['value' => ['int' => (string) $count]];
            case 'model.count':
                $model = (new \Polyspec\Orm\Tests\Model\CompositeMembership())($db);
                $first = true;
                foreach (self::modelValues($s['where'], $context) as $column => $value) {
                    if ($column !== 'tenant_id') {
                        Assert::fail("CompositeMembership column $column has no recipe filter");
                    }
                    if (!$first) {
                        $model = $model->and();
                    }
                    $first = false;
                    $model->tenantId($value);
                }
                return ['value' => ['int' => (string) $model->getCount()]];
        }
        Assert::fail("op {$s['op']} has no CompositeMembership entry");
    }

    /** The Author chain of the equalities of where, joined by and() in the order of their column names, then the projection. */
    private static function authorChain(Db $db, array $where, array $columns): \Polyspec\Orm\Tests\Model\Author
    {
        $model = (new \Polyspec\Orm\Tests\Model\Author())($db);
        $first = true;
        // The int equalities come first in name order; the bool equality of is_close is andIsClose after them (the
        // chain
        // has no bool condition that opens it). The equalities are ANDed, so the order of the conditions does not
        // change
        // the rows.
        $ints = array_filter($where, static fn($value) => !is_bool($value));
        $bools = array_filter($where, static fn($value) => is_bool($value));
        ksort($ints);
        ksort($bools);
        foreach ([...$ints, ...$bools] as $column => $value) {
            if (is_bool($value)) {
                if ($column !== 'is_close' || $first) {
                    Assert::fail(
                        "Author column $column: a bool equality needs the is_close column after an int equality"
                    );
                }
                $model = $model->andIsClose($value);
                continue;
            }
            if (!isset(self::AUTHOR_CONDITIONS[$column])) {
                Assert::fail("Author column $column has no recipe condition");
            }
            if (!is_int($value)) {
                Assert::fail("Author column $column: want an int wrapper");
            }
            if (!$first) {
                $model = $model->and();
            }
            $first = false;
            $method = self::AUTHOR_CONDITIONS[$column];
            $model->$method($value);
        }
        if ($columns !== []) {
            $model->removeAllColumns();
            foreach ($columns as $column) {
                if (!isset(self::AUTHOR_COLUMNS[$column])) {
                    Assert::fail("Author column $column has no recipe column");
                }
                $add = self::AUTHOR_COLUMNS[$column][0];
                $model->$add();
            }
        }
        return $model;
    }

    /** The recipe wrappers of the named columns of one row, in the order of columns. */
    private static function authorCells(object $row, array $columns): array
    {
        return array_map(
            static fn (string $column): array => self::modelWrapper($row->{self::AUTHOR_COLUMNS[$column][1]}()),
            $columns,
        );
    }

    private static function authorOp(array $s, array $context, Db $db): array
    {
        $Author = \Polyspec\Orm\Tests\Model\Author::class;
        switch ($s['op']) {
            case 'model.save':
                // A set of the key and the named columns, with no read before it, then one save.
                $values = self::modelValues($s['values'], $context);
                (new $Author())($db)->setSeq($values['seq'])->setName($values['name'])->save();
                return [];
            case 'model.query':
                $model = self::authorChain($db, self::modelValues($s['where'] ?? null, $context), $s['columns']);
                foreach ($s['order'] ?? [] as $column) {
                    if (!isset(self::AUTHOR_ORDERS[$column])) {
                        Assert::fail("Author column $column has no recipe order");
                    }
                    $order = self::AUTHOR_ORDERS[$column];
                    $model->$order();
                }
                $offset = $s['offset'] ?? 0;
                $limit = $s['limit'] ?? 0;
                if ($limit > 0 || $offset > 0) {
                    $model->limit($offset, $limit);
                }
                $rows = [];
                foreach ($model->gets() as $row) {
                    $rows[] = self::authorCells($row, $s['columns']);
                }
                return ['rows' => $rows];
            case 'model.count':
                $count = self::authorChain($db, self::modelValues($s['where'] ?? null, $context), [])->getCount();
                return ['value' => ['int' => (string) $count]];
            case 'model.get_by':
                // The key and the where are one chain: the equalities, the column projection, then the terminal get.
                $where = isset($s['where']) ? $s['where'] : $s['key'];
                $row = self::authorChain($db, self::modelValues($where, $context), $s['columns'])->get();
                return ['rows' => $row === null ? [] : [self::authorCells($row, $s['columns'])]];
            case 'model.update':
                // The row of key, its set columns changed, then one update of the row.
                $row = self::authorChain($db, self::modelValues($s['key'], $context), [])->get();
                if ($row === null) {
                    Assert::fail('Author update: the key names no row');
                }
                foreach (self::modelValues($s['set'], $context) as $column => $value) {
                    if ($column === 'like_count' && is_int($value)) {
                        $row->setLikeCount($value);
                    } elseif ($column === 'uuid' && is_string($value)) {
                        $row->setUuid($value);
                    } else {
                        Assert::fail("Author column $column has no recipe update");
                    }
                }
                $row->update();
                return [];
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

    /** Runs model.delete of s on the User model: the rows of where (seq only), each deleted with the collection. */
    private static function userOp(array $s, array $context, Db $db): array
    {
        if ($s['op'] !== 'model.delete') {
            Assert::fail("op {$s['op']} has no User entry");
        }
        $where = self::modelValues($s['where'], $context);
        if (array_keys($where) !== ['seq'] || !is_int($where['seq'])) {
            Assert::fail('User delete: the recipe condition is seq only');
        }
        (new \Polyspec\Orm\Tests\Model\User())($db)->seq($where['seq'])->gets()->delete();
        return [];
    }

    /**
     * Runs model.query of s on the NoteReader model with its relation to the external SharedNote model: each row of
     * NoteReader in seq order with the title of its SharedNote row, which a row whose relation is missing leaves out.
     */
    private static function noteReaderOp(array $s, array $context, Db $db): array
    {
        $relation = $s['relation'] ?? null;
        if ($s['op'] !== 'model.query' || !is_array($relation)) {
            Assert::fail("op {$s['op']} has no NoteReader entry");
        }
        if (
            ($relation['model'] ?? null) !== 'SharedNote'
            || ($relation['match'] ?? null) !== [['shared_note_seq', 'seq']]
            || $s['columns'] !== ['seq']
            || ($relation['columns'] ?? null) !== ['title']
        ) {
            Assert::fail('NoteReader relation has no recipe entry');
        }
        $rows = [];
        $query = (new \Polyspec\Orm\Tests\Model\NoteReader())($db)
            ->relation((new \Polyspec\Orm\Tests\Model\SharedNote())->matchSharedNoteSeqWithSeq())
            ->orderBySeqAsc();
        foreach ($query->gets() as $row) {
            $note = $row->getSharedNoteModel();
            if ($note === null) {
                continue;
            }
            $rows[] = [self::modelWrapper($row->toArray()['seq']), self::modelWrapper($note->toArray()['title'])];
        }
        return ['rows' => $rows];
    }
}
