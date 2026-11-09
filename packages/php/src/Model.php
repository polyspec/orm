<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * A model is both the query under construction and a loaded row. Generated
 * classes add typed column getters and setters and the model metadata; every
 * other method name is resolved at call time with the grammar of docs/spec/dsl.md.
 */
abstract class Model implements \JsonSerializable, ModelMetadata
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
    private ?array $limit = null;
    private string $index = '';
    private string $lock = '';
    private string $aggFn = '';
    private string $agg = '';

    /**
     * @var list<array{left: string, right: string}> Relation key components: a pair per match<L>With<R>() call,
     *     added in call order
     */
    private array $matches = [];
    private string $alias = '';
    private bool $parentNode = false;
    private ?array $possible = null;
    private int $groupLimit = 0;
    private bool $deleteLock = false;
    /** @var ?array{string, int} the revision column and the expected revision of the next update or delete */
    private ?array $expectedRevision = null;
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
     *     extra: array<string, mixed>, extra_date?: array<string, bool>, related: array<string, mixed>,
     *     cascade: array<string, bool>,
     *     flat: list<string>}|null
     */
    private ?array $row = null;

    /** The entity of the model: the array of runtime model entities that RuntimeModel defines. */
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

    /** A negated group, NOT (…), as the first condition or after a connector written as a separate call. */
    public function not(\Closure $fn): static
    {
        return $this->negated('', $fn);
    }

    /** A negated group joined with AND. */
    public function andNot(\Closure $fn): static
    {
        return $this->negated('and', $fn);
    }

    /** A negated group joined with OR. */
    public function orNot(\Closure $fn): static
    {
        return $this->negated('or', $fn);
    }

    private function negated(string $conn, \Closure $fn): static
    {
        $g = new static();
        $g->groupOf = $this;
        $fn($g);
        if ($g->error !== null) {
            $this->error ??= $g->error;
        } elseif ($g->where['items'] === []) {
            $this->fail(trim("$conn not") . ' group callback added no condition');
        } elseif ($g->where['pending'] !== '') {
            $this->fail("connector {$g->where['pending']} without a following condition");
        } else {
            $this->addItem($conn, ['group' => $g->where['items'], 'not' => true]);
        }
        return $this;
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
        } elseif ($child->matches === []) {
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

    /**
     * Makes the next update() or delete() write only while the integer column holds $revision; update() also stores
     * $revision + 1. A mismatch fails with REVISION_CHANGED and changes nothing (docs/spec/dsl.md "Writes").
     */
    public function expectRevision(string $column, int $revision): static
    {
        $this->expectedRevision = [$column, $revision];
        return $this;
    }

    /**
     * Checks the expected revision before any statement and adds its condition to the key predicate of $r, and on an
     * update the bound increment of the column; null when no revision is expected.
     */
    private function revisionGuard(Request $r, bool $update, bool $optimistic): ?string
    {
        if ($this->expectedRevision === null) {
            return null;
        }
        [$column, $revision] = $this->expectedRevision;
        $meta = static::meta();
        $col = $meta['columns'][$column] ?? null;
        if (
            $col === null || !in_array($col['type'], ['i16', 'i32', 'i64'], true) || $col['codec'] !== []
            || in_array($column, $meta['pk'], true)
        ) {
            throw new OrmException(Code::CONFIG, "expectRevision: $column is not an integer column of "
                . "{$meta['entity']} outside its primary key");
        }
        if (isset($this->sets[$column])) {
            throw new OrmException(Code::CONFIG, "expectRevision: $column is also set in the write");
        }
        if ($optimistic) {
            throw new OrmException(Code::CONFIG, 'expectRevision does not combine with update(true)');
        }
        $r->ir['where']['items'][] = ['pred' => ['column' => $column, 'op' => 'eq',
            'p' => $r->param($revision), 'conn' => 'and']];
        if ($update) {
            $r->ir['set'][] = ['column' => $column, 'plus_p' => $r->param(1)];
        }
        return $column;
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
        throw new OrmException(Code::COLUMN_UNSELECTED, "$column was not selected");
    }

    protected function writeColumn(string $column, mixed $value): static
    {
        if ($this->groupOf !== null) {
            $this->fail('set is not allowed inside a group callback');
            return $this;
        }
        $col = static::meta()['columns'][$column];
        if ($col['type'] === 'decimal' && $value !== null) {
            if (!is_string($value)) {
                throw new OrmException(Code::CODEC_ENCODE, "$column requires exact decimal text");
            }
            $value = Decimal::normalize($value, $col['precision'], $col['scale']);
        }
        if (RuntimeModel::styled($col)) {
            if (!$value instanceof StyledValue) {
                throw new OrmException(Code::CODEC_ENCODE, "$column requires StyledValue");
            }
            if (!$col['nullable'] && $value->kind === 'sql-null') {
                throw new OrmException(Code::CODEC_ENCODE, "$column does not accept SQL NULL");
            }
            // The setter encodes the value by the codec stages of its column, without the host stages, and fails at the
            // call with the error of the first rule that the value meets, before the model changes (COD-73); the write
            // encodes it again.
            Codec::encode(array_values(array_filter(
                $col['codec'],
                static fn(string $s): bool => !Codec::isHostStyle($s),
            )), $value);
        }
        $stored = $value;
        if (in_array($col['type'], ['date', 'time', 'datetime'], true) && $value !== null) {
            if (!is_string($value)) {
                throw new OrmException(Code::CODEC_ENCODE, "$column requires its text form");
            }
            // The text is checked now, a nonzero fraction digit past p among it, and the bind layer checks it again
            // (DBS-121); the getter of a date or datetime returns the parsed time in the connection's zone (T189).
            try {
                $zone = $this->conn?->zone() ?? new \DateTimeZone('UTC');
                Db::timeValue($value, $col['type'], $col['type'] === 'date' ? 0 : $col['precision'], $zone);
                if ($col['type'] !== 'time') {
                    $stored = self::timeValue($value, $zone, $col['type']);
                }
            } catch (OrmException $error) {
                // A text that no time form reads is refused as a write (PRT-67, DBS-121); timeValue reports a read.
                $entity = static::meta()['entity'];
                $type = $col['type'];
                throw new OrmException(Code::CODEC_ENCODE, "$entity.$column: $type value is not a $type", $error);
            }
        }
        $this->values[$column] = $stored;
        $sqlNull = $value === null || ($value instanceof StyledValue && $value->kind === 'sql-null');
        $this->putSet($column, $sqlNull ? ['null' => true] : ['value' => $value]);
        return $this;
    }

    /** A loaded or set column value; loaded date text is converted on first read. */
    private function value(string $column): mixed
    {
        $v = $this->values[$column] ?? null;
        if ($v instanceof PendingTime) {
            $v = $this->values[$column] = self::timeValue($v->text, $v->zone, $v->type);
        }
        return $v;
    }

    private static function resolved(mixed $v): mixed
    {
        return $v instanceof PendingTime ? self::timeValue($v->text, $v->zone, $v->type) : $v;
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
        if ($col['codec'] !== []) {
            return $v;
        }
        return match ($col['type']) {
            'i16', 'i32', 'i64' => (int) $v,
            'f64' => (float) $v,
            'decimal' => is_string($v) ? Decimal::normalize($v, $col['precision'], $col['scale'])
                : throw new OrmException(Code::CODEC_DECODE, self::cellMessage('decimal')),
            'bool' => (bool) $v,
            'date', 'datetime' => self::timeValue($v, $zone, $col['type']),
            default => is_string($v) ? $v : (string) $v,
        };
    }

    /** A date or datetime as its time; any other value is the CODEC_DECODE of its type (COD-1), which names no value. */
    private static function timeValue(mixed $v, \DateTimeZone $zone, string $type): \DateTimeImmutable
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
            } catch (\Exception $e) {
                throw new OrmException(Code::CODEC_DECODE, self::cellMessage($type), $e);
            }
        }
        // A space or a T separates the date and the time (PRT-67).
        foreach (['Y-m-d H:i:s.u', 'Y-m-d H:i:s', 'Y-m-d\\TH:i:s.u', 'Y-m-d\\TH:i:s', 'Y-m-d'] as $format) {
            $t = \DateTimeImmutable::createFromFormat('!' . $format, $s, $zone);
            if ($t !== false) {
                return $t;
            }
        }
        throw new OrmException(Code::CODEC_DECODE, self::cellMessage($type));
    }

    /** The message of a cell that its column type refuses: one text per type, no value, no host type (COD-1). */
    private static function cellMessage(string $type): string
    {
        return match ($type) {
            'i16', 'i32', 'i64' => "$type cell is not an exact integer in its range",
            'f64' => 'f64 cell is not a finite number',
            'bool' => 'bool cell is not boolean',
            'decimal' => 'decimal cell is not a decimal of its precision and scale',
            'date', 'datetime', 'time' => "$type cell is not a $type",
            'bytes' => 'bytes cell is not bytes',
            default => "$type cell is not text",
        };
    }

    /** The refusal of a read cell: CODEC_DECODE: <entity>.<column>: <message> (COD-1, COD-41). */
    private static function cellRefusal(
        string $entity,
        string $name,
        string $message,
        ?\Throwable $previous = null,
    ): OrmException {
        return new OrmException(Code::CODEC_DECODE, "$entity.$name: $message", $previous);
    }

    /**
     * The value of a read cell of a column type, the cells of TypeScript in every client (COD-1). An integer is an
     * int, a float with no fraction, or, when $integerText holds, its exact digits as text: a model column reads them
     * where a driver sends an integer as text, which is not SQLite, whose text is a stored text, and a group or an
     * added column reads them on every database (INT-160). An f64 is a number or the decimal text of one; a text is a
     * string that is valid UTF-8; a date, a datetime and a time are their text forms, a datetime and a time with no
     * fraction digit beyond the precision. Any other cell is refused, never coerced.
     * @param array<string, mixed> $col
     */
    private static function cellValue(
        string $entity,
        string $name,
        array $col,
        mixed $v,
        bool $sqlite,
        bool $integerText,
        \DateTimeZone $zone,
    ): mixed {
        $type = $col['type'];
        if (is_resource($v)) {
            $v = stream_get_contents($v);
            if ($v === false) {
                throw self::cellRefusal($entity, $name, self::cellMessage($type));
            }
        }
        switch ($type) {
            case 'i16':
            case 'i32':
            case 'i64':
                [$low, $high] = match ($type) {
                    'i16' => [-32768, 32767],
                    'i32' => [-2147483648, 2147483647],
                    default => [PHP_INT_MIN, PHP_INT_MAX],
                };
                if (is_int($v)) {
                    $n = $v;
                } elseif (
                    is_float($v) && is_finite($v) && floor($v) === $v
                    && $v >= -9.2233720368547758E18 && $v < 9.2233720368547758E18
                ) {
                    $n = (int) $v;
                } elseif ($integerText && is_string($v) && preg_match('/^-?(?:0|[1-9][0-9]*)$/D', $v) === 1) {
                    $n = filter_var($v, FILTER_VALIDATE_INT);
                } else {
                    $n = false;
                }
                if ($n === false || $n < $low || $n > $high) {
                    throw self::cellRefusal($entity, $name, self::cellMessage($type));
                }
                return $n;
            case 'f64':
                $number = is_string($v)
                    && preg_match('/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/D', $v) === 1;
                $f = is_int($v) || is_float($v) || $number ? (float) $v : NAN;
                if (!is_finite($f)) {
                    throw self::cellRefusal($entity, $name, self::cellMessage($type));
                }
                return $f;
            case 'bool':
                return match ($v) {
                    true, 1, '1', 't', 'true' => true,
                    false, 0, '0', 'f', 'false' => false,
                    default => throw self::cellRefusal($entity, $name, self::cellMessage($type)),
                };
            case 'decimal':
                try {
                    return $sqlite
                        ? Decimal::fromScaled($v, $col['precision'], $col['scale'])
                        : Decimal::decode($v, $col['precision'], $col['scale']);
                } catch (OrmException $error) {
                    throw self::cellRefusal($entity, $name, self::cellMessage($type), $error);
                }
            case 'date':
            case 'datetime':
                if ($v instanceof \DateTimeInterface) {
                    // A time that the driver read; a datetime has no fraction digit beyond its precision.
                    if ($type === 'date' || (int) $v->format('u') % (10 ** (6 - $col['precision'])) === 0) {
                        return \DateTimeImmutable::createFromInterface($v)->setTimezone($zone);
                    }
                    throw self::cellRefusal($entity, $name, self::cellMessage($type));
                }
                $text = is_string($v) ? self::timeText($type, $v, $type === 'date' ? 0 : $col['precision']) : null;
                if ($text === null) {
                    throw self::cellRefusal($entity, $name, self::cellMessage($type));
                }
                // The text is checked now; the getter parses it in the connection's zone when it is first read (T189).
                return new PendingTime($text, $zone, $type);
            case 'time':
                $text = is_string($v) ? self::timeText($type, $v, $col['precision']) : null;
                if ($text === null) {
                    throw self::cellRefusal($entity, $name, self::cellMessage($type));
                }
                return $text;
            case 'bytes':
                if (!is_string($v)) {
                    throw self::cellRefusal($entity, $name, self::cellMessage($type));
                }
                return $v;
        }
        if (!is_string($v)) {
            throw self::cellRefusal($entity, $name, self::cellMessage($type));
        }
        // COD-69: a text cell that is not valid UTF-8 is refused, never returned as its bytes.
        if (preg_match('//u', $v) !== 1) {
            throw self::cellRefusal($entity, $name, 'text is not valid UTF-8');
        }
        return $v;
    }

    /**
     * The canonical text of a date, a time or a datetime cell, or null when the text is none: a date YYYY-MM-DD of a
     * real day; a time HH:MM:SS with a fraction of up to nine digits, none beyond the precision but zeros; a datetime
     * YYYY-MM-DD HH:MM:SS (or with T) of a real instant with such a fraction and an optional Z or offset. A datetime is
     * written with six fraction digits and its offset, the forms that timeValue reads.
     */
    private static function timeText(string $type, string $text, int $precision): ?string
    {
        if ($type === 'date') {
            return preg_match('/^(\d{4})-(\d{2})-(\d{2})$/D', $text, $m) === 1
                && self::validDate((int) $m[1], (int) $m[2], (int) $m[3]) ? $text : null;
        }
        if ($type === 'time') {
            if (
                preg_match('/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/D', $text, $m) !== 1
                || $m[1] > '23' || $m[2] > '59' || $m[3] > '59'
            ) {
                return null;
            }
            $fraction = self::fractionDigits($m[4] ?? '', $precision);
            return $fraction === null ? null : "$m[1]:$m[2]:$m[3]$fraction";
        }
        if (
            preg_match(
                '/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/D',
                $text,
                $m,
            ) !== 1
            || !self::validDate((int) $m[1], (int) $m[2], (int) $m[3]) || $m[4] > '23' || $m[5] > '59' || $m[6] > '59'
            || self::fractionDigits($m[7] ?? '', $precision) === null
        ) {
            return null;
        }
        $micro = substr(str_pad($m[7] ?? '', 6, '0'), 0, 6);
        $offset = ($m[8] ?? '') === 'Z' ? '+00:00' : ($m[8] ?? '');
        return "$m[1]-$m[2]-$m[3] $m[4]:$m[5]:$m[6].$micro$offset";
    }

    /** Whether a year, a month and a day name a day of the proleptic Gregorian calendar, the year 0000 included. */
    private static function validDate(int $year, int $month, int $day): bool
    {
        if ($month < 1 || $month > 12 || $day < 1) {
            return false;
        }
        $leap = ($year % 4 === 0 && $year % 100 !== 0) || $year % 400 === 0;
        return $day <= ($month === 2 ? ($leap ? 29 : 28) : [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][$month - 1]);
    }

    /** The fraction of a time text at its precision, or null when a digit beyond the precision is not zero. */
    private static function fractionDigits(string $digits, int $precision): ?string
    {
        $all = str_pad($digits, $precision, '0');
        if (trim(substr($all, $precision), '0') !== '') {
            return null;
        }
        return $precision === 0 ? '' : '.' . substr($all, 0, $precision);
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
                throw new OrmException(Code::CONFIG, "$name accepts "
                    . (count($keys) === 1 ? 'one column function' : 'no argument'));
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
            [$left, $right] = Chain::pair(null, $meta, substr($name, 5));
            $this->matches[] = ['left' => $left, 'right' => $right];
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
        if (self::prefixed($name, 'addColumn')) {
            return $this->addColumnCall($name, substr($name, 9), $args);
        }
        foreach (['removeColumn', 'groupBy', 'keyName', 'plus', 'minus', 'sum', 'avg'] as $prefix) {
            if (!self::prefixed($name, $prefix)) {
                continue;
            }
            $column = Chain::columnName($meta, substr($name, strlen($prefix)));
            if ($column === '') {
                continue;
            }
            $numeric = RuntimeModel::numeric($meta['columns'][$column]);
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
            $column = Chain::schemaColumnName($meta['manifest_hash'], substr($name, 8));
            if ($column === '') {
                throw new OrmException(Code::CONFIG, "$name: no model has the column " . substr($name, 8));
            }
            $this->possible = ['column' => $column, 'value' => $args[0]];
            return $this;
        }
        if (self::prefixed($name, 'forceIndex')) {
            self::arity($name, $args, 0);
            $index = Chain::snake(substr($name, 10));
            if (!isset($meta['indexes'][$index])) {
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
        return strlen($name) > strlen($prefix) && str_starts_with($name, $prefix)
            && ctype_upper($name[strlen($prefix)]);
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
                if (!$arg instanceof Func || !$arg->column) {
                    throw new OrmException(Code::CONFIG, "$name takes a column function");
                }
                $this->outputs[$key] = ['fn' => [$column, $arg]];
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
    /**
     * Adds the conditions of one chain call. An error of a value is the error of the builder call: it is recorded, and
     * the terminal returns the first one before it sends a statement (INT-88).
     */
    private function whereChain(string $conn, array $keys, array $args): void
    {
        $i = 0;
        foreach ($keys as $k => $key) {
            if ($i >= count($args)) {
                $this->fail('the condition expects ' . count($keys) . ' values');
                return;
            }
            $value = $args[$i++];
            try {
                [$pred, $extra] = $this->predicate($key, $value, array_slice($args, $i), count($keys) === 1);
                self::validateHostInput(static::meta()['columns'], $pred);
            } catch (OrmException $error) {
                $this->error ??= $error;
                return;
            }
            $i += $extra;
            $this->addItem($k === 0 ? $conn : $key['conn'], ['pred' => $pred]);
        }
        if ($i !== count($args)) {
            $this->fail('the condition expects ' . count($keys) . ' values, got ' . count($args));
        }
    }

    /** Refuses a condition value of an `ip` column here, since a dialect that encodes it in SQL would read it as NULL (COD-38). */
    private static function validateHostInput(array $columns, array $pred): void
    {
        if (!array_key_exists('value', $pred) || ($pred['kind'] ?? '') === 'fulltext') {
            return;
        }
        $check = static function (string $column, mixed $value) use ($columns): void {
            foreach (is_array($value) ? $value : [$value] as $item) {
                if ($item !== null && in_array('ip', $columns[$column]['codec'] ?? [], true)) {
                    Codec::hostEncode($item, ['ip'], '');
                }
            }
        };
        if ($pred['kind'] === 'tuple') {
            foreach ($pred['value'] as $row) {
                foreach ($pred['cols'] as $index => $column) {
                    $check($column, $row[$index]);
                }
            }
            return;
        }
        $check($pred['column'], $pred['value']);
    }

    private const OPERATORS = ['' => 'eq', 'ne' => 'not_eq', 'gt' => 'gt', 'lt' => 'lt', 'ge' => 'gte',
        'le' => 'lte', 'lk' => 'contains', 'lb' => 'contains_binary'];

    /** @return array{0: array, 1: int} */
    private function predicate(array $key, mixed $value, array $rest, bool $single): array
    {
        if ($key['op'] === 'fulltext' || $key['op'] === 'fulltext_boolean') {
            return [['op' => $key['op'], 'cols' => $key['columns'], 'value' => $value, 'kind' => 'fulltext'], 0];
        }
        $meta = static::meta();
        $column = $key['column'];
        $p = ['column' => $column];
        switch ($key['op']) {
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
                        throw new OrmException(
                            Code::CONFIG,
                            'each tuple value group needs ' . count($key['columns']) . ' values'
                        );
                    }
                }
                return [['op' => $key['op'] === 'tuple' ? 'tuple_in' : 'tuple_not_in', 'cols' => $key['columns'],
                    'value' => $value, 'kind' => 'tuple'], 0];
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
            return [$p + ['op' => self::OPERATORS[$key['op']] . '_col', 'ref' => $value,
                'refCol' => $key['compare'], 'kind' => 'ref'], 0];
        }
        $op = self::OPERATORS[$key['op']];
        $eq = $key['op'] === '' || $key['op'] === 'ne';
        // contains binds NULL as its value, which matches no row (docs/spec/protocol.md §2).
        if ($value === null && ($key['op'] === 'lk' || $key['op'] === 'lb')) {
            return [$p + ['op' => $op, 'value' => null, 'kind' => 'value'], 0];
        }
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
                    throw new OrmException(
                        Code::CONFIG,
                        'a column function is accepted only by a single-key condition'
                    );
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
            return [$p + ['op' => $key['op'] === 'ne' ? 'not_in' : 'in', 'value' => array_values($value),
                'kind' => 'list'], 0];
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
        $r = new Request($kind, static::manifestHash());
        // possible<Col>() applies only to a relation child, which has a parent row to compare (DSL-85).
        if ($this->possible !== null) {
            throw new OrmException(Code::CONFIG, 'possible applies only to a relation child');
        }
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
        // A joined model reaches the statement through this call only, and its class is first compared here.
        Registry::verify(static::class);
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
            if ($child->possible !== null) {
                throw new OrmException(Code::CONFIG, 'possible applies only to a relation child');
            }
            $childQuery = $child->query($r, $f);
            if ($child->on !== null) {
                $childQuery['on'] = $child->groupIr($child->on, $r, $f);
            }
            $q['joins'][] = ['rel' => $name, 'kind' => $j['kind'], 'query' => $childQuery, 'left' => $j['left'],
                'right' => $j['right']];
        }
        if ($this->where['items'] !== []) {
            $q['where'] = $this->groupIr($this->where['items'], $r, $f);
        }
        $relationNames = [];
        foreach ($this->relations as $rel) {
            $child = $rel['child'];
            $name = $child->resultName($rel['many']);
            if (isset($relationNames[$name])) {
                throw new OrmException(
                    Code::CONFIG,
                    "relation result name $name is used twice; call alias<Name>() on one of them",
                );
            }
            $relationNames[$name] = true;
            if ($child->conn !== null) {
                if ($child->limit !== null) {
                    throw new OrmException(
                        Code::LIMIT_IN_RELATION,
                        $child::meta()['entity'] . ' relation uses limit; use groupLimit'
                    );
                }
                $r->external[spl_object_id($this)][] = $rel;
                continue;
            }
            $q['relations'][] = $child->relationIr($rel['many'], $r);
        }
        foreach ($this->order as $o) {
            if (isset($o['random'])) {
                $q['order'][] = ['random' => true];
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
            throw new OrmException(
                Code::LIMIT_IN_RELATION,
                static::meta()['entity'] . ' relation uses limit; use groupLimit'
            );
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
        return ['rel' => $this->resultName($many), 'query' => $q, 'kind' => $many ? 'many' : 'one',
            'keys' => $this->matches];
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
            if (isset($spec['fn'])) {
                [$column, $fn] = $spec['fn'];
                $out['fn'][$name] = ['column' => $column, 'fn' => $fn->ir($r->param(...))];
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
        if ($this->possible !== null) {
            throw new OrmException(Code::CONFIG, 'possible applies only to a relation child');
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
            } elseif (isset($node['group'])) {
                $group = $this->groupIr($node['group'], $r, $f);
                if ($conn !== '') {
                    $group['conn'] = $conn;
                }
                if (!empty($node['not'])) {
                    $group['not'] = true;
                }
                $out['items'][] = ['group' => $group];
            } else {
                $child = $node['joined'];
                if (!$f->joined($child)) {
                    throw new OrmException(Code::CONFIG, $child::meta()['entity'] . ' is not joined in the statement');
                }
                if ($f->parentOf($child) !== $this->subject()) {
                    throw new OrmException(
                        Code::CONFIG,
                        $child::meta()['entity'] . ' conditions must be placed in the model it is joined to'
                    );
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
        if (!in_array($p['kind'], ['tuple', 'fulltext'], true)) {
            $out['column'] = $p['column'];
        }
        $out['op'] = $p['op'];
        switch ($p['kind']) {
            case 'tuple':
                $out['cols'] = $p['cols'];
                foreach (Request::padIn($p['value']) as $row) {
                    foreach ($row as $v) {
                        $out['ps'][] = $r->param($v);
                    }
                }
                break;
            case 'fulltext':
                $out['cols'] = $p['cols'];
                $out['p'] = $r->param($p['value']);
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
     * conversion ([index, name] or [index, name, kind]), the loaded names, the hidden names and the names whose
     * loaded value is kept for
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
        $shape = ['int' => [], 'float' => [], 'decimal' => [], 'bool' => [], 'date' => [], 'string' => [],
            'codec' => [], 'extra' => [],
            'names' => [], 'hidden' => [], 'original' => [], 'key' => null];
        foreach ($asm['columns'] as $col) {
            $name = $col['name'];
            $shape['names'][] = $name;
            if (!empty($col['hidden'])) {
                $shape['hidden'][$name] = true;
            }
            if (($col['column'] ?? '') === $name && isset($meta['columns'][$name])) {
                $mc = $meta['columns'][$name];
                // A codec column has already been turned into a value by Codec::decodeRows.
                $kind = $mc['codec'] !== [] ? 'codec' : $mc['type'];
                $group = match ($kind) {
                    'i16', 'i32', 'i64' => 'int',
                    'f64' => 'float',
                    'decimal' => 'decimal',
                    'bool' => 'bool',
                    'date', 'datetime' => 'date',
                    'codec' => 'codec',
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
            // A bool or datetime key goes through keyCells: its cell is an integer or a text, and the key keeps the
            // declared type (INT-11, PRT-35).
            $typed = false;
            foreach ($asm['columns'] as $col) {
                $typed = $typed
                    || (
                        $col['index'] === $asm['key'][0]['index'] && in_array($col['type'], ['bool', 'datetime'], true)
                    );
            }
            if (!$typed) {
                $shape['key'] = $asm['key'][0]['index'];
            }
        }
        $shape['row'] = ['loaded' => true, 'names' => $shape['names'], 'hidden' => $shape['hidden'],
            'original' => [], 'extra' => [], 'related' => [], 'cascade' => [], 'flat' => []];
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
        $meta = static::meta();
        $entity = $meta['entity'];
        $sqlite = $a->db->dialect() === 'sqlite';
        foreach (['int', 'float', 'decimal', 'bool', 'date', 'string'] as $group) {
            foreach ($shape[$group] as [$index, $name]) {
                $v = $vals[$index];
                if ($v === null) {
                    $values[$name] = null;
                } elseif ($name === $meta['aes_version']) {
                    // COD-44, COD-53: the key version column holds a stored version, its digits read as its number.
                    try {
                        $values[$name] = AesKeyring::storedVersion($v);
                    } catch (OrmException $error) {
                        throw self::cellRefusal($entity, $name, 'aes version is not a positive 32-bit integer', $error);
                    }
                } else {
                    $col = $meta['columns'][$name];
                    $values[$name] = self::cellValue($entity, $name, $col, $v, $sqlite, !$sqlite, $zone);
                }
            }
        }
        foreach ($shape['codec'] as [$index, $name]) {
            $values[$name] = $vals[$index];
        }
        $m->values = $values;
        foreach ($shape['extra'] as [$index, $name, $kind]) {
            $v = $vals[$index];
            if (is_resource($v)) {
                $v = stream_get_contents($v);
            }
            // INT-160: an added column is decoded by the type of its plan column; an integer may be its exact digits as
            // text, and a datetime has the precision 6 of an expression.
            $st['extra'][$name] = $v === null ? null : match ($kind) {
                'i16', 'i32', 'i64', 'f64', 'bool', 'date', 'datetime' => self::resolved(self::cellValue(
                    $entity,
                    $name,
                    ['type' => $kind, 'precision' => 6],
                    $v,
                    $sqlite,
                    true,
                    $zone,
                )),
                default => $v,
            };
            if ($kind === 'date') {
                $st['extra_date'][$name] = true;
            }
        }
        foreach ($shape['original'] as $name) {
            $st['original'][$name] = $values[$name] ?? null;
        }
        $m->news = $this->news;
        foreach ($asm['children'] ?? [] as $ch) {
            if ($ch['kind'] === 'join') {
                $child = $this->joinChild($ch['rel']);
                $value = null;
                $jrow = $a->joinRow($ch, $vals);
                if ($jrow !== null) {
                    $value = $child->assembleRow($a, $ch['assemble'], $jrow);
                }
                $st['related'][$ch['rel']] = $value;
                $st['cascade'][$ch['rel']] = false;
                continue;
            }
            [$child, $many] = $this->relationChild($ch['rel']);
            $rows = $a->related($ch, $vals);
            $childAsm = $a->relationAssemble($ch);
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

    private function collectionKey(Model $m, array $asm, array $vals): int|string|bool|Bytes|\DateTimeInterface
    {
        if ($this->fetchKey !== null) {
            return Collection::keyOf(($this->fetchKey)($m));
        }
        if ($this->keyName !== '') {
            return Collection::keyOf(array_key_exists($this->keyName, $m->values) ? $m->value($this->keyName)
                : $m->row['extra'][$this->keyName] ?? null);
        }
        $key = Db::rowKey(self::keyCells($asm, $vals), $asm['key']);
        if ($key === null) {
            throw new OrmException(Code::CODEC_DECODE, 'collection row identity contains SQL NULL');
        }
        return $key;
    }

    /**
     * The row whose key cells hold the declared type of their column: a bool column reads as an integer on MySQL and
     * SQLite, and a datetime column as its text (INT-11, PRT-35).
     */
    private static function keyCells(array $asm, array $vals): array
    {
        foreach ($asm['key'] as $ref) {
            $index = $ref['index'];
            $cell = $vals[$index] ?? null;
            if ($cell === null) {
                continue;
            }
            foreach ($asm['columns'] as $column) {
                if ($column['index'] !== $index) {
                    continue;
                }
                if ($column['type'] === 'bool') {
                    $vals[$index] = (bool) $cell;
                } elseif ($column['type'] === 'datetime' && is_string($cell)) {
                    $vals[$index] = new \DateTimeImmutable($cell . ' UTC');
                }
                break;
            }
        }
        return $vals;
    }

    /** @return Collection<static> */
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

    /**
     * Returns the model's relation key component values in key order. If any component is null, returns null.
     *
     * @return list<mixed>|null
     */
    private function matchValues(Model $m, string $side): ?array
    {
        $values = [];
        foreach ($this->matches as $k) {
            $v = $m->columnOrExtra($k[$side]);
            if ($v === null) {
                return null;
            }
            $values[] = $v;
        }
        return $values;
    }

    /** @param list<mixed> $values The collection key of the relation key component values. */
    private static function matchKey(array $values): string
    {
        if (count($values) === 1) {
            return Db::scalarText($values[0]);
        }
        $out = '';
        foreach ($values as $v) {
            $part = Db::scalarText($v);
            $out .= strlen($part) . ':' . $part;
        }
        return $out;
    }

    /** @param list<Model> $parents */
    private function attachExternal(array $parents, bool $many): void
    {
        $values = [];
        $seen = [];
        foreach ($parents as $p) {
            if (
                $this->possible !== null
                && !Db::sameScalar($p->columnOrExtra($this->possible['column']), $this->possible['value'])
            ) {
                continue;
            }
            $v = $this->matchValues($p, 'left');
            if ($v === null || isset($seen[self::matchKey($v)])) {
                continue;
            }
            $seen[self::matchKey($v)] = true;
            $values[] = count($v) === 1 ? $v[0] : $v;
        }
        $byKey = [];
        if ($values !== []) {
            $q = clone $this;
            $q->matches = [];
            $q->alias = '';
            // The parents above are the ones that possible<Col>() keeps, so the statement of the child has no possible.
            $q->possible = null;
            $rights = array_column($this->matches, 'right');
            // A composite key filters the whole child key column as a tuple.
            $match = count($rights) === 1
                ? ['pred' => ['column' => $rights[0], 'op' => 'in', 'value' => $values, 'kind' => 'list']]
                : ['pred' => ['op' => 'tuple_in', 'cols' => $rights, 'value' => $values, 'kind' => 'tuple']];
            if ($q->where['items'] !== []) {
                $q->where['items'] = [['conn' => '', 'group' => $q->where['items']], $match + ['conn' => 'and']];
            } else {
                $q->where['items'] = [$match + ['conn' => '']];
            }
            foreach ($q->gets()->entries() as [$key, $m]) {
                $v = $this->matchValues($m, 'right');
                if ($v === null) {
                    continue;
                }
                $k = self::matchKey($v);
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
            $v = $this->matchValues($p, 'left');
            $matched = $v === null ? [] : $byKey[self::matchKey($v)] ?? [];
            if (
                $this->possible !== null
                && !Db::sameScalar($p->columnOrExtra($this->possible['column']), $this->possible['value'])
            ) {
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

    /** @return Collection<static> */
    private function load(string $kind): Collection
    {
        [$db, $frame] = $this->executor();
        $r = $this->build($kind, $db);
        [$plan, $result] = $db->select($frame, $r);
        return $this->assemble($db, $r, $plan, $result);
    }

    /** The first matching row; null when no row matches. */
    public function get(): ?static
    {
        return $this->load('one')->first();
    }

    /**
     * The matching rows.
     *
     * @return Collection<static>
     */
    public function gets(): Collection
    {
        return $this->load('all');
    }

    /** Grouped values with checked row counts, without partial model rows. */
    public function getsCount(): GroupRows
    {
        [$db, $frame] = $this->executor();
        $request = $this->build('group_count', $db);
        if ($request->external !== []) {
            throw new OrmException(Code::CONFIG, 'group count cannot return relations');
        }
        [$plan, $result] = $db->select($frame, $request);
        return $this->groupRowsOf($db, $plan, $result);
    }

    /**
     * One page of the models of gets and whether a next page exists, read by one statement that reads one row past
     * the page and counts nothing (INT-164).
     *
     * @return LookaheadPage<static>
     */
    public function getsLookaheadPage(int $page, int $perPage): LookaheadPage
    {
        [$db, $frame, $q, $r] = $this->lookaheadRequest('lookahead_paginate', $page, $perPage);
        [$plan, $result, $hasNext] = $db->lookahead($frame, $r, $perPage);
        return new LookaheadPage($q->assemble($db, $r, $plan, $result), $page, $perPage, $hasNext);
    }

    /**
     * One page of the group rows of getsCount and whether a next page exists, read by one statement that reads one
     * group past the page and counts nothing (INT-164).
     */
    public function getsCountLookaheadPage(int $page, int $perPage): GroupLookaheadPage
    {
        [$db, $frame, , $r] = $this->lookaheadRequest('group_lookahead_paginate', $page, $perPage);
        if ($r->external !== []) {
            throw new OrmException(Code::CONFIG, 'group count cannot return relations');
        }
        [$plan, $result, $hasNext] = $db->lookahead($frame, $r, $perPage);
        return new GroupLookaheadPage($this->groupRowsOf($db, $plan, $result), $page, $perPage, $hasNext);
    }

    /**
     * The arguments of a lookahead page checked and its request of kind built, whose root limit reads one row past
     * the page.
     *
     * @return array{0: Db, 1: ?TxFrame, 2: static, 3: Request}
     */
    private function lookaheadRequest(string $kind, int $page, int $perPage): array
    {
        if ($page < 1 || $perPage < 1) {
            throw new OrmException(Code::CONFIG, 'getsLookaheadPage requires a positive page and perPage');
        }
        if ($this->limit !== null) {
            throw new OrmException(Code::CONFIG, 'getsLookaheadPage cannot be combined with limit');
        }
        [$db, $frame] = $this->executor();
        $q = clone $this;
        $q->limit = ['offset' => ($page - 1) * $perPage, 'count' => $perPage + 1];
        return [$db, $frame, $q, $q->build($kind, $db)];
    }

    /** The group rows of the main step of a group_count or a group_lookahead_paginate result. */
    private function groupRowsOf(Db $db, array $plan, array $result): GroupRows
    {
        $columns = $plan['steps'][0]['assemble']['columns'] ?? null;
        if (!is_array($columns)) {
            throw new OrmException(Code::INTERNAL, 'group count has no result declaration');
        }
        $names = [];
        foreach ($columns as $column) {
            if (!empty($column['hidden'])) {
                continue;
            }
            $name = $column['name'];
            if ($name === '' || isset($names[$name])) {
                throw new OrmException(Code::CONFIG, "group result repeats or omits column $name");
            }
            $names[$name] = true;
        }
        if (!isset($names['row_count'])) {
            throw new OrmException(Code::INTERNAL, 'group result has no row_count');
        }
        $rows = [];
        foreach ($result['main'] as $values) {
            $entries = [];
            foreach ($columns as $column) {
                if (!empty($column['hidden'])) {
                    continue;
                }
                $index = $column['index'];
                if (!array_key_exists($index, $values)) {
                    throw new OrmException(Code::INTERNAL, "group result column {$column['name']} is missing");
                }
                $entries[] = [$column['name'], $this->groupValue($db, $column, $values[$index])];
            }
            $rows[] = new GroupRow($entries);
        }
        return new GroupRows($rows);
    }

    private function groupValue(Db $db, array $column, mixed $raw): mixed
    {
        $name = $column['name'];
        if ($name === 'row_count') {
            return $raw;
        }
        $declared = ($column['column'] ?? '') === $name ? (static::meta()['columns'][$name] ?? null) : null;
        if ($raw === null) {
            if ($declared !== null && !$declared['nullable']) {
                throw new OrmException(Code::CODEC_DECODE, "group column $name is SQL NULL");
            }
            return null;
        }
        $type = $declared['type'] ?? $column['type'];
        if ($declared !== null && RuntimeModel::styled($declared)) {
            if (!$raw instanceof StyledValue) {
                throw new OrmException(Code::CODEC_DECODE, "group column $name is not StyledValue");
            }
            return $raw;
        }
        if ($type === 'decimal' && $declared === null) {
            throw new OrmException(Code::INTERNAL, "decimal group column $name has no declaration");
        }
        // A group column is refused as a model column is, by its entity and name (COD-1), and reads an integer from its
        // exact digits on every database; a datetime of an expression has the precision 6.
        $value = self::resolved(self::cellValue(
            static::meta()['entity'],
            $name,
            $declared ?? ['type' => $type, 'precision' => 6],
            $raw,
            $db->dialect() === 'sqlite',
            true,
            $db->zone(),
        ));
        // A bytes column without a codec stage holds its bytes as a Bytes, as the array form of a model (COD-27).
        return $type === 'bytes' && ($declared['codec'] ?? []) === [] ? new Bytes($value) : $value;
    }

    public function getCount(): int
    {
        [$db, $frame] = $this->executor();
        return (int) $db->scalarOf($frame, $this->build('count', $db));
    }

    /** The SQL SUM; 0.0 when SQL gives null (no row, or every value null). */
    public function getSum(): float
    {
        return $this->aggregate('sum') ?? 0.0;
    }

    /** The SQL AVG; null when SQL gives null (no row, or every value null). */
    public function getAvg(): ?float
    {
        return $this->aggregate('avg');
    }

    private function aggregate(string $fn): ?float
    {
        if ($this->aggFn !== $fn) {
            throw new OrmException(Code::CONFIG, "get" . ucfirst($fn) . " requires $fn<Col>()");
        }
        [$db, $frame] = $this->executor();
        $r = $this->build($fn, $db);
        $r->ir['agg'] = $this->agg;
        try {
            $value = $db->scalarOf($frame, $r);
        } catch (OrmException $error) {
            throw self::aggregateRangeError($error);
        }
        // The planner has checked the column, so the column of the model is there.
        $col = static::meta()['columns'][$this->agg]
            ?? throw new OrmException(Code::INTERNAL, "{$this->agg} is missing from a planned aggregate");
        // SQLite and markdown hold a decimal as the integer value × 10^scale, and so its sum (DIA-25).
        $scaled = $db->dialect() === 'sqlite';
        if (!is_array($value) || !array_is_list($value) || $value === []) {
            throw new OrmException(Code::INTERNAL, "a $fn statement read no row of sums");
        }
        if ($fn === 'sum') {
            $sum = self::sumOf($value);
            return $sum === null ? null : self::sumValue($col, $sum, $scaled);
        }
        $count = array_pop($value);
        return self::avgValue($col, self::sumOf($value), $count, $scaled);
    }

    /**
     * The sum of the sum cells of a statement: its one cell, or the exact integer hi × 2^32 + lo of the two cells of a
     * split sum, as its decimal text (DIA-202); null when both are null, the sum of no value.
     *
     * @param list<mixed> $cells
     */
    private static function sumOf(array $cells): mixed
    {
        if (count($cells) === 1) {
            return $cells[0];
        }
        [$high, $low] = $cells;
        if ($high === null && $low === null) {
            return null;
        }
        $integer = static function (mixed $cell): int {
            if (is_string($cell) && preg_match('/^-?[0-9]+$/D', $cell) === 1 && (string) (int) $cell === $cell) {
                return (int) $cell;
            }
            return is_int($cell) ? $cell : throw new OrmException(Code::CODEC_DECODE, self::AGGREGATE_REFUSED);
        };
        $high = $integer($high);
        $low = $integer($low);
        // high × 2^32 = high × 65536 × 65536, each product of a digit and 65536 plus a carry is below 2^21.
        $digits = self::scaleDigits((string) abs($high), 65536);
        $digits = self::scaleDigits($digits, 65536);
        if ($high >= 0) {
            return self::addDigits($digits, (string) $low);
        }
        // high < 0 and low >= 0: high × 2^32 + low = -(|high| × 2^32 - low), and |high| × 2^32 >= 2^32 > low only when
        // low is below it; otherwise the result is low - |high| × 2^32 >= 0.
        $magnitude = self::subtractDigits($digits, (string) $low);
        if ($magnitude === null) {
            return self::subtractDigits((string) $low, $digits);
        }
        return $magnitude === '0' ? '0' : "-$magnitude";
    }

    /** The decimal digits times a factor below 2^31. */
    private static function scaleDigits(string $digits, int $factor): string
    {
        $out = '';
        $carry = 0;
        for ($i = strlen($digits) - 1; $i >= 0; $i--) {
            $product = (ord($digits[$i]) - 48) * $factor + $carry;
            $out = (string) ($product % 10) . $out;
            $carry = intdiv($product, 10);
        }
        $out = ($carry > 0 ? (string) $carry : '') . $out;
        $out = ltrim($out, '0');
        return $out === '' ? '0' : $out;
    }

    /** The sum of two decimal digit strings. */
    private static function addDigits(string $a, string $b): string
    {
        $out = '';
        $carry = 0;
        for ($i = strlen($a) - 1, $j = strlen($b) - 1; $i >= 0 || $j >= 0 || $carry > 0; $i--, $j--) {
            $digit = ($i >= 0 ? ord($a[$i]) - 48 : 0) + ($j >= 0 ? ord($b[$j]) - 48 : 0) + $carry;
            $out = (string) ($digit % 10) . $out;
            $carry = intdiv($digit, 10);
        }
        $out = ltrim($out, '0');
        return $out === '' ? '0' : $out;
    }

    /** The difference a - b of two decimal digit strings, or null when b is greater than a. */
    private static function subtractDigits(string $a, string $b): ?string
    {
        $a = ltrim($a, '0');
        $b = ltrim($b, '0');
        if (strlen($a) < strlen($b) || (strlen($a) === strlen($b) && strcmp($a, $b) < 0)) {
            return null;
        }
        $out = '';
        $borrow = 0;
        for ($i = strlen($a) - 1, $j = strlen($b) - 1; $i >= 0; $i--, $j--) {
            $digit = ord($a[$i]) - 48 - ($j >= 0 ? ord($b[$j]) - 48 : 0) - $borrow;
            $borrow = $digit < 0 ? 1 : 0;
            $out = (string) ($digit + 10 * $borrow) . $out;
        }
        $out = ltrim($out, '0');
        return $out === '' ? '0' : $out;
    }

    /** The text of every refused sum or average scalar in every client (DSL-66). */
    private const AGGREGATE_REFUSED = 'aggregate scalar is not a finite number';

    /** The decimal places that the average of an exact column keeps beyond the scale of the column (DSL-161). */
    private const AVG_SCALE_EXTRA = 16;

    private static function aggregateNumber(mixed $value): float
    {
        if (
            !is_int($value) && !is_float($value)
            && !(is_string($value) && preg_match('/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?'
                . '(?:[eE][+-]?[0-9]+)?$/D', $value) === 1)
        ) {
            throw new OrmException(Code::CODEC_DECODE, self::AGGREGATE_REFUSED);
        }
        $number = (float) $value;
        if (!is_finite($number)) {
            throw new OrmException(Code::CODEC_DECODE, self::AGGREGATE_REFUSED);
        }
        return $number;
    }

    /** Whether the sum and the average of the column are exact (DSL-161): an integer or a decimal column. */
    private static function exactAggregate(array $col): bool
    {
        return in_array($col['type'], ['i16', 'i32', 'i64', 'decimal'], true);
    }

    /**
     * The sum cell of an exact column as its sign and the digits of the sum × 10^scale: on SQLite and markdown
     * (scaled) the cell is that integer (DIA-25), on MySQL and PostgreSQL a decimal of at most scale fraction digits.
     *
     * @return array{0: bool, 1: string}
     */
    private static function exactSum(mixed $value, int $scale, bool $scaled): array
    {
        if (is_int($value)) {
            $value = (string) $value;
        }
        if (!is_string($value) || preg_match('/^(-?)([0-9]+)(?:\.([0-9]+))?$/D', $value, $m) !== 1) {
            throw new OrmException(Code::CODEC_DECODE, self::AGGREGATE_REFUSED);
        }
        $fraction = $m[3] ?? '';
        if ($scaled) {
            if ($fraction !== '') {
                throw new OrmException(Code::CODEC_DECODE, self::AGGREGATE_REFUSED);
            }
            $scale = 0;
        }
        if (strlen($fraction) > $scale) {
            throw new OrmException(Code::CODEC_DECODE, self::AGGREGATE_REFUSED);
        }
        $digits = ltrim($m[2] . str_pad($fraction, $scale, '0'), '0');
        return [$m[1] === '-' && $digits !== '', $digits === '' ? '0' : $digits];
    }

    /** The nearest binary64 value of the digits × 10^-scale, ties to even; beyond the finite range CODEC_DECODE (DSL-66). */
    private static function nearestBinary64(bool $negative, string $digits, int $scale): float
    {
        $number = (float) (($negative ? '-' : '') . $digits . 'e-' . $scale);
        if (!is_finite($number)) {
            throw new OrmException(Code::CODEC_DECODE, self::AGGREGATE_REFUSED);
        }
        return $number;
    }

    /** The result of getSum for the sum cell of the column (DSL-66, DSL-161). */
    private static function sumValue(array $col, mixed $value, bool $scaled): float
    {
        if (!self::exactAggregate($col)) {
            return self::aggregateNumber($value);
        }
        [$negative, $digits] = self::exactSum($value, $col['scale'] ?? 0, $scaled);
        return self::nearestBinary64($negative, $digits, $col['scale'] ?? 0);
    }

    /**
     * The result of getAvg for the sum and the count of the values of the column: null for no value; for an exact
     * column the exact sum divided by the count, rounded half away from zero to AVG_SCALE_EXTRA places beyond the scale
     * of the column and then converted once (DSL-66, DSL-161); for an f64 column the binary64 sum divided by the count,
     * which is the AVG of every database.
     */
    private static function avgValue(array $col, mixed $sum, mixed $count, bool $scaled): ?float
    {
        if (is_string($count) && preg_match('/^[0-9]+$/D', $count) === 1 && (string) (int) $count === $count) {
            $count = (int) $count;
        }
        if (!is_int($count) || $count < 0) {
            throw new OrmException(Code::CODEC_DECODE, self::AGGREGATE_REFUSED);
        }
        if ($count === 0) {
            return null;
        }
        if ($sum === null) {
            throw new OrmException(Code::CODEC_DECODE, self::AGGREGATE_REFUSED);
        }
        if (!self::exactAggregate($col)) {
            return self::aggregateNumber($sum) / $count;
        }
        $scale = $col['scale'] ?? 0;
        [$negative, $digits] = self::exactSum($sum, $scale, $scaled);
        // The quotient with one place more than the stated scale: its last digit decides the rounding half away from
        // zero.
        $longer = self::quotient($digits . str_repeat('0', self::AVG_SCALE_EXTRA + 1), $count);
        $rounded = substr($longer, 0, -1);
        if ((int) substr($longer, -1) >= 5) {
            $rounded = self::increment($rounded);
        }
        $rounded = ltrim($rounded, '0');
        return self::nearestBinary64(
            $negative && $rounded !== '',
            $rounded === '' ? '0' : $rounded,
            $scale + self::AVG_SCALE_EXTRA,
        );
    }

    /**
     * The digits of the integer quotient of the decimal digits by divisor, by long division whose remainder stays below
     * the divisor: ten additions of the remainder modulo the divisor never leave the integer range.
     */
    private static function quotient(string $digits, int $divisor): string
    {
        $out = '';
        $rest = 0;
        for ($i = 0, $n = strlen($digits); $i < $n; $i++) {
            $digit = ord($digits[$i]) - 48;
            $acc = $digit % $divisor;
            $q = intdiv($digit, $divisor);
            for ($k = 0; $k < 10; $k++) {
                if ($acc >= $divisor - $rest) {
                    $acc -= $divisor - $rest;
                    $q++;
                } else {
                    $acc += $rest;
                }
            }
            $rest = $acc;
            $out .= (string) $q;
        }
        return $out;
    }

    /** The decimal digits plus one. */
    private static function increment(string $digits): string
    {
        for ($i = strlen($digits) - 1; $i >= 0; $i--) {
            if ($digits[$i] !== '9') {
                return substr($digits, 0, $i) . chr(ord($digits[$i]) + 1) . str_repeat('0', strlen($digits) - $i - 1);
            }
        }
        return '1' . str_repeat('0', strlen($digits));
    }

    /**
     * The error of a sum or average statement: PostgreSQL refuses an f64 sum beyond the finite range with SQLSTATE
     * 22003, and MySQL refuses it so through the planned addition of 0, which is the nonfinite scalar that the other
     * databases return, so it is CODEC_DECODE with the text of that scalar and the driver error as its cause (DIA-200).
     */
    private static function aggregateRangeError(OrmException $error): OrmException
    {
        $cause = $error->getPrevious();
        $outOfRange = $cause instanceof \PDOException && ($cause->errorInfo[0] ?? null) === '22003';
        if ($error->code_ === Code::DRIVER && $outOfRange) {
            return new OrmException(Code::CODEC_DECODE, self::AGGREGATE_REFUSED, $error);
        }
        return $error;
    }

    /**
     * One page and the total count.
     *
     * @return Page<static>
     */
    public function getsPage(int $page, int $perPage): Page
    {
        [$db, $frame, $q, $r] = $this->pageRequest($page, $perPage);
        [$plan, $result, $total] = $db->paginate($frame, $r);
        $items = $q->assemble($db, $r, $plan, $result);
        return new Page($items, $total, intdiv($total + $perPage - 1, $perPage), $page, $perPage);
    }

    /**
     * The arguments of a page checked and its request built: the one request of getsPage and getPagePlanSteps.
     *
     * @return array{0: Db, 1: ?TxFrame, 2: static, 3: Request}
     */
    private function pageRequest(int $page, int $perPage): array
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
        return [$db, $frame, $q, $q->build('paginate', $db)];
    }

    /**
     * The steps of the plan that getsPage runs, in their order, without executing it.
     *
     * @return list<array{role: string, tables: list<string>, sql: string}>
     */
    public function getPagePlanSteps(int $page, int $perPage): array
    {
        [$db, $frame, , $r] = $this->pageRequest($page, $perPage);
        return $db->pagePlanSteps($frame, $r);
    }

    /** @return array{sql: string, binds: list<mixed>} the statement of gets() without executing it */
    public function getQuery(): array
    {
        [$db] = $this->executor();
        return $db->statement($this->build('all', $db));
    }

    // ---- writes ----

    /**
     * The manifestHash the request carries. If the generated bootstrap has not registered this class under that hash,
     * it is SCHEMA_HASH_MISMATCH, so a model of another set does not
     * plan this request.
     */
    private static function manifestHash(): string
    {
        $meta = static::meta();
        $hash = (string) ($meta['manifest_hash'] ?? '');
        $registered = Registry::models($hash)[$meta['entity']] ?? null;
        if ($registered !== static::class) {
            throw new OrmException(Code::SCHEMA_HASH_MISMATCH, static::class
                . " is not registered by the generated models of manifest $hash");
        }
        Registry::verify(static::class);
        return $hash;
    }

    private function writeRequest(string $kind, Db $db): Request
    {
        $r = new Request($kind, static::manifestHash());
        $r->ir['entity'] = static::meta()['entity'];
        return $r;
    }

    private function assignIr(Request $r, string $column, array $spec): array
    {
        $a = ['column' => $column];
        if (isset($spec['null'])) {
            $a['null'] = true;
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

    /** @internal the stored value of a column value: the styled codec stages encode it */
    public static function encodeValue(array $col, mixed $v): mixed
    {
        if ($v !== null && in_array('ip', $col['codec'], true)) {
            Codec::hostEncode($v, ['ip'], '');
        }
        $codec = array_values(array_filter($col['codec'], static fn(string $s): bool => !Codec::isHostStyle($s)));
        if ($codec === []) {
            return $v;
        }
        if (!$v instanceof StyledValue) {
            throw new OrmException(Code::CODEC_ENCODE, 'styled column requires StyledValue');
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
        $st = ['loaded' => true, 'names' => [], 'hidden' => [], 'original' => [], 'extra' => [], 'related' => [],
            'cascade' => [], 'flat' => []];
        foreach ($this->sets as $column => $spec) {
            $st['names'][] = $column;
            if (array_key_exists('value', $spec)) {
                $m->values[$column] = self::columnValue($meta['columns'][$column], $spec['value'], $db->zone());
            } elseif (isset($spec['null'])) {
                $m->values[$column] = null;
            }
        }
        // The column that takes the key it is given: the identity, or the key_prefix key that a corpus allocated to a
        // primary key the request did not supply (docs/spec/protocol.md PRT-73).
        $assignedKey = $meta['identity'];
        if (
            $assignedKey === '' && is_string($id) && count($meta['pk']) === 1
            && !array_key_exists($meta['pk'][0], $this->sets)
            && Registry::model($meta['manifest_hash'])->assignedColumns($meta['entity'])['key'] === $meta['pk'][0]
        ) {
            $assignedKey = $meta['pk'][0];
        }
        if ($assignedKey !== '') {
            if (!in_array($assignedKey, $st['names'], true)) {
                $st['names'][] = $assignedKey;
            }
            $m->values[$assignedKey] = self::columnValue($meta['columns'][$assignedKey], $id, $db->zone());
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
     * Inserts rows in batches of $batch rows, each batch one multi-row INSERT, in one
     * transaction (a savepoint inside an active one) and returns the inserted row count;
     * every row must set the same columns in the same order. $batch is a positive
     * integer, otherwise CONFIG; a batch over the bind limit is BATCH_TOO_LARGE; both
     * fail before any statement.
     * @param list<Model> $rows
     */
    public function creates(array $rows, int $batch): int
    {
        if ($batch < 1) {
            throw new OrmException(Code::CONFIG, "creates batch must be a positive integer, got $batch");
        }
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
                throw new OrmException(
                    Code::CONFIG,
                    'every model of creates must set the same columns in the same order'
                );
            }
            foreach ($row->sets as $spec) {
                if (!array_key_exists('value', $spec) && !isset($spec['null'])) {
                    throw new OrmException(Code::CONFIG, 'creates accepts stored values only');
                }
            }
        }
        $meta = static::meta();
        // Rows run as batches of $batch rows in the given order in one transaction (docs/spec/protocol.md).
        $parts = Db::insertParts(count($rows), $batch);
        $limit = Db::bindLimit($db->dialect());
        foreach ($parts as $i => $part) {
            // A batch over the bind limit is refused before any statement, never split.
            $binds = $part * count($columns);
            if ($binds > $limit) {
                $n = $i + 1;
                throw new OrmException(Code::BATCH_TOO_LARGE, "creates batch $n of $part rows binds $binds "
                    . "parameters, over the {$db->dialect()} limit of $limit");
            }
        }
        $total = 0;
        Db::inTransaction($this->conn, function () use ($rows, $columns, $meta, $parts, &$total): void {
            [$db, $frame] = Db::resolve($this->conn);
            $offset = 0;
            foreach ($parts as $size) {
                $chunk = array_slice($rows, $offset, $size);
                $offset += $size;
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
            if (RuntimeModel::encrypted($meta['columns'][$column])) {
                $changed = true;
            }
        }
        if (!$changed) {
            return $sets;
        }
        foreach ($meta['columns'] as $column => $col) {
            if (!RuntimeModel::encrypted($col) || isset($sets[$column])) {
                continue;
            }
            if ($this->row === null || !in_array($column, $this->row['names'], true)) {
                throw new OrmException(Code::CONFIG, "changing an AES column of {$meta['entity']} requires a row "
                    . "loaded with $column");
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
        if (($r->ir['set'] ?? []) === [] && $this->expectedRevision === null) {
            return $this;
        }
        $this->keyWhere($r, $keys);
        $revision = $this->revisionGuard($r, true, $optimistic);
        $updated = $meta['updated'];
        if ($optimistic) {
            $raw = $loaded && $updated !== '' ? ($this->row['original'][$updated] ?? null) : null;
            if ($raw === null) {
                throw new OrmException(Code::CONFIG, 'update(true) requires a row loaded with its update time column');
            }
            // The version goes down as the text the row was loaded with, which the bind layer takes for a
            // datetime slot (T189).
            $text = $raw instanceof PendingTime ? $raw->text
                : self::resolved($raw)->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u');
            $r->ir['optimistic'] = ['column' => $updated, 'p' => $r->param($text)];
        }
        [, $affected] = $db->writeOf($frame, $r);
        if ($revision !== null && $affected === 0) {
            throw new OrmException(Code::REVISION_CHANGED, "the row's $revision is not {$this->expectedRevision[1]}");
        }
        $this->expectedRevision = null;
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
        $revision = $this->revisionGuard($r, false, false);
        [, $affected] = $db->writeOf($frame, $r);
        if ($revision !== null && $affected === 0) {
            throw new OrmException(Code::REVISION_CHANGED, "the row's $revision is not {$this->expectedRevision[1]}");
        }
        $this->expectedRevision = null;
    }

    /**
     * Restores the soft-deleted row that the set values name and returns the restored row. It sends the set
     * values as the restore request's set; the planner picks the key after the request hook from the set values
     * and the eq conditions of the where (docs/spec/protocol.md 1.5): the primary key when they cover it, otherwise
     * the first unique key in name order. A set value of a key column is a condition and every other set value is
     * a new value written with the restore. It clears the soft delete column with an update that, on an audited
     * table, writes the audit of the transaction like any other update, and then reads the row by the values of
     * that key. A row that is not deleted is returned unchanged and nothing is written; a missing row is NO_ROWS.
     * Reads never return a soft-deleted row: restore names it explicitly.
     */
    public function restore(): static
    {
        return $this->restoreStep()[1]->get() ?? throw new OrmException(Code::NO_ROWS, 'restore: no row holds the key');
    }

    /**
     * Restores the soft-deleted row of the key that restore() picks, or creates it with the set values when no
     * row holds the key, in one transaction (docs/operations/usage.md "Restore or create a row"), and returns
     * the row. A row that holds the key and is
     * not deleted fails with ROW_NOT_DELETED, and nothing is written.
     */
    public function restoreOrCreate(): static
    {
        $row = null;
        Db::inTransaction($this->conn, function () use (&$row): void {
            [$restored, $q] = $this->restoreStep();
            if ($restored > 0) {
                $row = $q->get();
                return;
            }
            if ($q->getCount() > 0) {
                throw new OrmException(
                    Code::ROW_NOT_DELETED,
                    'restoreOrCreate: a row that is not deleted holds the key'
                );
            }
            $row = $this->create();
        });
        return $row;
    }

    /**
     * Sends the restore request of the set values and returns the number of rows it restored and the query of
     * the row by
     * the values of the key that the planner picked.
     *
     * @return array{int, static}
     */
    private function restoreStep(): array
    {
        [$db, $frame] = $this->executor();
        $r = (new static())->build('restore', $db);
        // $own maps the parameter of each value the model sets to its column; the hook adds parameters after them.
        $own = [];
        foreach ($this->sets as $column => $spec) {
            $a = $this->assignIr($r, $column, $spec);
            if (isset($a['p'])) {
                $own[$a['p']] = $column;
            }
            $r->ir['set'][] = $a;
        }
        $keys = [];
        $args = [];
        // The key is read from the request as the hook left it, before the planner renumbers its parameters, as
        // Go reads it.
        [, $restored] = $db->writeOf($frame, $r, function (Request $hooked) use ($own, &$keys, &$args): void {
            $key = Validator::restoreKey(static::meta(), $hooked->ir)['key'];
            foreach ($key as $column) {
                $keys[] = ['conn' => $keys === [] ? '' : 'and', 'op' => '', 'column' => $column, 'columns' => [],
                    'compare' => ''];
                $args[] = $this->restoreKeyValue($hooked, $own, $column);
            }
        });
        $q = new static();
        $q->conn = $this->conn;
        $q->whereChain('', $keys, $args);
        return [$restored, $q];
    }

    /**
     * The value of a key column of the restore request $r as the hook left it. A set item whose parameter is one the
     * model added for that same column ($own) takes the model's own value, which the read converts as any condition
     * value; any other set item or eq condition of the where on the column takes its parameter, as the hook left it.
     *
     * @param array<int, string> $own the column of each parameter the model added for its set values
     */
    private function restoreKeyValue(Request $r, array $own, string $column): mixed
    {
        foreach ($r->ir['set'] ?? [] as $a) {
            if ($a['column'] === $column && isset($a['p'])) {
                return ($own[$a['p']] ?? null) === $column ? $this->sets[$column]['value'] : $r->params[$a['p']];
            }
        }
        foreach ($r->ir['where']['items'] ?? [] as $item) {
            $pr = $item['pred'] ?? null;
            if (
                $pr !== null && ($pr['column'] ?? '') === $column && ($pr['op'] ?? '') === 'eq' && isset($pr['p'])
                && !isset($pr['fn']) && !isset($pr['value']) && !isset($pr['ref']) && !isset($pr['sub'])
            ) {
                return $r->params[$pr['p']];
            }
        }
        throw new OrmException(Code::INTERNAL, "restore key column $column has no value in the request");
    }

    /** @internal the connection of a loaded row */
    public function connection(): ?Db
    {
        return $this->conn;
    }

    // ---- output ----

    /**
     * The row values in row order. The JSON output ($json) refuses a bytes column without a codec stage with
     * CODEC_ENCODE (docs/spec/codec.md COD-26); the array form keeps the bytes (COD-27).
     *
     * @return list<array{0: string, 1: mixed}>
     */
    private function pairs(bool $json = false): array
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
                $column = $meta['columns'][$name];
                $type = $column['type'] ?? '';
                $v = self::columnArrayValue($type, (int) ($column['precision'] ?? 0), $this->value($name));
                // A bytes column whose value is the stored bytes, with no codec stage that decodes them into a value of
                // its own, is a Bytes in the array form, as bytes are in every runtime (COD-27); JSON has no bytes, so
                // the JSON output refuses it (COD-26).
                if ($type === 'bytes' && ($column['codec'] ?? []) === [] && is_string($v)) {
                    if ($json) {
                        throw new OrmException(
                            Code::CODEC_ENCODE,
                            "{$meta['entity']}.$name: JSON output cannot write bytes",
                        );
                    }
                    $v = new Bytes($v);
                }
                $add($name, $v);
            } else {
                $add($name, isset($st['extra_date'][$name])
                    ? self::columnArrayValue('date', 0, $st['extra'][$name] ?? null)
                    : self::arrayValue($st['extra'][$name] ?? null));
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
                foreach ($v->pairs($json) as [$k, $cv]) {
                    $add($k, $cv);
                }
            }
        }
        return $out;
    }

    /**
     * A column value of the array form. A date, datetime(p) and time(p) column each has one temporal form, the text of
     * docs/spec/protocol.md PRT-69: YYYY-MM-DD, and YYYY-MM-DD HH:MM:SS and HH:MM:SS with exactly p fraction digits
     * ($precision). A time column holds that text, as its getter returns it.
     */
    private static function columnArrayValue(string $type, int $precision, mixed $v): mixed
    {
        if (!$v instanceof \DateTimeInterface) {
            return self::arrayValue($v);
        }
        $fraction = $precision === 0 ? '' : '.' . substr($v->format('u'), 0, $precision);
        return match ($type) {
            'date' => $v->format('Y-m-d'),
            'time' => $v->format('H:i:s') . $fraction,
            'datetime' => $v->format('Y-m-d H:i:s') . $fraction,
            default => self::arrayValue($v),
        };
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
            $out[$name] = $v instanceof Model || $v instanceof Collection ? $v->toArray()
                : ($v instanceof StyledValue ? $v->jsonSerialize() : $v);
        }
        return $out;
    }

    /** Flags of json_encode for the values of toJson and jsonSerialize. */
    public const JSON_FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION
        | JSON_THROW_ON_ERROR;

    /**
     * The row as JSON text: the members in row order, related rows as nested
     * JSON, an ordered-json value as its exact text, and other values written
     * by json_encode with JSON_FLAGS. A value json_encode rejects returns
     * CODEC_ENCODE.
     */
    public function toJson(): string
    {
        $parts = [];
        foreach ($this->pairs(true) as [$name, $v]) {
            $parts[] = self::jsonText($name) . ':' . self::jsonText($v);
        }
        return '{' . implode(',', $parts) . '}';
    }

    /** @internal the JSON text of one output value */
    public static function jsonText(mixed $v): string
    {
        if ($v instanceof StyledValue) {
            return $v->kind === 'sql-null'
                ? '{"kind":"sql-null"}'
                : '{"kind":"value","value":' . self::jsonText($v->payload()) . '}';
        }
        if ($v instanceof \Polyspec\OrderedJson\Value) {
            return \Polyspec\OrderedJson\stringify($v);
        }
        if ($v instanceof Model || $v instanceof Collection) {
            return $v->toJson();
        }
        if (is_array($v) && self::holdsOrderedJson($v)) {
            if (array_is_list($v)) {
                return '[' . implode(',', array_map(self::jsonText(...), $v)) . ']';
            }
            $parts = [];
            foreach ($v as $k => $item) {
                $parts[] = self::jsonText((string) $k) . ':' . self::jsonText($item);
            }
            return '{' . implode(',', $parts) . '}';
        }
        try {
            return json_encode($v, self::JSON_FLAGS);
        } catch (\JsonException $e) {
            throw new OrmException(Code::CODEC_ENCODE, 'json: the value has no JSON text', $e);
        }
    }

    private static function holdsOrderedJson(array $v): bool
    {
        foreach ($v as $item) {
            if ($item instanceof \Polyspec\OrderedJson\Value || (is_array($item) && self::holdsOrderedJson($item))) {
                return true;
            }
        }
        return false;
    }

    /**
     * The row values for json_encode. json_encode cannot write the exact text
     * of an ordered-json value, so a row that holds one fails with
     * CODEC_ENCODE; toJson writes it.
     */
    public function jsonSerialize(): mixed
    {
        $out = [];
        foreach ($this->pairs(true) as [$name, $v]) {
            if (
                $v instanceof \Polyspec\OrderedJson\Value
                || ($v instanceof StyledValue && $v->kind === 'value'
                    && $v->payload() instanceof \Polyspec\OrderedJson\Value)
                || (is_array($v) && self::holdsOrderedJson($v))
            ) {
                throw new OrmException(
                    Code::CODEC_ENCODE,
                    "json_encode cannot write the ordered-json value of $name; use toJson()"
                );
            }
            $out[$name] = $v;
        }
        return (object) $out;
    }

    public function __clone()
    {
        // Builder arrays are values; related results and join children are shared on purpose.
    }
}
