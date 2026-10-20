<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * The declaration of a chain method of a generated model: the @method tag that the class comment gets for a method
 * name that the sources call, or null when no column, chain or operator of docs/spec/dsl.md accepts the name. The rules
 * are those of Model::__call and Chain, and the declared set is that of the node orm-gen (packages/ts
 * src/generate/typescript.ts).
 */
final class ChainDeclare
{
    /**
     * @param list<array> $metas the meta of every model of the document set, with its class name in 'class'
     */
    public function __construct(private readonly array $metas)
    {
    }

    /**
     * @return array{params: string, returns: string, min: int, max: int}|null
     */
    public function declare(array $meta, string $name): ?array
    {
        $upper = ucfirst($name);
        foreach (['GetsBy' => 'gets', 'GetBy' => 'get', 'GetCountBy' => 'count'] as $prefix => $kind) {
            if (!str_starts_with($upper, $prefix)) {
                continue;
            }
            $keys = $this->keys($meta, substr($upper, strlen($prefix)));
            if ($keys === null) {
                return null;
            }
            return $this->conditions($meta, $keys) + ['returns' => match ($kind) {
                'gets' => '\\Polyspec\\Orm\\Collection<static>',
                'get' => '?static',
                default => 'int',
            }];
        }
        if (str_starts_with($upper, 'OrderBy')) {
            try {
                $keys = Chain::orderMeta($meta, substr($upper, 7));
            } catch (OrmException) {
                return null;
            }
            $single = count($keys) === 1;
            return ['params' => $single ? '\\Polyspec\\Orm\\Func ...$fn' : '', 'returns' => '$this', 'min' => 0, 'max' => $single ? 1 : 0];
        }
        foreach (['LeftJoin', 'Join'] as $prefix) {
            if (str_starts_with($upper, $prefix) && strlen($upper) > strlen($prefix)) {
                $pair = $this->pair($meta, null, substr($upper, strlen($prefix)));
                return $pair === null ? null : ['params' => $this->owners($pair[1]) . ' $child', 'returns' => '$this', 'min' => 1, 'max' => 1];
            }
        }
        if (str_starts_with($upper, 'Match') && strlen($upper) > 5) {
            return $this->pair(null, $meta, substr($upper, 5)) === null ? null : ['params' => '', 'returns' => '$this', 'min' => 0, 'max' => 0];
        }
        if (str_starts_with($upper, 'Alias') && strlen($upper) > 5) {
            return ['params' => '', 'returns' => '$this', 'min' => 0, 'max' => 0];
        }
        if (str_starts_with($upper, 'Possible') && strlen($upper) > 8) {
            return $this->schemaColumn(substr($upper, 8)) === '' ? null : ['params' => 'mixed $value', 'returns' => '$this', 'min' => 1, 'max' => 1];
        }
        if (str_starts_with($upper, 'New') && strlen($upper) > 3) {
            return Chain::columnName($meta, substr($upper, 3)) !== '' ? null : ['params' => 'mixed $value', 'returns' => '$this', 'min' => 1, 'max' => 1];
        }
        if (str_starts_with($upper, 'AddColumn') && strlen($upper) > 9) {
            $rest = substr($upper, 9);
            $at = strpos($rest, 'Alias');
            if ($at !== false && $at > 0 && Chain::columnName($meta, substr($rest, 0, $at)) !== '' && strlen($rest) > $at + 5) {
                return Chain::columnName($meta, substr($rest, $at + 5)) !== '' ? null
                    : ['params' => '\\Polyspec\\Orm\\Func $fn', 'returns' => '$this', 'min' => 1, 'max' => 1];
            }
            return Chain::columnName($meta, $rest) !== '' ? null
                : ['params' => '\\Closure(static): \\Polyspec\\Orm\\Model $fn', 'returns' => '$this', 'min' => 1, 'max' => 1];
        }
        if (str_starts_with($upper, 'Get')) {
            return null;
        }
        $chain = $upper;
        if (str_starts_with($upper, 'And') && strlen($upper) > 3 && ctype_upper($upper[3])) {
            $chain = substr($upper, 3);
        } elseif (str_starts_with($upper, 'Or') && strlen($upper) > 2 && ctype_upper($upper[2])) {
            $chain = substr($upper, 2);
        }
        $keys = $this->keys($meta, $chain);
        return $keys === null ? null : $this->conditions($meta, $keys) + ['returns' => '$this'];
    }

    /** The @method tag of a declaration. */
    public static function tag(string $name, array $declaration): string
    {
        return "@method {$declaration['returns']} $name({$declaration['params']})";
    }

    /** The tag of the getter `get<Name>` of a value that a scanned `alias`, `new` or `addColumn` call, or a relation, names. */
    public static function getter(string $name): string
    {
        return "@method mixed $name()";
    }

    /** @return list<array>|null */
    private function keys(array $meta, string $chain): ?array
    {
        try {
            return Chain::parseMeta($meta, $this->metas, $chain);
        } catch (OrmException) {
            return null;
        }
    }

    /** @return array{0: string, 1: string}|null the columns of <L>With<R>, where a null side is any model of the set */
    private function pair(?array $left, ?array $right, string $name): ?array
    {
        try {
            return Chain::pairMeta($left, $right, $this->metas, $name);
        } catch (OrmException) {
            return null;
        }
    }

    private function schemaColumn(string $pascal): string
    {
        foreach ($this->metas as $meta) {
            $column = Chain::columnName($meta, $pascal);
            if ($column !== '') {
                return $column;
            }
        }
        return '';
    }

    /** The union of the classes of the models that have a column of this name; the child of a join is one of them. */
    private function owners(string $column): string
    {
        $classes = [];
        foreach ($this->metas as $meta) {
            if (isset($meta['columns'][$column])) {
                $classes[] = '\\' . $meta['class'];
            }
        }
        return implode('|', $classes);
    }

    /**
     * @param list<array> $keys
     * @return array{params: string, min: int, max: int}
     */
    private function conditions(array $meta, array $keys): array
    {
        $params = [];
        foreach ($keys as $i => $key) {
            $params[] = $this->keyType($meta, $key) . " \$v$i";
        }
        $first = $keys[0];
        if (
            count($keys) === 1 && $first['compare'] === '' && $first['column'] !== ''
            && in_array($first['op'], ['', 'ne', 'gt', 'lt', 'ge', 'le'], true) && Chain::functionColumn($meta['columns'][$first['column']])
        ) {
            return ['params' => $params[0] . ', mixed $compared = null', 'min' => 1, 'max' => 2];
        }
        return ['params' => implode(', ', $params), 'min' => count($keys), 'max' => count($keys)];
    }

    private function keyType(array $meta, array $key): string
    {
        if ($key['op'] === 'tuple' || $key['op'] === 'ne_tuple') {
            return 'list<list<mixed>>';
        }
        if ($key['compare'] !== '') {
            return $this->owners($key['compare']);
        }
        $c = $meta['columns'][$key['column']];
        $plain = !RuntimeModel::styled($c);
        $s = $plain ? self::scalar($c) : 'mixed';
        $terms = [];
        switch ($key['op']) {
            case '':
            case 'ne':
                if ($plain) {
                    array_push($terms, $s, "list<$s>");
                }
                $terms[] = '\\Polyspec\\Orm\\Func';
                if ($plain) {
                    $terms[] = '\\Polyspec\\Orm\\Model';
                }
                if ($c['nullable']) {
                    $terms[] = 'null';
                }
                break;
            case 'lk':
            case 'lb':
                $terms[] = 'string';
                break;
            case 'between':
                $terms[] = "array{0: $s, 1: $s}";
                break;
            default:
                if ($plain) {
                    $terms[] = $s;
                }
                $terms[] = '\\Polyspec\\Orm\\Func';
        }
        return implode('|', $terms);
    }

    /** The PHP type of a value of a column that holds a plain value. */
    private static function scalar(array $c): string
    {
        if ($c['codec'] !== []) {
            return 'string';
        }
        return match ($c['type']) {
            'i16', 'i32', 'i64' => 'int',
            'f64' => 'int|float',
            'decimal' => 'string|int|float',
            'bool' => 'bool',
            'date', 'datetime' => '\\DateTimeInterface|string',
            default => 'string',
        };
    }
}
