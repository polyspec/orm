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
        'seconds_ago' => 'second', 'minutes_ago' => 'minute', 'hours_ago' => 'hour', 'days_ago' => 'day', 'months_ago' => 'month',
        'seconds_later' => 'second', 'minutes_later' => 'minute', 'hours_later' => 'hour', 'days_later' => 'day', 'months_later' => 'month',
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
        return implode('.', array_map(static fn(string $p): string => $q . str_replace($q, $q . $q, $p) . $q, explode('.', $ident)));
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
     * precision 자리 소수 초로 column에 쓰는 database clock이다: MySQL은 p > 0이면
     * CURRENT_TIMESTAMP(p), 나머지는 CURRENT_TIMESTAMP다.
     */
    public function now(int $precision): string
    {
        return $this->name === 'mysql' && $precision > 0 ? "CURRENT_TIMESTAMP($precision)" : 'CURRENT_TIMESTAMP';
    }

    /** 쓰기에서 codec stage를 SQL에서 적용하는지 여부다. 나머지는 executor가 적용한다. */
    public function handlesStyle(string $style): bool
    {
        return $this->name === 'mysql' && ($style === 'hex' || $style === 'ip');
    }

    /**
     * 읽기에서 codec stage를 SQL에서 푸는지 여부다(MySQL: ip). hex는 어느 dialect도 SQL에서 풀지 않는다:
     * UNHEX는 홀수 길이를 받고 공백이 있는 셀에 NULL을 내므로, executor가 hostDecode로 정확히 읽는다(docs/codec.md).
     */
    public function decodesStyle(string $style): bool
    {
        return $this->name === 'mysql' && $style === 'ip';
    }

    /** SQLite has no sub-second clock function; the executor binds the time. */
    public function hostNow(): bool
    {
        return $this->name === 'sqlite';
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
            'mysql' => "$col LIKE BINARY " . $value('like_contains'),
            'postgres' => "$col LIKE " . $value('like_contains'),
            default => "instr($col, " . $value('') . ') > 0',
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

    /** column의 SQL 쪽 read stage다. decodesStyle이 고른 stage만 받는다. @param list<string> $styles */
    public function readExpr(string $col, array $styles): string
    {
        for ($i = count($styles) - 1; $i >= 0; $i--) {
            $col = match ($styles[$i]) {
                'ip' => "INET6_NTOA($col)",
            };
        }
        return $col;
    }

    /** bind 값 주위의 SQL 쪽 write stage다. handlesStyle이 고른 stage만 받는다. @param list<string> $styles */
    public function writeExpr(string $ph, array $styles): string
    {
        foreach ($styles as $s) {
            $ph = match ($s) {
                'hex' => "HEX($ph)",
                'ip' => "INET6_ATON($ph)",
            };
        }
        return $ph;
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

    /** text를 SQL 문자열 literal로 quote한다. */
    public static function literal(string $text): string
    {
        return "'" . str_replace("'", "''", $text) . "'";
    }

    /**
     * table의 identity column을 가장 큰 key 다음 값에서 다시 시작하는 statement다. 빈 table이면
     * 다음 key는 1이다.
     * MySQL: InnoDB는 AUTO_INCREMENT를 column의 가장 큰 값 이하로 정하면 가장 큰 값에 1을 더한
     * 값으로 정하므로 1은 언제나 가장 큰 key 다음이다. DDL이므로 열린 transaction을 commit한다.
     * PostgreSQL: identity sequence를 가장 큰 key에 1을 더한 값으로 정하고 is_called를 false로
     * 두어 다음 nextval이 그 값을 돌려주게 한다. pg_get_serial_sequence의 첫 인자는 identifier로
     * 읽히므로 quote한 table 이름이고, 둘째 인자는 column 이름 그대로다.
     * SQLite: AUTOINCREMENT table의 다음 key는 sqlite_sequence의 seq에 1을 더한 값이므로 seq를
     * 가장 큰 key로 정한다. table이 아직 행을 받은 적이 없어 sqlite_sequence에 행이 없으면 다음
     * key는 이미 가장 큰 key 다음이다.
     */
    public function restartIdentity(string $table, string $column): string
    {
        return match ($this->name) {
            'mysql' => 'ALTER TABLE ' . self::quoteWith('`', $table) . ' AUTO_INCREMENT = 1',
            'postgres' => 'SELECT setval(pg_get_serial_sequence(' . self::literal(self::quoteWith('"', $table)) . ', ' . self::literal($column)
                . '), COALESCE(MAX(' . self::quoteWith('"', $column) . '), 0) + 1, false) FROM ' . self::quoteWith('"', $table),
            default => 'UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX(' . self::quoteWith('"', $column) . '), 0) FROM ' . self::quoteWith('"', $table)
                . ') WHERE name = ' . self::literal($table),
        };
    }

    public function random(): string
    {
        return $this->name === 'mysql' ? 'RAND()' : 'random()';
    }

    /** The clause that sorts NULL before every value ascending and after every value descending; PostgreSQL alone needs it. */
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
                    default => ($later ? 'DATE_ADD' : 'DATE_SUB') . '(NOW(6), INTERVAL ' . $arg() . ' ' . strtoupper($unit) . ')',
                };
            case 'postgres':
                if ($fn === 'now') {
                    return 'now()';
                }
                if ($fn === 'today') {
                    return 'CURRENT_DATE';
                }
                if ($unit === null) {
                    return null;
                }
                $field = ['second' => 'secs', 'minute' => 'mins', 'hour' => 'hours', 'day' => 'days', 'month' => 'months'][$unit];
                $cast = $field === 'secs' ? 'double precision' : 'integer';
                $value = 'CAST(' . $arg() . " AS $cast)";
                return '(now()' . ($later ? ' + ' : ' - ') . "make_interval($field => $value))";
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
                // datetime은 초 단위를 돌려주므로 한 statement에서 첫 slot과 같은
                // 두 번째 clock slot의 소수 여섯 자리를 붙인다.
                $clock = $now();
                $modifier = ($later ? "'+'" : "'-'") . ' || CAST(' . $arg() . " AS TEXT) || ' {$unit}s'" . ($unit === 'month' ? ", 'floor'" : '');
                return "(datetime($clock, $modifier) || substr(" . $now() . ', 20))';
        }
    }
}
