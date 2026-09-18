<?php
declare(strict_types=1);

namespace Orm;

/**
 * Parses model method names with the chain grammar of docs/dsl.md. A name is
 * split into PascalCase words; column names never contain the connector and
 * operator segments, so the split is unambiguous.
 */
final class Chain
{
    private const LEADING = ['Ne' => 'ne', 'Eq' => '', 'Gt' => 'gt', 'Lt' => 'lt', 'Ge' => 'ge', 'Le' => 'le', 'Lk' => 'lk', 'Lb' => 'lb', 'Between' => 'between'];
    private const COMPARE = ['Eq' => '', 'Ne' => 'ne', 'Gt' => 'gt', 'Lt' => 'lt', 'Ge' => 'ge', 'Le' => 'le'];
    public const ENGINE_OP = ['' => 'eq', 'ne' => 'not_eq', 'gt' => 'gt', 'lt' => 'lt', 'ge' => 'gte', 'le' => 'lte', 'lk' => 'contains', 'lb' => 'contains_binary', 'between' => 'between'];
    private const OPS_BY_TYPE = [
        'i32' => ['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'between', 'is_null', 'is_not_null'],
        'i64' => ['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'between', 'is_null', 'is_not_null'],
        'f64' => ['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'between', 'is_null', 'is_not_null'],
        'decimal' => ['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'between', 'is_null', 'is_not_null'],
        'date' => ['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'between', 'is_null', 'is_not_null'],
        'time' => ['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'between', 'is_null', 'is_not_null'],
        'datetime' => ['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'between', 'is_null', 'is_not_null'],
        'string' => ['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'contains', 'contains_binary', 'is_null', 'is_not_null'],
        'text' => ['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'contains', 'contains_binary', 'is_null', 'is_not_null'],
        'enum' => ['eq', 'not_eq', 'in', 'not_in', 'is_null', 'is_not_null'],
        'bool' => ['eq', 'not_eq', 'is_null', 'is_not_null'],
        'inet' => ['eq', 'not_eq', 'in', 'not_in', 'is_null', 'is_not_null'],
        'bytes' => ['eq', 'not_eq', 'in', 'not_in', 'is_null', 'is_not_null'],
        'jsontext' => ['is_null', 'is_not_null'],
        'point' => ['is_null', 'is_not_null'],
    ];

    /** @var array<string, mixed> parsed names by class and name */
    private static array $cache = [];

    /** @return list<string> */
    public static function words(string $name): array
    {
        $parts = preg_split('/(?=[A-Z])/', $name, -1, PREG_SPLIT_NO_EMPTY);
        return $parts === false ? [] : $parts;
    }

    public static function pascal(string $snake): string
    {
        return str_replace('_', '', ucwords($snake, '_'));
    }

    public static function snake(string $pascal): string
    {
        return strtolower((string) preg_replace('/(?<!^)[A-Z]/', '_$0', $pascal));
    }

    /**
     * The engine operator rule for a column (styled columns accept equality
     * and null checks only, or null checks only).
     * @param array{type: string, nullable: bool, styles: list<string>} $col
     */
    public static function opAllowed(array $col, string $op): bool
    {
        if (in_array($op, ['eq_col', 'not_eq_col', 'gt_col', 'gte_col', 'lt_col', 'lte_col', 'expr', 'match', 'match_boolean'], true)) {
            return true;
        }
        if ($col['styles'] !== [] && $col['type'] !== 'inet') {
            if ($col['styles'][0] === 'aes') {
                return in_array($op, ['eq', 'not_eq', 'in', 'not_in', 'is_null', 'is_not_null'], true);
            }
            return $op === 'is_null' || $op === 'is_not_null';
        }
        return in_array($op, self::OPS_BY_TYPE[$col['type']] ?? [], true);
    }

    /** @param array{type: string, styles: list<string>} $col */
    public static function appStyled(array $col): bool
    {
        foreach ($col['styles'] as $s) {
            if (!Codec::isHostStyle($s)) {
                return true;
            }
        }
        return false;
    }

    /** @param array{type: string, styles: list<string>} $col */
    public static function functionColumn(array $col): bool
    {
        return !self::appStyled($col) && in_array($col['type'], ['date', 'datetime', 'point'], true);
    }

    /**
     * @param class-string<Model> $class
     * @return list<array{conn: string, op: string, column: string, columns: list<string>, compare: string}>
     */
    public static function parse(string $class, string $name): array
    {
        $key = $class . "\0c\0" . $name;
        if (!array_key_exists($key, self::$cache)) {
            try {
                self::$cache[$key] = self::parseChain($class::meta(), $name);
            } catch (OrmException $e) {
                self::$cache[$key] = $e;
            }
        }
        $v = self::$cache[$key];
        if ($v instanceof OrmException) {
            throw $v;
        }
        return $v;
    }

    private static function fail(string $message): never
    {
        throw new OrmException(Code::CONFIG, $message);
    }

    /** @return array<string, string> PascalCase name => column */
    private static function index(array $meta): array
    {
        $out = [];
        foreach ($meta['columns'] as $name => $_) {
            $out[self::pascal($name)] = $name;
        }
        return $out;
    }

    /** The column of the entity, or of any registered entity when $meta is null, with the PascalCase name. */
    public static function columnName(?array $meta, string $pascal): string
    {
        if ($meta !== null) {
            return self::index($meta)[$pascal] ?? '';
        }
        foreach (Registry::models() as $class) {
            $column = self::index($class::meta())[$pascal] ?? '';
            if ($column !== '') {
                return $column;
            }
        }
        return '';
    }

    private static function parseChain(array $meta, string $name): array
    {
        $ws = self::words($name);
        if ($ws === []) {
            self::fail("empty condition name");
        }
        $keys = [];
        $conn = '';
        $start = 0;
        $count = count($ws);
        for ($i = 0; $i <= $count; $i++) {
            if ($i < $count && $ws[$i] !== 'And' && $ws[$i] !== 'Or') {
                continue;
            }
            $key = self::parseKey($meta, array_slice($ws, $start, $i - $start));
            $key['conn'] = $conn;
            $keys[] = $key;
            if ($i < $count) {
                $conn = strtolower($ws[$i]);
                $start = $i + 1;
            }
        }
        return $keys;
    }

    private static function parseKey(array $meta, array $ws): array
    {
        if ($ws === []) {
            self::fail('a condition key is empty');
        }
        $text = implode('', $ws);
        $ix = self::index($meta);
        $candidates = [];
        $errors = [];
        $try = function (callable $fn) use (&$candidates, &$errors): void {
            try {
                $candidates[] = $fn();
            } catch (OrmException $e) {
                $errors[] = $e->getMessage();
            }
        };
        $key = static fn(string $op, string $column = '', array $columns = [], string $compare = ''): array => ['conn' => '', 'op' => $op, 'column' => $column, 'columns' => $columns, 'compare' => $compare];
        if (isset($ix[$text])) {
            $try(fn() => self::checkOp($meta, $ix[$text], '', $key('', $ix[$text])));
        }
        if (isset(self::LEADING[$ws[0]]) && count($ws) > 1) {
            if ($ws[0] === 'Ne' && $ws[1] === 'Tuple') {
                $try(fn() => self::tupleKey($meta, $ix, array_slice($ws, 2), 'ne_tuple'));
            } else {
                $rest = implode('', array_slice($ws, 1));
                if (isset($ix[$rest])) {
                    $op = self::LEADING[$ws[0]];
                    $try(fn() => self::checkOp($meta, $ix[$rest], $op, $key($op, $ix[$rest])));
                }
            }
        }
        if ($ws[0] === 'Tuple') {
            $try(fn() => self::tupleKey($meta, $ix, array_slice($ws, 1), 'tuple'));
        }
        if ($ws[0] === 'Fulltext') {
            $try(fn() => self::fulltextKey($meta, $ix, array_slice($ws, 1), 'fulltext'));
            if (($ws[1] ?? '') === 'Boolean') {
                $try(fn() => self::fulltextKey($meta, $ix, array_slice($ws, 2), 'fulltext_boolean'));
            }
        }
        for ($i = 1; $i < count($ws) - 1; $i++) {
            if (!array_key_exists($ws[$i], self::COMPARE)) {
                continue;
            }
            $left = implode('', array_slice($ws, 0, $i));
            if (!isset($ix[$left])) {
                continue;
            }
            $right = implode('', array_slice($ws, $i + 1));
            $rightColumn = self::columnName(null, $right);
            if ($rightColumn === '') {
                $errors[] = "no model has the column $right";
                continue;
            }
            $op = self::COMPARE[$ws[$i]];
            $try(fn() => self::checkOp($meta, $ix[$left], $op, $key($op, $ix[$left], [], $rightColumn)));
        }
        if (count($candidates) === 1) {
            return $candidates[0];
        }
        if ($candidates === []) {
            self::fail($errors !== [] ? "$text: " . implode('; ', $errors) : "$text is not a column of {$meta['entity']}");
        }
        self::fail("$text has more than one meaning");
    }

    private static function checkOp(array $meta, string $column, string $op, array $key): array
    {
        $col = $meta['columns'][$column];
        if ($key['compare'] !== '') {
            if (!self::opAllowed($col, self::ENGINE_OP[$op] . '_col') || self::appStyled($col)) {
                self::fail("{$meta['entity']}.$column cannot be compared with a column");
            }
            return $key;
        }
        $allowed = self::opAllowed($col, self::ENGINE_OP[$op]);
        if ($op === '' || $op === 'ne') {
            $allowed = $allowed || self::opAllowed($col, 'is_null');
        }
        if (in_array($op, ['', 'gt', 'lt', 'ge', 'le'], true) && self::functionColumn($col)) {
            $allowed = true;
        }
        if (!$allowed) {
            self::fail("{$meta['entity']}.$column does not accept the " . ($op === '' ? 'equality' : $op) . ' operator');
        }
        return $key;
    }

    /** @return list<string>|null */
    private static function splitWith(array $ix, array $ws): ?array
    {
        $out = [];
        $start = 0;
        for ($i = 0; $i <= count($ws); $i++) {
            if ($i < count($ws) && $ws[$i] !== 'With') {
                continue;
            }
            $name = implode('', array_slice($ws, $start, $i - $start));
            if (!isset($ix[$name])) {
                return null;
            }
            $out[] = $ix[$name];
            $start = $i + 1;
        }
        return $out;
    }

    private static function tupleKey(array $meta, array $ix, array $ws, string $op): array
    {
        $cols = self::splitWith($ix, $ws);
        if ($cols === null || count($cols) < 2) {
            self::fail("a tuple needs two or more columns of {$meta['entity']} joined by With");
        }
        foreach ($cols as $c) {
            $col = $meta['columns'][$c];
            if (self::appStyled($col) || !self::opAllowed($col, 'in')) {
                self::fail("{$meta['entity']}.$c cannot be used in a tuple");
            }
        }
        return ['conn' => '', 'op' => $op, 'column' => '', 'columns' => $cols, 'compare' => ''];
    }

    private static function fulltextKey(array $meta, array $ix, array $ws, string $op): array
    {
        $cols = self::splitWith($ix, $ws);
        if ($cols === null || $cols === []) {
            self::fail("full-text columns of {$meta['entity']} are not valid");
        }
        foreach ($meta['fulltext'] as $index) {
            if ($index === $cols) {
                return ['conn' => '', 'op' => $op, 'column' => '', 'columns' => $cols, 'compare' => ''];
            }
        }
        self::fail("{$meta['entity']} has no full-text index on " . implode(', ', $cols));
    }

    /** @return list<array{column: string, desc: bool}> */
    public static function order(string $class, string $name): array
    {
        $key = $class . "\0o\0" . $name;
        if (isset(self::$cache[$key])) {
            return self::$cache[$key];
        }
        $meta = $class::meta();
        $ix = self::index($meta);
        $ws = self::words($name);
        $out = [];
        $start = 0;
        for ($i = 0; $i <= count($ws); $i++) {
            if ($i < count($ws) && $ws[$i] !== 'And') {
                continue;
            }
            $part = array_slice($ws, $start, $i - $start);
            $start = $i + 1;
            $dir = $part === [] ? '' : $part[count($part) - 1];
            if (count($part) < 2 || ($dir !== 'Asc' && $dir !== 'Desc')) {
                self::fail("orderBy$name: each key needs a column and Asc or Desc");
            }
            $column = implode('', array_slice($part, 0, -1));
            if (!isset($ix[$column])) {
                self::fail("orderBy$name: $column is not a column of {$meta['entity']}");
            }
            $out[] = ['column' => $ix[$column], 'desc' => $dir === 'Desc'];
        }
        return self::$cache[$key] = $out;
    }

    /**
     * Parses <L>With<R>: L is a column of $left and R of $right; a null side
     * accepts a column of any registered model.
     * @return array{0: string, 1: string}
     */
    public static function pair(?array $left, ?array $right, string $name): array
    {
        $ws = self::words($name);
        $found = [];
        foreach ($ws as $i => $w) {
            if ($w !== 'With') {
                continue;
            }
            $l = self::columnName($left, implode('', array_slice($ws, 0, $i)));
            $r = self::columnName($right, implode('', array_slice($ws, $i + 1)));
            if ($l !== '' && $r !== '') {
                $found[] = [$l, $r];
            }
        }
        if (count($found) === 1) {
            return $found[0];
        }
        self::fail($found === [] ? "$name is not <column>With<column>" : "$name has more than one meaning");
    }
}
