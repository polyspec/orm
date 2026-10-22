<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/** The database-specific pieces of SQL for mysql, postgres, and sqlite. */
final class Dialect
{
    /** Column types each column function accepts. */
    public const COLUMN_FUNCTION_TYPES = [
        'day_of_week' => ['date', 'datetime'],
        'year' => ['date', 'datetime'],
        'month' => ['date', 'datetime'],
        'date' => ['date', 'datetime'],
    ];

    /** Arguments of each column function, not counting the compared value. */
    public const COLUMN_FUNCTION_ARITY = ['day_of_week' => 0, 'year' => 0, 'month' => 0, 'date' => 0];

    /** Interval unit of each relative value function. */
    public const VALUE_FUNCTION_UNITS = [
        'seconds_ago' => 'second', 'minutes_ago' => 'minute', 'hours_ago' => 'hour', 'days_ago' => 'day',
        'months_ago' => 'month',
        'seconds_later' => 'second', 'minutes_later' => 'minute', 'hours_later' => 'hour', 'days_later' => 'day',
        'months_later' => 'month',
    ];

    public function __construct(public readonly string $name)
    {
        if (!in_array($name, ['mysql', 'postgres', 'sqlite'], true)) {
            throw new OrmException(Code::DIALECT_UNKNOWN, $name);
        }
    }

    public static function isValueFunction(string $name): bool
    {
        return isset(self::VALUE_FUNCTION_UNITS[$name]) || $name === 'now' || $name === 'today';
    }

    public static function quoteWith(string $q, string $ident): string
    {
        return implode('.', array_map(static fn(string $p): string => $q . str_replace($q, $q . $q, $p) . $q,
            explode('.', $ident)));
    }

    public function quote(string $ident): string
    {
        return match ($this->name) {
            'mysql' => self::quoteWith('`', $ident),
            'postgres' => self::quoteWith('"', $ident),
            default => self::quoteWith('"', str_replace('.', '__', $ident)),
        };
    }

    public function placeholder(int $n): string
    {
        return $this->name === 'postgres' ? '$' . $n : '?';
    }

    public function limit(int $offset, int $count): string
    {
        return $this->name === 'mysql' ? " LIMIT $offset, $count" : " LIMIT $count OFFSET $offset";
    }

    public function forceIndex(string $index): string
    {
        return match ($this->name) {
            'mysql' => ' FORCE INDEX (' . self::quoteWith('`', $index) . ')',
            'postgres' => '',
            default => ' INDEXED BY ' . self::quoteWith('"', $index),
        };
    }

    public function insertReturningId(): bool
    {
        return $this->name !== 'mysql';
    }

    /**
     * The database clock written to a column as fractional seconds at precision digits: for MySQL, if p > 0,
     * CURRENT_TIMESTAMP(p); otherwise CURRENT_TIMESTAMP.
     */
    public function now(int $precision): string
    {
        return $this->name === 'mysql' && $precision > 0 ? "CURRENT_TIMESTAMP($precision)" : 'CURRENT_TIMESTAMP';
    }

    /**
     * Whether the write codec stage is applied in SQL (MySQL: ip). The others, including hex, are applied by
     * the executor.
     */
    public function handlesStyle(string $style): bool
    {
        return $this->name === 'mysql' && $style === 'ip';
    }

    /**
     * Whether the read codec stage is decoded in SQL (MySQL: ip). No dialect decodes hex in SQL:
     * UNHEX accepts odd lengths and gives NULL for a cell with whitespace, so the executor reads it exactly
     * with hostDecode (docs/spec/codec.md).
     */
    public function decodesStyle(string $style): bool
    {
        return $this->name === 'mysql' && $style === 'ip';
    }

    /**
     * The clock the ORM uses is given by the executor (the `now` slot truncated to the column's fractional
     * digits): SQLite has no sub-second clock function, and the PostgreSQL clock is rounded to timestamp(p
     * < 6) (docs/spec/protocol.md "Clock").
     */
    public function hostNow(): bool
    {
        return $this->name !== 'mysql';
    }

    /**
     * A datetime(p) column compared with the six-digit clock of a value function. SQLite compares as text,
     * so a column with p < 6 is extended with zeros to six digits. MySQL and PostgreSQL compare by value.
     */
    public function clockOperand(string $col, int $precision): string
    {
        if ($this->name !== 'sqlite' || $precision >= 6) {
            return $col;
        }
        return $precision === 0 ? "($col || '.000000')" : "($col || '" . str_repeat('0', 6 - $precision) . "')";
    }

    public function contains(string $col, string $ph): string
    {
        return match ($this->name) {
            'mysql' => self::asciiLower($col) . ' LIKE ' . self::asciiLower($ph),
            'postgres' => "$col ILIKE $ph",
            default => "$col LIKE $ph ESCAPE '\\'",
        };
    }

    /**
     * 26 nested REPLACE calls, one for each of A to Z with its lower case: MySQL LIKE under utf8mb4_0900_bin then
     * folds the ASCII letters only, as PostgreSQL ILIKE under "C" and SQLite LIKE do.
     */
    private static function asciiLower(string $x): string
    {
        $s = str_repeat('REPLACE(', 26) . $x;
        foreach (range('A', 'Z') as $c) {
            $s .= ", '$c', '" . strtolower($c) . "')";
        }
        return $s;
    }

    /** @param \Closure(string): string $value a placeholder whose value gets the transform */
    public function containsBinary(string $col, \Closure $value): string
    {
        return match ($this->name) {
            // utf8mb4_0900_bin compares code points under LIKE; LIKE BINARY is deprecated since MySQL 8.0.27.
            'mysql', 'postgres' => "$col LIKE " . $value('like_contains'),
            default => "instr($col, " . $value('') . ') > 0',
        };
    }

    /**
     * @param list<string> $cols
     * @param \Closure(string): string $value a placeholder whose value gets the transform
     */
    public function fulltext(array $cols, \Closure $value, bool $boolean): ?string
    {
        return match ($this->name) {
            'mysql' => 'MATCH (' . implode(', ', $cols) . ') AGAINST (' . ($boolean
                ? $value('fulltext_boolean') . ' IN BOOLEAN MODE'
                : $value('') . ' IN NATURAL LANGUAGE MODE') . ')',
            'postgres' => "to_tsvector('simple', " . implode(" || ' ' || ", array_map(static fn(string $c): string => "coalesce($c, '')", $cols))
                . ') @@ ' . ($boolean ? 'websearch_to_tsquery' : 'plainto_tsquery') . "('simple', " . $value('') . ')',
            default => null,
        };
    }

    /** @param list<string> $conflict */
    public function upsert(array $conflict, string $assigns): string
    {
        if ($this->name === 'mysql') {
            return ' ON DUPLICATE KEY UPDATE ' . $assigns;
        }
        $q = array_map(static fn(string $c): string => self::quoteWith('"', $c), $conflict);
        return ' ON CONFLICT (' . implode(', ', $q) . ') DO UPDATE SET ' . $assigns;
    }

    /**
     * The SQL-side read stage of a column. Accepts only the stage chosen by decodesStyle.
     *
     * @param list<string> $styles
     */
    public function readExpr(string $col, array $styles): string
    {
        for ($i = count($styles) - 1; $i >= 0; $i--) {
            $col = match ($styles[$i]) {
                'ip' => "INET6_NTOA($col)",
            };
        }
        return $col;
    }

    /**
     * The SQL-side write stage around a bind value. Accepts only the stage chosen by handlesStyle.
     *
     * @param list<string> $styles
     */
    public function writeExpr(string $ph, array $styles): string
    {
        foreach ($styles as $s) {
            $ph = match ($s) {
                'ip' => "INET6_ATON($ph)",
            };
        }
        return $ph;
    }

    /**
     * An expression that reads a time(p) column as the value text `HH:MM:SS` with exactly p fractional
     * digits. The database writes that text (MySQL CAST AS CHAR, PostgreSQL to_char). SQLite stores that
     * text.
     */
    public function readTime(string $col, int $precision): string
    {
        return match ($this->name) {
            'mysql' => "CAST($col AS CHAR)",
            'postgres' => $precision === 0 ? "to_char($col, 'HH24:MI:SS')"
                : "substr(to_char($col, 'HH24:MI:SS.US'), 1, " . (9 + $precision) . ')',
            default => $col,
        };
    }

    /** An expression that binds a time(p) value as text. PostgreSQL casts the text to time. */
    public function writeTime(string $ph): string
    {
        return $this->name === 'postgres' ? "CAST(CAST($ph AS text) AS time)" : $ph;
    }

    /** An expression that reads a uuid column as text. PostgreSQL casts uuid to text. */
    public function readUuid(string $col): string
    {
        return $this->name === 'postgres' ? "CAST($col AS text)" : $col;
    }

    /** An expression that binds a uuid value as text. PostgreSQL casts the text to uuid. */
    public function writeUuid(string $ph): string
    {
        return $this->name === 'postgres' ? "CAST(CAST($ph AS text) AS uuid)" : $ph;
    }

    /** The row lock suffix; SQLite locks in the executor. */
    public function rowLock(string $mode): ?string
    {
        if (!in_array($mode, ['update', 'share', 'update_nowait', 'share_nowait'], true)) {
            return null;
        }
        if ($this->name === 'sqlite') {
            return '';
        }
        return ' FOR ' . strtoupper(str_replace('_', ' ', $mode));
    }

    /** Quotes text as an SQL string literal. */
    public static function literal(string $text): string
    {
        return "'" . str_replace("'", "''", $text) . "'";
    }

    /**
     * The statement that restarts the table's identity column from the value after the largest key. For an
     * empty table, the next key is 1.
     * MySQL: if InnoDB sets AUTO_INCREMENT at or below the column's largest value, it sets it to the largest
     * value plus 1, so 1 is always after the largest key. It is DDL, so it commits an open transaction.
     * PostgreSQL: sets the identity sequence to the largest key plus 1, with is_called set to false
     * so that the next nextval returns it. The first argument of pg_get_serial_sequence is read as an
     * identifier, so it is the quoted table name; the second argument is the column name as is.
     * SQLite: the next key of an AUTOINCREMENT table is the seq in sqlite_sequence plus 1, so seq is set
     * to the largest key. If the table has never received a row and there is no row in sqlite_sequence, the
     * next key is already after the largest key.
     */
    public function restartIdentity(string $table, string $column): string
    {
        return match ($this->name) {
            'mysql' => 'ALTER TABLE ' . self::quoteWith('`', $table) . ' AUTO_INCREMENT = 1',
            'postgres' => 'SELECT setval(pg_get_serial_sequence('
                . self::literal(self::quoteWith('"', $table)) . ', ' . self::literal($column)
                . '), COALESCE(MAX(' . self::quoteWith('"', $column) . '), 0) + 1, false) FROM '
                . self::quoteWith('"', $table),
            default => 'UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX(' . self::quoteWith('"', $column)
                . '), 0) FROM ' . self::quoteWith('"', $table)
                . ') WHERE name = ' . self::literal($table),
        };
    }

    public function random(): string
    {
        return $this->name === 'mysql' ? 'RAND()' : 'random()';
    }

    /**
     * The clause that sorts NULL before every value ascending and after every value descending; PostgreSQL
     * alone needs it.
     */
    public function nullsOrder(bool $desc): string
    {
        return $this->name === 'postgres' ? ($desc ? ' NULLS LAST' : ' NULLS FIRST') : '';
    }

    /**
     * @param list<string> $cols
     * @param list<list<string>> $rows
     */
    public function tupleIn(array $cols, array $rows, bool $negate): string
    {
        $list = implode(', ', array_map(static fn(array $r): string => '(' . implode(', ', $r) . ')', $rows));
        if ($this->name === 'sqlite') {
            $list = 'VALUES ' . $list;
        }
        return '(' . implode(', ', $cols) . ')' . ($negate ? ' NOT IN ' : ' IN ') . '(' . $list . ')';
    }

    public function columnFunction(string $fn, string $col): ?string
    {
        switch ($this->name) {
            case 'mysql':
                return match ($fn) {
                    'day_of_week' => "DAYOFWEEK($col)",
                    'year' => "YEAR($col)",
                    'month' => "MONTH($col)",
                    'date' => "DATE($col)",
                    default => null,
                };
            case 'postgres':
                return match ($fn) {
                    'day_of_week' => "(EXTRACT(DOW FROM $col)::int + 1)",
                    'year' => "EXTRACT(YEAR FROM $col)::int",
                    'month' => "EXTRACT(MONTH FROM $col)::int",
                    'date' => "CAST($col AS date)",
                    default => null,
                };
            default:
                return match ($fn) {
                    'day_of_week' => "(CAST(strftime('%w', $col) AS INTEGER) + 1)",
                    'year' => "CAST(strftime('%Y', $col) AS INTEGER)",
                    'month' => "CAST(strftime('%m', $col) AS INTEGER)",
                    'date' => "date($col)",
                    default => null,
                };
        }
    }

    /**
     * @param \Closure(): string $arg the interval amount placeholder
     * @param \Closure(): string $now the executor clock placeholder
     */
    public function valueFunction(string $fn, \Closure $arg, \Closure $now): ?string
    {
        $unit = self::VALUE_FUNCTION_UNITS[$fn] ?? null;
        $later = str_ends_with($fn, '_later');
        switch ($this->name) {
            case 'mysql':
                return match (true) {
                    $fn === 'now' => 'NOW(6)',
                    $fn === 'today' => 'CURDATE()',
                    $unit === null => null,
                    default => self::guardResult(fn (): string => ($later ? 'DATE_ADD' : 'DATE_SUB')
                        . '(NOW(6), INTERVAL ' . self::guardInterval($unit, '', $arg) . ' ' . strtoupper($unit) . ')'),
                };
            case 'postgres':
                // The executor binds the clock, so one statement has one clock: now() is the transaction
                // start, and statement_timestamp() is the statement start (postgres.now.transaction_start).
                if ($fn === 'now') {
                    return 'CAST(' . $now() . ' AS timestamp(6))';
                }
                if ($fn === 'today') {
                    return 'CURRENT_DATE';
                }
                if ($unit === null) {
                    return null;
                }
                $field = ['second' => 'secs', 'minute' => 'mins', 'hour' => 'hours', 'day' => 'days',
                    'month' => 'months'][$unit];
                $cast = $field === 'secs' ? 'double precision' : 'integer';
                $operandCast = $cast === 'double precision' ? $cast : 'bigint';
                return self::guardResult(
                    function () use ($now, $arg, $unit, $cast, $operandCast, $later, $field): string {
                    $clock = 'CAST(' . $now() . ' AS timestamp(6))';
                    $value = 'CAST(' . self::guardInterval($unit, $operandCast, $arg) . " AS $cast)";
                    return '(' . $clock . ($later ? ' + ' : ' - ') . "make_interval($field => $value))";
                });
            default:
                if ($fn === 'now') {
                    return $now();
                }
                if ($fn === 'today') {
                    return 'date(' . $now() . ')';
                }
                if ($unit === null) {
                    return null;
                }
                // datetime returns seconds, so in one statement it is the same as the first slot
                // with six fractional digits of the second clock slot appended.
                return self::guardResult(function () use ($now, $arg, $unit, $later): string {
                    $clock = $now();
                    $modifier = ($later ? "'+'" : "'-'") . ' || CAST(' . $arg() . " AS TEXT) || ' {$unit}s'"
                        . ($unit === 'month' ? ", 'floor'" : '');
                    return "(datetime($clock, $modifier) || substr(" . $now() . ', 20))';
                });
        }
    }

    /**
     * The largest interval of each unit that stays inside orm's range, 0001-01-01 to 9999-12-31 (3652059
     * days): a relative time function whose interval exceeds it is NULL, so no database computes it and
     * PostgreSQL never fails with interval out of range (postgres.relative.interval_out_of_range).
     */
    private const INTERVAL_BOUNDS = [
        'second' => '315537897600', 'minute' => '5258964960', 'hour' => '87649416', 'day' => '3652059',
        'month' => '119988'
    ];

    /**
     * The interval argument of a relative time function, NULL past its bound. The guard sits inside the argument, not
     * around the function, so a database that folds constants never evaluates an out-of-range interval.
     *
     * @param \Closure(): string $arg
     */
    private static function guardInterval(string $unit, string $operandCast, \Closure $arg): string
    {
        // A typed placeholder needs its cast on both sides: PostgreSQL infers an uncast THEN placeholder as text.
        $cast = static fn (string $placeholder): string =>
            $operandCast === '' ? $placeholder : "CAST($placeholder AS $operandCast)";
        $operand = $cast($arg());
        $bound = self::INTERVAL_BOUNDS[$unit];
        return "CASE WHEN $operand BETWEEN -$bound AND $bound THEN " . $cast($arg()) . ' END';
    }

    /**
     * A relative time value, NULL outside 0001-01-01 00:00:00 to 9999-12-31 23:59:59.999999: past the range MySQL and
     * SQLite give NULL, below it they give the year 0000 (mysql.relative.out_of_range_null,
     * sqlite.relative.out_of_range_null), and PostgreSQL gives the year 10000 or later.
     *
     * @param \Closure(): string $value
     */
    private static function guardResult(\Closure $value): string
    {
        $first = $value();
        return "CASE WHEN $first BETWEEN '0001-01-01 00:00:00' AND "
            . "'9999-12-31 23:59:59.999999' THEN " . $value() . ' END';
    }
}
