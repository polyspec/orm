<?php
declare(strict_types=1);

namespace Orm;

/**
 * A model is both the query under construction and a loaded row. Generated
 * classes add typed column getters and setters and the model metadata; every
 * other method name is resolved at call time with the grammar of docs/dsl.md.
 */
abstract class Model implements \JsonSerializable
{
    private ?Db $conn = null;
    /** the model a group callback stands for */
    private ?Model $groupOf = null;
    private ?\Throwable $error = null;

    /** @var array{items: list<array>, pending: string} */
    private array $where = ['items' => [], 'pending' => ''];
    /** @var list<array>|null */
    private ?array $on = null;
    /** @var list<array{kind: string, left: string, right: string, child: Model}> */
    private array $joins = [];
    /** @var list<array{many: bool, child: Model}> */
    private array $relations = [];
    private string $columnMode = '';
    /** @var list<string> */
    private array $addColumns = [];
    /** @var list<string> */
    private array $removeColumns = [];
    /** @var array<string, array> added output columns in order */
    private array $outputs = [];
    /** @var list<array> */
    private array $order = [];
    /** @var list<string> */
    private array $groupBy = [];
    /** @var list<string> */
    private array $groupRaw = [];
    private ?array $limit = null;
    private string $index = '';
    private string $lock = '';
    private string $aggFn = '';
    private string $agg = '';

    private string $matchLeft = '';
    private string $matchRight = '';
    private string $alias = '';
    private bool $parentNode = false;
    private ?array $possible = null;
    private int $groupLimit = 0;
    private bool $deleteLock = false;
    private string $keyName = '';
    private ?\Closure $fetchKey = null;
    private ?\Closure $fetchValue = null;

    /** @var array<string, array> stored column changes in order */
    private array $sets = [];
    /** @var array<string, mixed> values attached with new<Name> */
    private array $news = [];
    private ?Model $duplication = null;

    /** @var array<string, mixed> typed column values */
    private array $values = [];
    /**
     * @var array{loaded: bool, names: list<string>, hidden: array<string, bool>, original: array<string, mixed>,
     *     extra: array<string, mixed>, related: array<string, mixed>, cascade: array<string, bool>, flat: list<string>}|null
     */
    private ?array $row = null;

    /**
     * The model metadata: entity, pk, auto, updated, aes_version, columns
     * (name => [type, nullable, styles]), fulltext, indexes.
     */
    abstract public static function meta(): array;

    // ---- connection and fixed builder methods ----

    /** Sets the connection of the model or row. */
    public function connect(Db $db): static
    {
        if ($this->groupOf !== null) {
            $this->fail('connect is not allowed inside a group callback');
            return $this;
        }
        $this->conn = $db;
        return $this;
    }

    /** Short form of connect. */
    public function __invoke(Db $db): static
    {
        return $this->connect($db);
    }

    private function fail(string $message, string $code = Code::CONFIG): void
    {
        $this->error ??= new OrmException($code, $message);
    }

    private function subject(): Model
    {
        $m = $this;
        while ($m->groupOf !== null) {
            $m = $m->groupOf;
        }
        return $m;
    }

    private function addItem(string $conn, array $node): void
    {
        $g = &$this->where;
        if ($g['pending'] !== '' && $conn !== '') {
            $this->fail("connector $conn follows connector {$g['pending']}");
            return;
        }
        if ($g['pending'] !== '') {
            $conn = $g['pending'];
            $g['pending'] = '';
        }
        // A connector at the start has nothing to join, so it is dropped: the
        // first condition or group carries no AND or OR.
        if ($g['items'] === []) {
            $conn = '';
        }
        if ($g['items'] !== [] && $conn === '') {
            $this->fail('condition without and/or after another condition');
            return;
        }
        $node['conn'] = $conn;
        $g['items'][] = $node;
    }

    /**
     * and() joins the next condition with AND, and(fn) opens an AND group, and
     * and($model) places the conditions of a joined model.
     */
    public function and(mixed ...$args): static
    {
        return $this->connector('and', $args);
    }

    /** The OR form of and(). */
    public function or(mixed ...$args): static
    {
        return $this->connector('or', $args);
    }

    private function connector(string $conn, array $args): static
    {
        if (count($args) === 0) {
            if ($this->where['pending'] !== '') {
                $this->fail("connector $conn follows connector {$this->where['pending']}");
            } else {
                $this->where['pending'] = $conn;
            }
            return $this;
        }
        if (count($args) > 1) {
            $this->fail("$conn accepts at most one argument");
            return $this;
        }
        $arg = $args[0];
        if ($arg instanceof \Closure) {
            $g = new static();
            $g->groupOf = $this;
            $arg($g);
            if ($g->error !== null) {
                $this->error ??= $g->error;
                return $this;
            }
            if ($g->where['items'] === []) {
                $this->fail("$conn group callback added no condition");
            } elseif ($g->where['pending'] !== '') {
                $this->fail("connector {$g->where['pending']} without a following condition");
            } else {
                $this->addItem($conn, ['group' => $g->where['items']]);
            }
            return $this;
        }
        if ($arg instanceof Model) {
            if ($arg === $this->subject()) {
                $this->fail("$conn cannot place the model inside itself");
            } else {
                $this->addItem($conn, ['joined' => $arg]);
            }
            return $this;
        }
        $this->fail("$conn accepts a callback or a joined model, not " . get_debug_type($arg));
        return $this;
    }

    /** A raw first condition; `{column}` references columns of the model. */
    public function raw(string $sql, array $binds = []): static
    {
        $this->addItem('', ['raw' => [$sql, array_values($binds)]]);
        return $this;
    }

    public function andRaw(string $sql, array $binds = []): static
    {
        $this->addItem('and', ['raw' => [$sql, array_values($binds)]]);
        return $this;
    }

    public function orRaw(string $sql, array $binds = []): static
    {
        $this->addItem('or', ['raw' => [$sql, array_values($binds)]]);
        return $this;
    }

    /** Sets the join ON conditions with a callback that receives the join child. */
    public function on(\Closure $fn): static
    {
        if ($this->groupOf !== null) {
            $this->fail('on is not allowed inside a group callback');
            return $this;
        }
        $g = new static();
        $g->groupOf = $this;
        $fn($g);
        if ($g->error !== null) {
            $this->error ??= $g->error;
        } elseif ($g->where['pending'] !== '') {
            $this->fail("connector {$g->where['pending']} without a following condition");
        } elseif ($g->where['items'] === []) {
            $this->fail('on callback added no condition');
        } else {
            $this->on = $g->where['items'];
        }
        return $this;
    }

    /** Attaches one related row loaded by a separate query. */
    public function relation(Model $child): static
    {
        return $this->addRelation(false, $child);
    }

    /** Attaches related rows loaded by a separate query. */
    public function relations(Model $child): static
    {
        return $this->addRelation(true, $child);
    }

    private function addRelation(bool $many, Model $child): static
    {
        if ($this->groupOf !== null) {
            $this->fail('relation is not allowed inside a group callback');
        } elseif ($child->matchLeft === '') {
            $this->fail('relation child ' . $child::meta()['entity'] . ' requires match<L>With<R>()');
        } else {
            $this->relations[] = ['many' => $many, 'child' => $child];
        }
        return $this;
    }

    public function limit(int $offset, int $count): static
    {
        if ($offset < 0 || $count < 1) {
            $this->fail('limit requires a non-negative offset and a positive count');
        } else {
            $this->limit = ['offset' => $offset, 'count' => $count];
        }
        return $this;
    }

    public function orderByRandom(): static
    {
        $this->order[] = ['random' => true];
        return $this;
    }

    /** A raw order expression, written with its direction. */
    public function orderByRaw(string $sql): static
    {
        $this->order[] = ['expr' => $sql];
        return $this;
    }

    public function groupByRaw(string $sql): static
    {
        $this->groupRaw[] = $sql;
        return $this;
    }

    /** Keeps only primary and foreign keys. */
    public function removeAllColumns(): static
    {
        $this->columnMode = 'none';
        return $this;
    }

    public function addAllColumns(): static
    {
        $this->columnMode = 'all';
        return $this;
    }

    public function parentNode(): static
    {
        $this->parentNode = true;
        return $this;
    }

    public function groupLimit(int $count): static
    {
        if ($count < 1) {
            $this->fail('groupLimit requires a positive count');
        } else {
            $this->groupLimit = $count;
        }
        return $this;
    }

    public function deleteLock(): static
    {
        $this->deleteLock = true;
        return $this;
    }

    /** @param \Closure(static): (int|string) $fn */
    public function fetchKey(\Closure $fn): static
    {
        $this->fetchKey = $fn;
        return $this;
    }

    /** @param \Closure(static): mixed $fn */
    public function fetchValue(\Closure $fn): static
    {
        $this->fetchValue = $fn;
        return $this;
    }

    public function forUpdate(): static
    {
        $this->lock = 'update';
        return $this;
    }

    public function forShare(): static
    {
        $this->lock = 'share';
        return $this;
    }

    public function forUpdateNoWait(): static
    {
        $this->lock = 'update_nowait';
        return $this;
    }

    public function forShareNoWait(): static
    {
        $this->lock = 'share_nowait';
        return $this;
    }

    /** Sets the duplicate-key update of the next create(). */
    public function duplication(Model $model): static
    {
        $this->duplication = $model;
        return $this;
    }

    // ---- generated column access ----

    protected function readColumn(string $column): mixed
    {
        if (array_key_exists($column, $this->values)) {
            return $this->value($column);
        }
        $col = static::meta()['columns'][$column];
        if ($col['nullable']) {
            return null;
        }
        return match ($col['type']) {
            'i32', 'i64' => 0,
            'f64', 'decimal' => 0.0,
            'bool' => false,
            'date', 'datetime' => new \DateTimeImmutable('0001-01-01 00:00:00'),
            'point' => [0.0, 0.0],
            'jsontext' => null,
            default => '',
        };
    }

    protected function writeColumn(string $column, mixed $value): static
    {
        if ($this->groupOf !== null) {
            $this->fail('set is not allowed inside a group callback');
            return $this;
        }
        $this->values[$column] = $value;
        $this->putSet($column, $value === null ? ['null' => true] : ['value' => $value]);
        return $this;
    }

    /** A loaded or set column value; loaded date text is converted on first read. */
    private function value(string $column): mixed
    {
        $v = $this->values[$column] ?? null;
        if ($v instanceof PendingTime) {
            $v = $this->values[$column] = self::timeValue($v->text, $v->zone);
        }
        return $v;
    }

    private static function resolved(mixed $v): mixed
    {
        return $v instanceof PendingTime ? self::timeValue($v->text, $v->zone) : $v;
    }

    private function putSet(string $column, array $spec): void
    {
        if (!array_key_exists($column, static::meta()['columns'])) {
            $this->fail(static::meta()['entity'] . " has no column $column");
            return;
        }
        $this->sets[$column] = $spec;
    }

    /** Converts a database or caller value to the column value model. */
    private static function columnValue(array $col, mixed $v, \DateTimeZone $zone): mixed
    {
        if ($v === null) {
            return null;
        }
        if (is_resource($v)) {
            $v = stream_get_contents($v);
        }
        if (Chain::appStyled($col)) {
            return $v;
        }
        return match ($col['type']) {
            'i32', 'i64' => (int) $v,
            'f64', 'decimal' => (float) $v,
            'bool' => (bool) $v,
            'date', 'datetime' => self::timeValue($v, $zone),
            'point' => Codec::point($v),
            'jsontext' => $v,
            default => is_string($v) ? $v : (string) $v,
        };
    }

    private static function timeValue(mixed $v, \DateTimeZone $zone): \DateTimeImmutable
    {
        if ($v instanceof \DateTimeInterface) {
            return \DateTimeImmutable::createFromInterface($v)->setTimezone($zone);
        }
        $s = (string) $v;
        $format = match (strlen($s)) {
            19 => '!Y-m-d H:i:s',
            26 => '!Y-m-d H:i:s.u',
            10 => '!Y-m-d',
            default => null,
        };
        if ($format !== null) {
            $t = \DateTimeImmutable::createFromFormat($format, $s, $zone);
            if ($t !== false) {
                return $t;
            }
        }
        if (preg_match('/[+-]\d\d(:?\d\d)?$/', $s) === 1) {
            try {
                return (new \DateTimeImmutable($s))->setTimezone($zone);
            } catch (\Exception) {
                throw new OrmException(Code::CODEC_DECODE, "invalid date value $s");
            }
        }
        foreach (['Y-m-d H:i:s.u', 'Y-m-d H:i:s', 'Y-m-d'] as $format) {
            $t = \DateTimeImmutable::createFromFormat('!' . $format, $s, $zone);
            if ($t !== false) {
                return $t;
            }
        }
        throw new OrmException(Code::CODEC_DECODE, "invalid date value $s");
    }

    // ---- names resolved at call time ----

    public function __call(string $name, array $args): mixed
    {
        $meta = static::meta();
        foreach (['getsBy', 'getBy', 'getCountBy'] as $prefix) {
            if (self::prefixed($name, $prefix)) {
                $m = $this->by(Chain::parse(static::class, substr($name, strlen($prefix))), $args);
                return match ($prefix) {
                    'getsBy' => $m->gets(),
                    'getBy' => $m->get(),
                    default => $m->getCount(),
                };
            }
        }
        if (self::prefixed($name, 'orderBy')) {
            $keys = Chain::order(static::class, substr($name, 7));
            if (count($args) > (count($keys) === 1 ? 1 : 0)) {
                throw new OrmException(Code::CONFIG, "$name accepts " . (count($keys) === 1 ? 'one column function' : 'no argument'));
            }
            foreach ($keys as $k) {
                $item = ['column' => $k['column'], 'desc' => $k['desc']];
                if ($args !== []) {
                    if (!$args[0] instanceof Func || !$args[0]->column) {
                        throw new OrmException(Code::CONFIG, "$name accepts a column function only");
                    }
                    $item['fn'] = $args[0];
                }
                $this->order[] = $item;
            }
            return $this;
        }
        foreach (['leftJoin' => 'left', 'join' => 'inner'] as $prefix => $kind) {
            if (self::prefixed($name, $prefix)) {
                $child = $args[0] ?? null;
                if (count($args) !== 1 || !$child instanceof Model) {
                    throw new OrmException(Code::CONFIG, "$name takes the joined model");
                }
                [$left, $right] = Chain::pair($meta, $child::meta(), substr($name, strlen($prefix)));
                return $this->addJoin($kind, $left, $right, $child);
            }
        }
        if (self::prefixed($name, 'match')) {
            self::arity($name, $args, 0);
            [$this->matchLeft, $this->matchRight] = Chain::pair(null, $meta, substr($name, 5));
            return $this;
        }
        if (self::prefixed($name, 'alias')) {
            self::arity($name, $args, 0);
            $this->alias = Chain::snake(substr($name, 5));
            return $this;
        }
        if (self::prefixed($name, 'new')) {
            self::arity($name, $args, 1);
            $attr = substr($name, 3);
            if (Chain::columnName($meta, $attr) !== '') {
                throw new OrmException(Code::CONFIG, "$attr is a column of {$meta['entity']}; use set$attr");
            }
            $this->news[Chain::snake($attr)] = $args[0];
            return $this;
        }
        if (self::prefixed($name, 'addRawColumn')) {
            $key = $this->outputName(substr($name, 12));
            $sql = $args[0] ?? null;
            $binds = $args[1] ?? [];
            if (!is_string($sql) || !is_array($binds) || count($args) > 2) {
                throw new OrmException(Code::CONFIG, "$name takes the SQL text and a bind list");
            }
            $this->outputs[$key] = ['raw' => [$sql, array_values($binds)]];
            return $this;
        }
        if (self::prefixed($name, 'addColumn')) {
            return $this->addColumnCall($name, substr($name, 9), $args);
        }
        foreach (['removeColumn', 'groupBy', 'keyName', 'setRaw', 'plus', 'minus', 'sum', 'avg'] as $prefix) {
            if (!self::prefixed($name, $prefix)) {
                continue;
            }
            $column = Chain::columnName($meta, substr($name, strlen($prefix)));
            if ($column === '') {
                continue;
            }
            $numeric = !Chain::appStyled($meta['columns'][$column]) && in_array($meta['columns'][$column]['type'], ['i32', 'i64', 'f64', 'decimal'], true);
            if (in_array($prefix, ['plus', 'minus', 'sum', 'avg'], true) && !$numeric) {
                throw new OrmException(Code::CONFIG, "$name requires a numeric column");
            }
            switch ($prefix) {
                case 'removeColumn':
                    self::arity($name, $args, 0);
                    if (!in_array($column, $this->removeColumns, true)) {
                        $this->removeColumns[] = $column;
                    }
                    return $this;
                case 'groupBy':
                    self::arity($name, $args, 0);
                    $this->groupBy[] = $column;
                    return $this;
                case 'keyName':
                    self::arity($name, $args, 0);
                    $this->keyName = $column;
                    return $this;
                case 'setRaw':
                    if (!is_string($args[0] ?? null) || !is_array($args[1] ?? []) || count($args) > 2) {
                        throw new OrmException(Code::CONFIG, "$name takes the SQL text and a bind list");
                    }
                    $this->putSet($column, ['raw' => [$args[0], array_values($args[1] ?? [])]]);
                    return $this;
                case 'plus':
                case 'minus':
                    self::arity($name, $args, 1);
                    $this->putSet($column, [$prefix => $args[0]]);
                    return $this;
                default:
                    self::arity($name, $args, 0);
                    $this->aggFn = $prefix;
                    $this->agg = $column;
                    return $this;
            }
        }
        if (self::prefixed($name, 'possible')) {
            self::arity($name, $args, 1);
            $column = Chain::columnName(null, substr($name, 8));
            if ($column === '') {
                throw new OrmException(Code::CONFIG, "$name: no model has the column " . substr($name, 8));
            }
            $this->possible = ['column' => $column, 'value' => $args[0]];
            return $this;
        }
        if (self::prefixed($name, 'forceIndex')) {
            self::arity($name, $args, 0);
            $index = Chain::snake(substr($name, 10));
            if (!in_array($index, $meta['indexes'], true)) {
                throw new OrmException(Code::CONFIG, "{$meta['entity']} has no index $index");
            }
            $this->index = $index;
            return $this;
        }
        if (self::prefixed($name, 'get')) {
            self::arity($name, $args, 0);
            return $this->named(Chain::snake(substr($name, 3)), $name);
        }
        $conn = '';
        $chain = $name;
        if (self::prefixed($name, 'and')) {
            [$conn, $chain] = ['and', substr($name, 3)];
        } elseif (self::prefixed($name, 'or')) {
            [$conn, $chain] = ['or', substr($name, 2)];
        }
        $this->whereChain($conn, Chain::parse(static::class, ucfirst($chain)), $args);
        return $this;
    }

    private static function prefixed(string $name, string $prefix): bool
    {
        return strlen($name) > strlen($prefix) && str_starts_with($name, $prefix) && ctype_upper($name[strlen($prefix)]);
    }

    private static function arity(string $name, array $args, int $count): void
    {
        if (count($args) !== $count) {
            throw new OrmException(Code::CONFIG, "$name takes $count argument" . ($count === 1 ? '' : 's'));
        }
    }

    private function outputName(string $pascal): string
    {
        if ($pascal === '' || Chain::columnName(static::meta(), $pascal) !== '') {
            throw new OrmException(Code::CONFIG, "an added column needs a name that is not a column: $pascal");
        }
        $key = Chain::snake($pascal);
        if (isset($this->outputs[$key])) {
            throw new OrmException(Code::CONFIG, "column name $key is already added");
        }
        return $key;
    }

    private function addColumnCall(string $name, string $rest, array $args): static
    {
        $meta = static::meta();
        $column = Chain::columnName($meta, $rest);
        if ($column !== '') {
            self::arity($name, $args, 0);
            if (!in_array($column, $this->addColumns, true)) {
                $this->addColumns[] = $column;
            }
            return $this;
        }
        $at = strpos($rest, 'Alias');
        if ($at !== false && $at > 0) {
            $column = Chain::columnName($meta, substr($rest, 0, $at));
            if ($column !== '' && strlen($rest) > $at + 5) {
                self::arity($name, $args, 1);
                $key = $this->outputName(substr($rest, $at + 5));
                $arg = $args[0];
                if ($arg instanceof Func) {
                    if (!$arg->column) {
                        throw new OrmException(Code::CONFIG, "$name requires a column function");
                    }
                    $this->outputs[$key] = ['fn' => [$column, $arg]];
                } elseif (is_string($arg) && substr_count($arg, '%s') === 1) {
                    $this->outputs[$key] = ['format' => [$column, $arg]];
                } else {
                    throw new OrmException(Code::CONFIG, "$name takes a format with one %s or a column function");
                }
                return $this;
            }
        }
        self::arity($name, $args, 1);
        if (!$args[0] instanceof \Closure) {
            throw new OrmException(Code::CONFIG, "$name takes a callback that returns a model");
        }
        $this->outputs[$this->outputName($rest)] = ['sub' => $args[0]];
        return $this;
    }

    private function addJoin(string $kind, string $left, string $right, Model $child): static
    {
        if ($this->groupOf !== null) {
            $this->fail('join is not allowed inside a group callback');
        } elseif ($child->conn !== null) {
            $this->fail('a join child cannot have its own connection');
        } else {
            foreach ($this->joins as $j) {
                if ($j['child'] === $child) {
                    $this->fail('the model is already joined');
                    return $this;
                }
            }
            $this->joins[] = ['kind' => $kind, 'left' => $left, 'right' => $right, 'child' => $child];
        }
        return $this;
    }

    /** A value attached to the row: relation result, added column, or new<Name> value. */
    private function named(string $key, string $method): mixed
    {
        if (array_key_exists($key, $this->news)) {
            return $this->news[$key];
        }
        if ($this->row !== null) {
            if (array_key_exists($key, $this->row['related'])) {
                return $this->row['related'][$key];
            }
            if (array_key_exists($key, $this->row['extra'])) {
                return $this->row['extra'][$key];
            }
        }
        throw new OrmException(Code::CONFIG, static::class . "::$method: the row has no value $key");
    }

    // ---- conditions ----

    /** @param list<array> $keys */
    private function whereChain(string $conn, array $keys, array $args): void
    {
        $i = 0;
        foreach ($keys as $k => $key) {
            if ($i >= count($args)) {
                throw new OrmException(Code::CONFIG, 'the condition expects ' . count($keys) . ' values');
            }
            $value = $args[$i++];
            [$pred, $extra] = $this->predicate($key, $value, array_slice($args, $i), count($keys) === 1);
            $i += $extra;
            $this->addItem($k === 0 ? $conn : $key['conn'], ['pred' => $pred]);
        }
        if ($i !== count($args)) {
            throw new OrmException(Code::CONFIG, 'the condition expects ' . count($keys) . ' values, got ' . count($args));
        }
    }

    private const OPERATORS = ['' => 'eq', 'ne' => 'not_eq', 'gt' => 'gt', 'lt' => 'lt', 'ge' => 'gte', 'le' => 'lte', 'lk' => 'contains', 'lb' => 'contains_binary'];

    /** @return array{0: array, 1: int} */
    private function predicate(array $key, mixed $value, array $rest, bool $single): array
    {
        $meta = static::meta();
        $column = $key['column'];
        $p = ['column' => $column];
        switch ($key['op']) {
            case 'fulltext':
            case 'fulltext_boolean':
                if (!is_string($value)) {
                    throw new OrmException(Code::CONFIG, 'a full-text value must be a string');
                }
                return [['op' => $key['op'] === 'fulltext' ? 'match' : 'match_boolean', 'cols' => $key['columns'], 'value' => $value, 'kind' => 'fulltext'], 0];
            case 'tuple':
            case 'ne_tuple':
                if (!is_array($value) || !array_is_list($value)) {
                    throw new OrmException(Code::CONFIG, 'tuple values must be a list');
                }
                if ($value === []) {
                    throw new OrmException(Code::EMPTY_IN, 'tuple condition received an empty list');
                }
                foreach ($value as $row) {
                    if (!is_array($row) || !array_is_list($row) || count($row) !== count($key['columns'])) {
                        throw new OrmException(Code::CONFIG, 'each tuple value group needs ' . count($key['columns']) . ' values');
                    }
                }
                return [['op' => $key['op'] === 'tuple' ? 'tuple_in' : 'tuple_not_in', 'cols' => $key['columns'], 'value' => $value, 'kind' => 'tuple'], 0];
            case 'between':
                if (!is_array($value) || !array_is_list($value) || count($value) !== 2) {
                    throw new OrmException(Code::CONFIG, "between value for $column must be a two-value array");
                }
                return [$p + ['op' => 'between', 'value' => $value, 'kind' => 'between'], 0];
        }
        if ($key['compare'] !== '') {
            if (!$value instanceof Model) {
                throw new OrmException(Code::CONFIG, "column comparison on $column requires a model");
            }
            return [$p + ['op' => self::OPERATORS[$key['op']] . '_col', 'ref' => $value, 'refCol' => $key['compare'], 'kind' => 'ref'], 0];
        }
        $op = self::OPERATORS[$key['op']];
        $eq = $key['op'] === '' || $key['op'] === 'ne';
        if ($value === null) {
            if (!$eq) {
                throw new OrmException(Code::CONFIG, "null is not accepted by the {$key['op']} operator");
            }
            if (!$meta['columns'][$column]['nullable']) {
                throw new OrmException(Code::CONFIG, "{$meta['entity']}.$column is not nullable");
            }
            return [$p + ['op' => $key['op'] === 'ne' ? 'is_not_null' : 'is_null', 'kind' => 'null'], 0];
        }
        if ($value instanceof Func) {
            if ($value->column) {
                if (!$single) {
                    throw new OrmException(Code::CONFIG, 'a column function is accepted only by a single-key condition');
                }
                if (count($rest) !== 1) {
                    throw new OrmException(Code::CONFIG, "column function on $column requires one compared value");
                }
                return [$p + ['op' => $op, 'fn' => $value, 'value' => $rest[0], 'kind' => 'fn'], 1];
            }
            return [$p + ['op' => $op, 'fn' => $value, 'kind' => 'valueFn'], 0];
        }
        if ($value instanceof Model) {
            if (!$eq) {
                throw new OrmException(Code::CONFIG, "a subquery is not accepted by the {$key['op']} operator");
            }
            return [$p + ['op' => $key['op'] === 'ne' ? 'not_in' : 'in', 'sub' => $value, 'kind' => 'sub'], 0];
        }
        if (is_array($value)) {
            if (!$eq) {
                throw new OrmException(Code::CONFIG, "a list is not accepted by the {$key['op']} operator");
            }
            if ($value === []) {
                throw new OrmException(Code::EMPTY_IN, "$column received an empty list");
            }
            return [$p + ['op' => $key['op'] === 'ne' ? 'not_in' : 'in', 'value' => array_values($value), 'kind' => 'list'], 0];
        }
        return [$p + ['op' => $op, 'value' => $value, 'kind' => 'value'], 0];
    }

    private function by(array $keys, array $args): static
    {
        $m = clone $this;
        $m->whereChain($m->where['items'] === [] ? '' : 'and', $keys, $args);
        return $m;
    }

    // ---- request building ----

    private function executor(): array
    {
        if ($this->groupOf !== null) {
            throw new OrmException(Code::CONFIG, 'a terminal is not allowed inside a group callback');
        }
        if ($this->error !== null) {
            throw $this->error;
        }
        return Db::resolve($this->conn);
    }

    private function build(string $kind, Db $db): Request
    {
        $r = new Request($kind, $db);
        $frame = new Frame($this, null);
        $r->ir += $this->query($r, $frame);
        return $r;
    }

    private function resultName(bool $many): string
    {
        if ($this->alias !== '') {
            return $this->alias;
        }
        return static::meta()['entity'] . ($many ? '_models' : '_model');
    }

    private function query(Request $r, Frame $f): array
    {
        if ($this->error !== null) {
            throw $this->error;
        }
        if ($this->where['pending'] !== '') {
            throw new OrmException(Code::CONFIG, "connector {$this->where['pending']} without a following condition");
        }
        $q = ['entity' => static::meta()['entity']];
        $columns = $this->columnsIr($r);
        if ($columns !== null) {
            $q['columns'] = $columns;
        }
        foreach ($this->joins as $j) {
            $child = $j['child'];
            $path = $f->path($child);
            $name = substr($path, (int) strrpos('/' . $path, '/'));
            if (isset($r->names[$path])) {
                throw new OrmException(Code::CONFIG, "join result name $name is used twice; use alias<Name>()");
            }
            $r->names[$path] = true;
            $childQuery = $child->query($r, $f);
            if ($child->on !== null) {
                $childQuery['on'] = $child->groupIr($child->on, $r, $f);
            }
            $q['joins'][] = ['rel' => $name, 'kind' => $j['kind'], 'query' => $childQuery, 'left' => $j['left'], 'right' => $j['right']];
        }
        if ($this->where['items'] !== []) {
            $q['where'] = $this->groupIr($this->where['items'], $r, $f);
        }
        foreach ($this->relations as $rel) {
            $child = $rel['child'];
            if ($child->conn !== null) {
                if ($child->limit !== null) {
                    throw new OrmException(Code::LIMIT_IN_RELATION, $child::meta()['entity'] . ' relation uses limit; use groupLimit');
                }
                $r->external[spl_object_id($this)][] = $rel;
                continue;
            }
            $q['relations'][] = $child->relationIr($rel['many'], $r);
        }
        foreach ($this->order as $o) {
            if (isset($o['random'])) {
                $q['order'][] = ['random' => true];
            } elseif (isset($o['expr'])) {
                $q['order'][] = ['expr' => $o['expr']];
            } else {
                $item = ['column' => $o['column']];
                if ($o['desc']) {
                    $item['desc'] = true;
                }
                if (isset($o['fn'])) {
                    $item['fn'] = $o['fn']->ir($r->param(...));
                }
                $q['order'][] = $item;
            }
        }
        if ($this->groupBy !== []) {
            $q['group_by'] = $this->groupBy;
        }
        foreach ($this->groupRaw as $i => $sql) {
            $q['group_by_expr'][] = ['expr' => $sql, 'as' => 'group_' . ($i + 1)];
        }
        if ($this->limit !== null) {
            $q['limit'] = $this->limit;
        }
        if ($this->index !== '') {
            $q['force_index'] = $this->index;
        }
        if ($this->lock !== '') {
            $q['lock'] = $this->lock;
        }
        return $q;
    }

    private function relationIr(bool $many, Request $r): array
    {
        $q = $this->query($r, new Frame($this, null));
        if ($this->limit !== null) {
            throw new OrmException(Code::LIMIT_IN_RELATION, static::meta()['entity'] . ' relation uses limit; use groupLimit');
        }
        if ($this->parentNode) {
            $q['flatten'] = true;
        }
        if ($this->groupLimit > 0) {
            $q['limit_per_parent'] = $this->groupLimit;
        }
        if ($this->deleteLock) {
            $q['no_cascade_delete'] = true;
        }
        if ($this->keyName !== '') {
            $q['key_by'] = $this->keyName;
        }
        if ($this->possible !== null) {
            $q['if_parent'] = ['column' => $this->possible['column'], 'p' => $r->param($this->possible['value'])];
        }
        return ['rel' => $this->resultName($many), 'query' => $q, 'kind' => $many ? 'many' : 'one', 'left' => $this->matchLeft, 'right' => $this->matchRight];
    }

    private function columnsIr(Request $r): ?array
    {
        $out = [];
        if ($this->columnMode !== '') {
            $out['mode'] = $this->columnMode;
        }
        if ($this->addColumns !== []) {
            $out['add'] = $this->addColumns;
        }
        if ($this->removeColumns !== []) {
            $out['remove'] = $this->removeColumns;
        }
        foreach ($this->outputs as $name => $spec) {
            if (isset($spec['format'])) {
                [$column, $format] = $spec['format'];
                $out['expr'][$name] = ['sql' => str_replace('%s', '{' . $column . '}', $format)];
            } elseif (isset($spec['fn'])) {
                [$column, $fn] = $spec['fn'];
                $out['fn'][$name] = ['column' => $column, 'fn' => $fn->ir($r->param(...))];
            } elseif (isset($spec['raw'])) {
                $pred = $r->raw(...$spec['raw']);
                $out['expr'][$name] = ['sql' => $pred['expr']] + (isset($pred['ps']) ? ['ps' => $pred['ps']] : []);
            } else {
                $model = ($spec['sub'])($this);
                if (!$model instanceof Model) {
                    throw new OrmException(Code::CONFIG, "the $name callback must return a model");
                }
                $out['sub'][$name] = $model->subqueryIr($r, $this, true);
            }
        }
        return $out === [] ? null : $out;
    }

    private function subqueryIr(Request $r, Model $outer, bool $scalar): array
    {
        if ($this->conn !== null) {
            throw new OrmException(Code::CONFIG, 'a subquery model cannot have its own connection');
        }
        if ($this->relations !== []) {
            throw new OrmException(Code::CONFIG, 'a subquery model cannot load relations');
        }
        $q = $this->query($r, new Frame($this, $outer));
        unset($q['columns']);
        if ($scalar && $this->agg !== '') {
            return ['query' => $q, 'column' => $this->agg, 'agg' => $this->aggFn];
        }
        if (count($this->addColumns) !== 1) {
            throw new OrmException(Code::CONFIG, 'a subquery model must add exactly one column with addColumn<Col>()');
        }
        return ['query' => $q, 'column' => $this->addColumns[0]];
    }

    /** @param list<array> $items */
    private function groupIr(array $items, Request $r, Frame $f): array
    {
        $out = ['items' => []];
        foreach ($items as $node) {
            $conn = $node['conn'];
            if (isset($node['pred'])) {
                $pred = $this->predIr($node['pred'], $r, $f);
                if ($conn !== '') {
                    $pred['conn'] = $conn;
                }
                $out['items'][] = ['pred' => $pred];
            } elseif (isset($node['raw'])) {
                $pred = $r->raw(...$node['raw']);
                if ($conn !== '') {
                    $pred['conn'] = $conn;
                }
                $out['items'][] = ['pred' => $pred];
            } elseif (isset($node['group'])) {
                $group = $this->groupIr($node['group'], $r, $f);
                if ($conn !== '') {
                    $group['conn'] = $conn;
                }
                $out['items'][] = ['group' => $group];
            } else {
                $child = $node['joined'];
                if (!$f->joined($child)) {
                    throw new OrmException(Code::CONFIG, $child::meta()['entity'] . ' is not joined in the statement');
                }
                if ($f->parentOf($child) !== $this->subject()) {
                    throw new OrmException(Code::CONFIG, $child::meta()['entity'] . ' conditions must be placed in the model it is joined to');
                }
                if (!$f->place($child)) {
                    throw new OrmException(Code::CONFIG, $child::meta()['entity'] . ' conditions are placed twice');
                }
                if ($child->where['items'] === []) {
                    throw new OrmException(Code::CONFIG, $child::meta()['entity'] . ' has no condition to place');
                }
                $path = $f->path($child);
                $joined = ['join' => substr($path, (int) strrpos('/' . $path, '/'))];
                if ($conn !== '') {
                    $joined['conn'] = $conn;
                }
                $out['items'][] = ['joined' => $joined];
            }
        }
        return $out;
    }

    private function predIr(array $p, Request $r, Frame $f): array
    {
        $out = [];
        if (!in_array($p['kind'], ['fulltext', 'tuple'], true)) {
            $out['column'] = $p['column'];
        }
        $out['op'] = $p['op'];
        switch ($p['kind']) {
            case 'fulltext':
                $out['match'] = $p['cols'];
                $out['p'] = $r->param($p['value']);
                break;
            case 'tuple':
                $out['cols'] = $p['cols'];
                foreach ($p['value'] as $row) {
                    foreach ($row as $v) {
                        $out['ps'][] = $r->param($v);
                    }
                }
                break;
            case 'between':
                foreach ($p['value'] as $v) {
                    $out['ps'][] = $r->param($v);
                }
                break;
            case 'list':
                foreach (Request::padIn($p['value']) as $v) {
                    $out['ps'][] = $r->param($v);
                }
                break;
            case 'null':
                break;
            case 'ref':
                $out['ref'] = ['path' => $f->pathOf($p['ref']->subject()), 'column' => $p['refCol']];
                break;
            case 'sub':
                $out['sub'] = $p['sub']->subqueryIr($r, $this->subject(), false);
                break;
            case 'fn':
                $out['fn'] = $p['fn']->ir($r->param(...));
                $out['p'] = $r->param($p['value']);
                break;
            case 'valueFn':
                $out['value'] = $p['fn']->ir($r->param(...));
                break;
            default:
                $out['p'] = $r->param($p['value']);
        }
        return $out;
    }

    /** @internal registers the join paths of a statement */
    public function registerJoins(Frame $f, string $prefix): void
    {
        foreach ($this->joins as $j) {
            $path = $prefix . $j['child']->resultName(false);
            $f->add($j['child'], $path, $this);
            $j['child']->registerJoins($f, $path . '/');
        }
    }

    // ---- assembly ----

    private function newRow(?Db $conn): static
    {
        $m = new static();
        $m->conn = $conn;
        return $m;
    }

    /**
     * The per-node conversion of an assemble node for this model class: the columns grouped by
     * conversion ([index, name] or [index, name, kind]), the loaded names, the hidden names and the names whose loaded value is kept for
     * update and delete, and the single key column. Computed once per model class and plan node.
     */
    private function rowShape(array $asm): array
    {
        static $shapes = [];
        $key = static::class . '#' . $asm['node'];
        if (isset($shapes[$key])) {
            return $shapes[$key];
        }
        if (count($shapes) >= 4096) {
            $shapes = [];
        }
        $meta = static::meta();
        $shape = ['int' => [], 'float' => [], 'bool' => [], 'date' => [], 'string' => [], 'other' => [], 'extra' => [],
            'names' => [], 'hidden' => [], 'original' => [], 'key' => null];
        foreach ($asm['columns'] as $col) {
            $name = $col['name'];
            $shape['names'][] = $name;
            if (!empty($col['hidden'])) {
                $shape['hidden'][$name] = true;
            }
            if (($col['column'] ?? '') === $name && isset($meta['columns'][$name])) {
                $mc = $meta['columns'][$name];
                $kind = Chain::appStyled($mc) ? 'json' : $mc['type'];
                $group = match ($kind) {
                    'i32', 'i64' => 'int',
                    'f64', 'decimal' => 'float',
                    'bool' => 'bool',
                    'date', 'datetime' => 'date',
                    'point', 'json', 'jsontext' => 'other',
                    default => 'string',
                };
                $shape[$group][] = [$col['index'], $name, $kind];
            } else {
                $shape['extra'][] = [$col['index'], $name, $col['type'] ?? ''];
            }
        }
        foreach ($asm['key'] ?? [] as $k) {
            foreach ($asm['columns'] as $col) {
                if ($col['index'] === $k['index']) {
                    $shape['original'][] = $col['name'];
                }
            }
        }
        if ($meta['updated'] !== '' && in_array($meta['updated'], $shape['names'], true)) {
            $shape['original'][] = $meta['updated'];
        }
        if (count($asm['key'] ?? []) === 1) {
            $shape['key'] = $asm['key'][0]['index'];
        }
        $shape['row'] = ['loaded' => true, 'names' => $shape['names'], 'hidden' => $shape['hidden'], 'original' => [], 'extra' => [], 'related' => [], 'cascade' => [], 'flat' => []];
        return $shapes[$key] = $shape;
    }

    /** @param list<mixed> $vals */
    private function assembleRow(Assembly $a, array $asm, array $vals): static
    {
        $shape = $this->rowShape($asm);
        $zone = $a->zone;
        $m = $this->newRow($a->conn);
        $st = $shape['row'];
        $values = [];
        foreach ($shape['int'] as [$index, $name]) {
            $v = $vals[$index];
            $values[$name] = $v === null ? null : (int) $v;
        }
        foreach ($shape['float'] as [$index, $name]) {
            $v = $vals[$index];
            $values[$name] = $v === null ? null : (float) $v;
        }
        foreach ($shape['bool'] as [$index, $name]) {
            $v = $vals[$index];
            $values[$name] = $v === null ? null : (bool) $v;
        }
        foreach ($shape['date'] as [$index, $name]) {
            $v = $vals[$index];
            $values[$name] = $v === null ? null : (is_string($v) ? new PendingTime($v, $zone) : self::timeValue($v, $zone));
        }
        foreach ($shape['string'] as [$index, $name]) {
            $v = $vals[$index];
            $values[$name] = $v === null || is_string($v) ? $v : (is_resource($v) ? stream_get_contents($v) : (string) $v);
        }
        foreach ($shape['other'] as [$index, $name, $kind]) {
            $v = $vals[$index];
            if (is_resource($v)) {
                $v = stream_get_contents($v);
            }
            $values[$name] = $v === null || $kind === 'json' ? $v : Codec::point($v);
        }
        $m->values = $values;
        foreach ($shape['extra'] as [$index, $name, $kind]) {
            $v = $vals[$index];
            if (is_resource($v)) {
                $v = stream_get_contents($v);
            }
            $st['extra'][$name] = $v === null ? null : match ($kind) {
                'i32', 'i64' => is_numeric($v) ? (int) $v : $v,
                'f64' => is_numeric($v) ? (float) $v : $v,
                'date', 'datetime' => self::timeValue($v, $zone),
                default => $v,
            };
        }
        foreach ($shape['original'] as $name) {
            $st['original'][$name] = $values[$name] ?? null;
        }
        $m->news = $this->news;
        foreach ($asm['children'] ?? [] as $ch) {
            if ($ch['kind'] === 'join') {
                $child = $this->joinChild($ch['rel']);
                $value = null;
                $first = $ch['assemble']['columns'][0]['index'] ?? null;
                if ($first !== null && $vals[$first] !== null) {
                    $value = $child->assembleRow($a, $ch['assemble'], $vals);
                }
                $st['related'][$ch['rel']] = $value;
                $st['cascade'][$ch['rel']] = false;
                continue;
            }
            [$child, $many] = $this->relationChild($ch['rel']);
            $rows = $a->related($ch, $vals);
            $childAsm = $a->stepAssemble($ch['step']);
            if ($many) {
                $coll = new Collection();
                foreach ($rows as $cr) {
                    $cm = $child->assembleRow($a, $childAsm, $cr);
                    $coll->put($child->collectionKey($cm, $childAsm, $cr), $cm);
                }
                $st['related'][$ch['rel']] = $coll;
            } else {
                $st['related'][$ch['rel']] = $rows === [] ? null : $child->assembleRow($a, $childAsm, $rows[0]);
                if (!empty($ch['flatten'])) {
                    $st['flat'][] = $ch['rel'];
                }
            }
            $st['cascade'][$ch['rel']] = !empty($ch['cascade']);
        }
        $m->row = $st;
        if ($a->track) {
            $a->made[spl_object_id($this)][] = $m;
        }
        return $m;
    }

    private function joinChild(string $name): Model
    {
        foreach ($this->joins as $j) {
            if ($j['child']->resultName(false) === $name) {
                return $j['child'];
            }
        }
        throw new OrmException(Code::INTERNAL, "join result $name without a model");
    }

    /** @return array{0: Model, 1: bool} */
    private function relationChild(string $name): array
    {
        foreach ($this->relations as $rel) {
            if ($rel['child']->resultName($rel['many']) === $name) {
                return [$rel['child'], $rel['many']];
            }
        }
        throw new OrmException(Code::INTERNAL, "relation result $name without a model");
    }

    private function collectionKey(Model $m, array $asm, array $vals): int|string
    {
        if ($this->fetchKey !== null) {
            return Collection::keyOf(($this->fetchKey)($m));
        }
        if ($this->keyName !== '') {
            return Collection::keyOf(array_key_exists($this->keyName, $m->values) ? $m->value($this->keyName) : $m->row['extra'][$this->keyName] ?? null);
        }
        return Db::rowKey($vals, $asm['key']) ?? '';
    }

    private function assemble(Db $db, Request $r, array $plan, array $result): Collection
    {
        $a = new Assembly($db, $this->conn, $result, $r->external !== []);
        $out = new Collection();
        $asm = $plan['steps'][0]['assemble'];
        $index = $this->fetchKey === null && $this->keyName === '' ? $this->rowShape($asm)['key'] : null;
        foreach ($result['main'] as $vals) {
            $m = $this->assembleRow($a, $asm, $vals);
            if ($index !== null) {
                $k = $vals[$index];
                $out->put(is_int($k) || is_string($k) ? $k : Collection::keyOf($k), $m);
            } else {
                $out->put($this->collectionKey($m, $asm, $vals), $m);
            }
        }
        foreach ($r->external as $id => $rels) {
            $parents = $a->made[$id] ?? [];
            if ($parents === []) {
                continue;
            }
            foreach ($rels as $rel) {
                $rel['child']->attachExternal($parents, $rel['many']);
            }
        }
        if ($this->fetchValue !== null) {
            $out->fetchValues($this->fetchValue);
        }
        return $out;
    }

    /** @param list<Model> $parents */
    private function attachExternal(array $parents, bool $many): void
    {
        $values = [];
        $seen = [];
        foreach ($parents as $p) {
            if ($this->possible !== null && !Db::sameScalar($p->columnOrExtra($this->possible['column']), $this->possible['value'])) {
                continue;
            }
            $v = $p->columnOrExtra($this->matchLeft);
            if ($v === null || isset($seen[Db::scalarText($v)])) {
                continue;
            }
            $seen[Db::scalarText($v)] = true;
            $values[] = $v;
        }
        $byKey = [];
        if ($values !== []) {
            $q = clone $this;
            $q->matchLeft = '';
            $q->alias = '';
            $match = ['pred' => ['column' => $this->matchRight, 'op' => 'in', 'value' => $values, 'kind' => 'list']];
            if ($q->where['items'] !== []) {
                $q->where['items'] = [['conn' => '', 'group' => $q->where['items']], $match + ['conn' => 'and']];
            } else {
                $q->where['items'] = [$match + ['conn' => '']];
            }
            foreach ($q->gets()->entries() as [$key, $m]) {
                $k = Db::scalarText($m->columnOrExtra($this->matchRight));
                if ($this->groupLimit > 0 && count($byKey[$k] ?? []) >= $this->groupLimit) {
                    continue;
                }
                $byKey[$k][] = [$key, $m];
            }
        }
        $name = $this->resultName($many);
        foreach ($parents as $p) {
            if (array_key_exists($name, $p->row['related'])) {
                throw new OrmException(Code::CONFIG, "relation result name $name is used twice");
            }
            $matched = $byKey[Db::scalarText($p->columnOrExtra($this->matchLeft))] ?? [];
            if ($this->possible !== null && !Db::sameScalar($p->columnOrExtra($this->possible['column']), $this->possible['value'])) {
                $matched = [];
            }
            if ($many) {
                $coll = new Collection();
                foreach ($matched as [$key, $m]) {
                    $coll->put($key, $m);
                }
                $p->row['related'][$name] = $coll;
            } else {
                $p->row['related'][$name] = $matched === [] ? null : $matched[0][1];
                if ($this->parentNode) {
                    $p->row['flat'][] = $name;
                }
            }
            $p->row['cascade'][$name] = !$this->deleteLock;
        }
    }

    private function columnOrExtra(string $name): mixed
    {
        if (array_key_exists($name, $this->values)) {
            return $this->value($name);
        }
        return $this->row['extra'][$name] ?? null;
    }

    // ---- terminals ----

    private function load(string $kind): Collection
    {
        [$db, $frame] = $this->executor();
        $r = $this->build($kind, $db);
        [$plan, $result] = $db->select($frame, $r);
        return $this->assemble($db, $r, $plan, $result);
    }

    /** The first matching row, or null. */
    public function get(): ?static
    {
        return $this->load('one')->first();
    }

    /** The matching rows. */
    public function gets(): Collection
    {
        return $this->load('all');
    }

    /** Grouped rows with row_count. */
    public function getsCount(): Collection
    {
        return $this->load('group_count');
    }

    public function getCount(): int
    {
        [$db, $frame] = $this->executor();
        return (int) $db->scalarOf($frame, $this->build('count', $db));
    }

    public function getSum(): float
    {
        return $this->aggregate('sum');
    }

    public function getAvg(): float
    {
        return $this->aggregate('avg');
    }

    private function aggregate(string $fn): float
    {
        if ($this->aggFn !== $fn) {
            throw new OrmException(Code::CONFIG, "get" . ucfirst($fn) . " requires $fn<Col>()");
        }
        [$db, $frame] = $this->executor();
        $r = $this->build($fn, $db);
        $r->ir['agg'] = $this->agg;
        return (float) $db->scalarOf($frame, $r);
    }

    /** One page and the total count. */
    public function getsPage(int $page, int $perPage): Page
    {
        if ($page < 1 || $perPage < 1) {
            throw new OrmException(Code::CONFIG, 'getsPage requires a positive page and perPage');
        }
        if ($this->limit !== null) {
            throw new OrmException(Code::CONFIG, 'getsPage cannot be combined with limit');
        }
        [$db, $frame] = $this->executor();
        $q = clone $this;
        $q->limit = ['offset' => ($page - 1) * $perPage, 'count' => $perPage];
        $r = $q->build('paginate', $db);
        [$plan, $result, $total] = $db->paginate($frame, $r);
        $items = $q->assemble($db, $r, $plan, $result);
        return new Page($items, $total, intdiv($total + $perPage - 1, $perPage), $page, $perPage);
    }

    /** @return array{sql: string, binds: list<mixed>} the statement of gets() without executing it */
    public function getQuery(): array
    {
        [$db] = $this->executor();
        return $db->statement($this->build('all', $db));
    }

    // ---- writes ----

    private function writeRequest(string $kind, Db $db): Request
    {
        $r = new Request($kind, $db);
        $r->ir['entity'] = static::meta()['entity'];
        return $r;
    }

    private function assignIr(Request $r, string $column, array $spec): array
    {
        $a = ['column' => $column];
        if (isset($spec['null'])) {
            $a['null'] = true;
        } elseif (isset($spec['raw'])) {
            $pred = $r->raw(...$spec['raw']);
            $a['expr'] = $pred['expr'];
            if (isset($pred['ps'])) {
                $a['ps'] = $pred['ps'];
            }
        } elseif (array_key_exists('plus', $spec)) {
            $a['plus_p'] = $r->param($spec['plus']);
        } elseif (array_key_exists('minus', $spec)) {
            $a['minus_p'] = $r->param($spec['minus']);
        } else {
            $v = self::encodeValue(static::meta()['columns'][$column], $spec['value']);
            if ($v === null) {
                $a['null'] = true;
            } else {
                $a['p'] = $r->param($v);
            }
        }
        return $a;
    }

    private static function encodeValue(array $col, mixed $v): mixed
    {
        $codec = array_values(array_filter($col['styles'], static fn(string $s): bool => !Codec::isHostStyle($s)));
        if ($v === null || $codec === []) {
            return $v;
        }
        return Codec::encode($codec, $v);
    }

    /** Inserts the row and returns the created row. */
    public function create(): static
    {
        [$db, $frame] = $this->executor();
        if ($this->sets === []) {
            throw new OrmException(Code::CONFIG, 'create requires set<Col> values');
        }
        $meta = static::meta();
        $r = $this->writeRequest('insert', $db);
        foreach ($this->sets as $column => $spec) {
            $r->ir['set'][] = $this->assignIr($r, $column, $spec);
        }
        if ($this->duplication !== null) {
            foreach ($this->duplication->sets as $column => $spec) {
                $r->ir['on_duplicate'][] = $this->assignIr($r, $column, $spec);
            }
            if (($r->ir['on_duplicate'] ?? []) === []) {
                throw new OrmException(Code::CONFIG, 'duplication model has no set<Col> values');
            }
        }
        [$id] = $db->writeOf($frame, $r);
        $m = $this->newRow($this->conn);
        $st = ['loaded' => true, 'names' => [], 'hidden' => [], 'original' => [], 'extra' => [], 'related' => [], 'cascade' => [], 'flat' => []];
        foreach ($this->sets as $column => $spec) {
            $st['names'][] = $column;
            if (array_key_exists('value', $spec)) {
                $m->values[$column] = self::columnValue($meta['columns'][$column], $spec['value'], $db->zone());
            } elseif (isset($spec['null'])) {
                $m->values[$column] = null;
            }
        }
        if ($meta['auto'] !== '') {
            if (!in_array($meta['auto'], $st['names'], true)) {
                $st['names'][] = $meta['auto'];
            }
            $m->values[$meta['auto']] = self::columnValue($meta['columns'][$meta['auto']], $id, $db->zone());
        }
        foreach ($meta['pk'] as $pk) {
            $v = $m->values[$pk] ?? null;
            if ($v === null || $v === 0 || $v === '') {
                $st['loaded'] = false;
            }
            $st['original'][$pk] = $v;
        }
        $m->row = $st;
        $m->news = $this->news;
        $this->sets = [];
        $this->duplication = null;
        return $m;
    }

    /**
     * Inserts rows in multi-row statements in one transaction and returns the
     * inserted row count; every row must set the same columns in the same order.
     * @param list<Model> $rows
     */
    public function creates(array $rows): int
    {
        [$db] = $this->executor();
        if ($rows === []) {
            return 0;
        }
        $columns = array_keys($rows[0]->sets);
        if ($columns === []) {
            throw new OrmException(Code::CONFIG, 'creates requires models with set<Col> values');
        }
        foreach ($rows as $row) {
            if (!$row instanceof static || array_keys($row->sets) !== $columns) {
                throw new OrmException(Code::CONFIG, 'every model of creates must set the same columns in the same order');
            }
            foreach ($row->sets as $spec) {
                if (!array_key_exists('value', $spec) && !isset($spec['null'])) {
                    throw new OrmException(Code::CONFIG, 'creates accepts stored values only');
                }
            }
        }
        $meta = static::meta();
        $per = intdiv(Db::bindLimit($db->driver()), count($columns));
        $total = 0;
        Db::inTransaction($this->conn, function () use ($rows, $columns, $meta, $per, &$total): void {
            [$db, $frame] = Db::resolve($this->conn);
            foreach (array_chunk($rows, $per) as $chunk) {
                $r = $this->writeRequest('insert', $db);
                foreach ($chunk as $i => $row) {
                    $params = [];
                    foreach ($columns as $column) {
                        $spec = $row->sets[$column];
                        $v = isset($spec['null']) ? null : self::encodeValue($meta['columns'][$column], $spec['value']);
                        $p = $r->param($v);
                        if ($i === 0) {
                            $r->ir['set'][] = ['column' => $column, 'p' => $p];
                        } else {
                            $params[] = $p;
                        }
                    }
                    if ($i > 0) {
                        $r->ir['rows'][] = $params;
                    }
                }
                [, $affected] = $db->writeOf($frame, $r);
                $total += $affected;
            }
        });
        return $total;
    }

    /** @return array<string, mixed> */
    private function keyValues(): array
    {
        $meta = static::meta();
        $keys = [];
        foreach ($meta['pk'] as $pk) {
            if ($this->row !== null && $this->row['loaded']) {
                $keys[$pk] = self::resolved($this->row['original'][$pk] ?? null);
                continue;
            }
            $spec = $this->sets[$pk] ?? null;
            if ($spec === null || !array_key_exists('value', $spec)) {
                throw new OrmException(Code::CONFIG, "{$meta['entity']} requires a loaded row or set primary key $pk");
            }
            $keys[$pk] = $spec['value'];
        }
        return $keys;
    }

    private function keyWhere(Request $r, array $keys): void
    {
        $items = [];
        foreach ($keys as $pk => $v) {
            $pred = ['column' => $pk, 'op' => 'eq', 'p' => $r->param($v)];
            if ($items !== []) {
                $pred['conn'] = 'and';
            }
            $items[] = ['pred' => $pred];
        }
        $r->ir['where'] = ['items' => $items];
    }

    /** @return array<string, array> the changes plus the other AES columns of the row when an AES column changes */
    private function withAesColumns(): array
    {
        $meta = static::meta();
        $sets = $this->sets;
        if ($meta['aes_version'] === '') {
            return $sets;
        }
        $changed = false;
        foreach ($sets as $column => $_) {
            if (in_array('aes', $meta['columns'][$column]['styles'], true)) {
                $changed = true;
            }
        }
        if (!$changed) {
            return $sets;
        }
        foreach ($meta['columns'] as $column => $col) {
            if (!in_array('aes', $col['styles'], true) || isset($sets[$column])) {
                continue;
            }
            if ($this->row === null || !in_array($column, $this->row['names'], true)) {
                throw new OrmException(Code::CONFIG, "changing an AES column of {$meta['entity']} requires a row loaded with $column");
            }
            $v = $this->value($column);
            $sets[$column] = $v === null ? ['null' => true] : ['value' => $v];
        }
        return $sets;
    }

    /** Writes the changed columns; update(true) requires an unchanged update time. */
    public function update(bool $optimistic = false): static
    {
        [$db, $frame] = $this->executor();
        $meta = static::meta();
        $r = $this->writeRequest('update', $db);
        $keys = $this->keyValues();
        $loaded = $this->row !== null && $this->row['loaded'];
        foreach ($this->withAesColumns() as $column => $spec) {
            if (!$loaded && in_array($column, $meta['pk'], true)) {
                continue;
            }
            $r->ir['set'][] = $this->assignIr($r, $column, $spec);
        }
        if (($r->ir['set'] ?? []) === []) {
            return $this;
        }
        $this->keyWhere($r, $keys);
        $updated = $meta['updated'];
        if ($optimistic) {
            $version = $loaded && $updated !== '' ? self::resolved($this->row['original'][$updated] ?? null) : null;
            if ($version === null) {
                throw new OrmException(Code::CONFIG, 'update(true) requires a row loaded with its update time column');
            }
            $r->ir['optimistic'] = ['column' => $updated, 'p' => $r->param($version)];
        }
        $db->writeOf($frame, $r);
        if ($loaded) {
            foreach ($this->sets as $column => $spec) {
                if (in_array($column, $meta['pk'], true) && array_key_exists('value', $spec)) {
                    $this->row['original'][$column] = $spec['value'];
                }
            }
            unset($this->row['original'][$updated]);
        }
        $this->sets = [];
        return $this;
    }

    /** Updates the row when its primary key is known, otherwise creates it. */
    public function save(): static
    {
        $this->executor();
        try {
            $this->keyValues();
        } catch (OrmException) {
            return $this->create();
        }
        return $this->update();
    }

    /** Deletes the row; delete(true) first deletes loaded related rows that belong to it. */
    public function delete(bool $recursive = false): void
    {
        $this->executor();
        if ($recursive) {
            Db::inTransaction($this->conn, fn() => $this->deleteRow(true));
            return;
        }
        $this->deleteRow(false);
    }

    /** @internal */
    public function deleteRow(bool $recursive): void
    {
        [$db, $frame] = $this->executor();
        if ($recursive && $this->row !== null) {
            foreach ($this->row['related'] as $name => $v) {
                if (!($this->row['cascade'][$name] ?? false) || $v === null) {
                    continue;
                }
                if ($v instanceof Model) {
                    $v->deleteRow(true);
                } elseif ($v instanceof Collection) {
                    foreach ($v as $child) {
                        $child->deleteRow(true);
                    }
                }
            }
        }
        $r = $this->writeRequest('delete', $db);
        $this->keyWhere($r, $this->keyValues());
        $db->writeOf($frame, $r);
    }

    /** @internal the connection of a loaded row */
    public function connection(): ?Db
    {
        return $this->conn;
    }

    // ---- output ----

    /** @return list<array{0: string, 1: mixed}> */
    private function pairs(): array
    {
        $out = [];
        $seen = [];
        $add = static function (string $name, mixed $v) use (&$out, &$seen): void {
            if (isset($seen[$name])) {
                return;
            }
            $seen[$name] = true;
            $out[] = [$name, $v];
        };
        $st = $this->row;
        $names = $st['names'] ?? array_keys($this->sets);
        $meta = static::meta();
        foreach ($names as $name) {
            if (isset($st['hidden'][$name])) {
                continue;
            }
            if (isset($meta['columns'][$name])) {
                $add($name, self::arrayValue($this->value($name)));
            } else {
                $add($name, self::arrayValue($st['extra'][$name] ?? null));
            }
        }
        foreach ($this->news as $name => $v) {
            $add($name, self::arrayValue($v));
        }
        foreach ($st['related'] ?? [] as $name => $v) {
            $add($name, $v);
        }
        foreach ($st['flat'] ?? [] as $name) {
            $v = $st['related'][$name] ?? null;
            if ($v instanceof Model) {
                foreach ($v->pairs() as [$k, $cv]) {
                    $add($k, $cv);
                }
            }
        }
        return $out;
    }

    private static function arrayValue(mixed $v): mixed
    {
        return $v instanceof \DateTimeInterface ? $v->format('Y-m-d H:i:s.u') : $v;
    }

    /** @return array<string, mixed> the row values with related rows as arrays */
    public function toArray(): array
    {
        $out = [];
        foreach ($this->pairs() as [$name, $v]) {
            $out[$name] = $v instanceof Model || $v instanceof Collection ? $v->toArray() : $v;
        }
        return $out;
    }

    public function jsonSerialize(): mixed
    {
        $out = [];
        foreach ($this->pairs() as [$name, $v]) {
            $out[$name] = $v;
        }
        return (object) $out;
    }

    public function __clone()
    {
        // Builder arrays are values; related results and join children are shared on purpose.
    }
}

/** @internal the models of one statement and their join paths */
final class Frame
{
    /** @var array<int, string> */
    private array $paths = [];
    /** @var array<int, Model> */
    private array $parents = [];
    /** @var array<int, bool> */
    private array $placed = [];
    private int $rootId;

    public function __construct(private readonly Model $root, private readonly ?Model $outer)
    {
        $this->rootId = spl_object_id($root);
        $this->paths[$this->rootId] = '';
        $root->registerJoins($this, '');
    }

    public function add(Model $child, string $path, Model $parent): void
    {
        $id = spl_object_id($child);
        $this->paths[$id] = $path;
        $this->parents[$id] = $parent;
    }

    public function path(Model $m): string
    {
        return $this->paths[spl_object_id($m)];
    }

    public function joined(Model $m): bool
    {
        $id = spl_object_id($m);
        return $id !== $this->rootId && isset($this->paths[$id]);
    }

    public function parentOf(Model $m): ?Model
    {
        return $this->parents[spl_object_id($m)] ?? null;
    }

    public function place(Model $m): bool
    {
        $id = spl_object_id($m);
        if (isset($this->placed[$id])) {
            return false;
        }
        return $this->placed[$id] = true;
    }

    public function pathOf(Model $m): string
    {
        $id = spl_object_id($m);
        if (isset($this->paths[$id])) {
            return $this->paths[$id];
        }
        if ($this->outer !== null && $m === $this->outer) {
            return '^';
        }
        throw new OrmException(Code::CONFIG, $m::meta()['entity'] . ' is not part of the statement');
    }
}

/** @internal one statement under construction: the value-free IR and the values */
final class Request
{
    public array $ir;
    /** @var list<mixed> */
    public array $params = [];
    /** @var array<string, bool> */
    public array $names = [];
    /** @var array<int, list<array>> relations with their own connection, by parent model */
    public array $external = [];

    public function __construct(string $kind, Db $db)
    {
        $this->ir = ['ir_version' => 1, 'schema_hash' => Registry::schemaHash(), 'kind' => $kind];
    }

    public function param(mixed $v): int
    {
        $this->params[] = $v;
        return count($this->params) - 1;
    }

    /** @return array{expr: string, ps?: list<int>} */
    public function raw(string $sql, array $binds): array
    {
        if (substr_count($sql, '?') !== count($binds)) {
            throw new OrmException(Code::IR_INVALID, 'raw SQL has ' . substr_count($sql, '?') . ' placeholders and ' . count($binds) . ' binds');
        }
        $out = ['expr' => $sql];
        foreach ($binds as $b) {
            $out['ps'][] = $this->param($b);
        }
        return $out;
    }

    /** Rounds a list up to a power of two by repeating its last value. */
    public static function padIn(array $values): array
    {
        $n = 1;
        while ($n < count($values)) {
            $n <<= 1;
        }
        while (count($values) < $n) {
            $values[] = $values[count($values) - 1];
        }
        return $values;
    }

    /** The request with the parameter count, as the engine plans it. */
    public function shape(): array
    {
        return $this->ir + ['n_params' => count($this->params)];
    }
}

/** @internal loaded date text, converted to DateTimeImmutable when the column is first read */
final class PendingTime
{
    public function __construct(public readonly string $text, public readonly \DateTimeZone $zone) {}
}

/** @internal assembles the rows of one executed plan */
final class Assembly
{
    /** @var array<int, list<Model>> models made for each builder model */
    public array $made = [];

    public readonly \DateTimeZone $zone;

    public function __construct(public readonly Db $db, public readonly ?Db $conn, private readonly array $result, public readonly bool $track = false)
    {
        $this->zone = $db->zone();
    }

    public function stepAssemble(int $step): array
    {
        return $this->result['steps'][$step]['step']['assemble'];
    }

    /** @return list<list<mixed>> */
    public function related(array $ch, array $parent): array
    {
        $sr = $this->result['steps'][$ch['step']] ?? null;
        if ($sr === null) {
            return [];
        }
        $ifp = $sr['step']['parent']['if_parent'] ?? null;
        if ($ifp !== null && !Db::sameScalar($parent[$ifp['index']], $this->result['params'][$ifp['param']])) {
            return [];
        }
        $key = Db::rowKey($parent, $ch['parent_keys']);
        if ($key === null) {
            return [];
        }
        $out = [];
        foreach ($sr['byKey'][$key] ?? [] as $j) {
            $out[] = $sr['data'][$j];
        }
        return $out;
    }
}
