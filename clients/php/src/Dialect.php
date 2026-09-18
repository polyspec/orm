<?php
declare(strict_types=1);

namespace Orm;

/** The database-specific pieces of SQL for mysql, postgres, and sqlite. */
final class Dialect
{
    /** Replaced in trusted expression fragments with the advancing wall clock. */
    public const CURRENT_TIME_TOKEN = '$CURRENT_TIME';
    /** Sphere radius of MySQL ST_Distance_Sphere and the portable haversine. */
    private const EARTH_RADIUS = '6370986';

    /** Column types each column function accepts. */
    public const COLUMN_FUNCTION_TYPES = [
        'day_of_week' => ['date', 'datetime'],
        'year' => ['date', 'datetime'],
        'month' => ['date', 'datetime'],
        'date' => ['date', 'datetime'],
        'distance' => ['point'],
        'point_x' => ['point'],
        'point_y' => ['point'],
    ];

    /** Arguments of each column function, not counting the compared value. */
    public const COLUMN_FUNCTION_ARITY = ['day_of_week' => 0, 'year' => 0, 'month' => 0, 'date' => 0, 'distance' => 2, 'point_x' => 0, 'point_y' => 0];

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

    public function now(): string
    {
        return 'CURRENT_TIMESTAMP';
    }

    public function currentTime(): string
    {
        return $this->name === 'postgres' ? 'clock_timestamp()' : 'CURRENT_TIMESTAMP';
    }

    public function supports(string $op): bool
    {
        return $this->name !== 'sqlite' || ($op !== 'match' && $op !== 'match_boolean');
    }

    /** Whether a style stage is applied in SQL; the rest is left to the executor. */
    public function handlesStyle(string $style): bool
    {
        return match ($this->name) {
            'mysql' => $style === 'hex' || $style === 'ip',
            'postgres' => $style === 'ip',
            default => false,
        };
    }

    /** SQLite has no sub-second clock function; the executor binds the time. */
    public function hostNow(): bool
    {
        return $this->name === 'sqlite';
    }

    public function contains(string $col, string $ph): string
    {
        return match ($this->name) {
            'mysql' => "$col LIKE $ph",
            'postgres' => "$col ILIKE $ph",
            default => "$col LIKE $ph ESCAPE '\\'",
        };
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

    /** @param list<string> $cols */
    public function fulltext(array $cols, string $ph, bool $boolean): string
    {
        if ($this->name === 'mysql') {
            return 'MATCH(' . implode(', ', $cols) . ") AGAINST ($ph" . ($boolean ? ' IN BOOLEAN MODE' : ' IN NATURAL LANGUAGE MODE') . ')';
        }
        $doc = count($cols) > 1 ? 'coalesce(' . implode(", '') || ' ' || coalesce(", $cols) . ", '')" : implode(" || ' ' || ", $cols);
        $fn = $boolean ? 'websearch_to_tsquery' : 'plainto_tsquery';
        return "to_tsvector('simple', $doc) @@ $fn('simple', $ph)";
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

    /** SQL-side read stages of a column. @param list<string> $styles */
    public function readExpr(string $col, string $type, array $styles): string
    {
        switch ($this->name) {
            case 'mysql':
                if ($type === 'point') {
                    $col = "ST_AsText($col)";
                }
                for ($i = count($styles) - 1; $i >= 0; $i--) {
                    $col = match ($styles[$i]) {
                        'hex' => "UNHEX($col)",
                        'ip' => "INET6_NTOA($col)",
                        default => $col,
                    };
                }
                return $col;
            case 'postgres':
                if ($type === 'point') {
                    $col = "($col)::text";
                }
                return in_array('ip', $styles, true) ? "host($col)" : $col;
            default:
                return $col;
        }
    }

    /** SQL-side write stages around a bound value. @param list<string> $styles */
    public function writeExpr(string $ph, string $type, array $styles): string
    {
        switch ($this->name) {
            case 'mysql':
                if ($type === 'point') {
                    $ph = "ST_PointFromText($ph)";
                }
                foreach ($styles as $s) {
                    $ph = match ($s) {
                        'hex' => "HEX($ph)",
                        'ip' => "INET6_ATON($ph)",
                        default => $ph,
                    };
                }
                return $ph;
            case 'postgres':
                if ($type === 'point') {
                    $ph = "CAST($ph AS text)::point";
                }
                foreach ($styles as $s) {
                    if ($s === 'ip') {
                        $ph = "($ph)::inet";
                    }
                }
                return $ph;
            default:
                return $ph;
        }
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

    public function random(): string
    {
        return $this->name === 'mysql' ? 'RAND()' : 'random()';
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

    /** @param \Closure(int): string $arg a placeholder for the i-th function argument */
    public function columnFunction(string $fn, string $col, \Closure $arg): ?string
    {
        switch ($this->name) {
            case 'mysql':
                return match ($fn) {
                    'day_of_week' => "DAYOFWEEK($col)",
                    'year' => "YEAR($col)",
                    'month' => "MONTH($col)",
                    'date' => "DATE($col)",
                    'distance' => "ST_Distance_Sphere($col, POINT(" . $arg(0) . ', ' . $arg(1) . '))',
                    'point_x' => "ST_X($col)",
                    'point_y' => "ST_Y($col)",
                    default => null,
                };
            case 'postgres':
                return match ($fn) {
                    'day_of_week' => "(EXTRACT(DOW FROM $col)::int + 1)",
                    'year' => "EXTRACT(YEAR FROM $col)::int",
                    'month' => "EXTRACT(MONTH FROM $col)::int",
                    'date' => "CAST($col AS date)",
                    'distance' => self::haversine("{$col}[0]", "{$col}[1]", static fn(): string => 'CAST(' . $arg(0) . ' AS double precision)', static fn(): string => 'CAST(' . $arg(1) . ' AS double precision)'),
                    'point_x' => "{$col}[0]",
                    'point_y' => "{$col}[1]",
                    default => null,
                };
            default:
                return match ($fn) {
                    'day_of_week' => "(CAST(strftime('%w', $col) AS INTEGER) + 1)",
                    'year' => "CAST(strftime('%Y', $col) AS INTEGER)",
                    'month' => "CAST(strftime('%m', $col) AS INTEGER)",
                    'date' => "date($col)",
                    'distance' => self::haversine(self::sqlitePoint($col, false), self::sqlitePoint($col, true), static fn(): string => $arg(0), static fn(): string => $arg(1)),
                    'point_x' => self::sqlitePoint($col, false),
                    'point_y' => self::sqlitePoint($col, true),
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
                    $fn === 'now' => 'NOW()',
                    $fn === 'today' => 'CURDATE()',
                    $unit === null => null,
                    default => ($later ? 'DATE_ADD' : 'DATE_SUB') . '(NOW(), INTERVAL ' . $arg() . ' ' . strtoupper($unit) . ')',
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
                $clock = $now();
                $modifier = ($later ? "'+'" : "'-'") . ' || CAST(' . $arg() . " AS TEXT) || ' {$unit}s'";
                return $unit === 'month' ? "datetime($clock, $modifier, 'floor')" : "datetime($clock, $modifier)";
        }
    }

    /** Great-circle distance; $x2 and $y2 bind a value at each occurrence. */
    private static function haversine(string $x1, string $y1, \Closure $x2, \Closure $y2): string
    {
        $rad = static fn(string $v): string => "RADIANS($v)";
        return '(2 * ' . self::EARTH_RADIUS . ' * ASIN(SQRT(POWER(SIN((' . $rad($y2()) . ' - ' . $rad($y1) . ') / 2), 2) + COS(' . $rad($y1) . ') * COS(' . $rad($y2()) . ') * POWER(SIN((' . $rad($x2()) . ' - ' . $rad($x1) . ') / 2), 2))))';
    }

    /** One coordinate of the stored `POINT(x y)` text. */
    private static function sqlitePoint(string $col, bool $second): string
    {
        $space = "instr($col, ' ')";
        if ($second) {
            return "CAST(substr($col, $space + 1, length($col) - $space - 1) AS REAL)";
        }
        return "CAST(substr($col, 7, $space - 7) AS REAL)";
    }
}
