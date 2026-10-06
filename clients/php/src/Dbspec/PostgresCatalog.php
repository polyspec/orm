<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * PostgreSQL 의 현재 schema 를 중간 model 로 읽는다. 모든 query 는 schema 전체를
 * 한 번에 읽는다 (docs/dialects.md "Introspection").
 *
 * @internal
 */
final class PostgresCatalog
{
    private const TABLES = "SELECT c.relname, c.relkind::text, c.relispartition FROM pg_class c
WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND c.relname NOT LIKE 'dbspec\$%' ORDER BY c.relname";
    private const SEQUENCES = "SELECT c.relname FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'S'
AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'i') ORDER BY c.relname";
    private const COLUMNS = "SELECT c.relname, a.attname, quote_ident(a.attname), format_type(a.atttypid, a.atttypmod), a.attnotnull,
pg_get_expr(d.adbin, d.adrelid), a.attidentity::text, a.attgenerated::text, coalesce(co.collname, '')
FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
LEFT JOIN pg_collation co ON co.oid = a.attcollation
WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND a.attname NOT LIKE 'dbspec\$%'
ORDER BY c.relname, a.attnum";
    private const CONSTRAINTS = "SELECT c.relname, con.conname, con.contype::text, pg_get_constraintdef(con.oid), con.condeferrable,
con.convalidated, con.confmatchtype::text, con.confdeltype::text, con.confupdtype::text, CASE WHEN r.relnamespace = c.relnamespace THEN r.relname ELSE '' END,
array_to_string(ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, o)
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o), ','),
array_to_string(ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, o)
  JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.o), ',')
FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid LEFT JOIN pg_class r ON r.oid = con.confrelid
WHERE c.relnamespace = current_schema()::regnamespace AND con.contype <> 'n' ORDER BY c.relname, con.conname";
    private const INDEXES = "SELECT c.relname, i.relname, x.indisunique, x.indpred IS NOT NULL, x.indexprs IS NOT NULL,
x.indnatts <> x.indnkeyatts, am.amname,
array_to_string(ARRAY(SELECT a.attname FROM unnest(x.indkey) WITH ORDINALITY k(n, o)
  JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.n ORDER BY k.o), ','),
array_to_string(ARRAY(SELECT (o & 1)::text FROM unnest(x.indoption::int2[]) o), ',')
FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid JOIN pg_am am ON am.oid = i.relam
WHERE c.relnamespace = current_schema()::regnamespace
AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = x.indexrelid AND con.contype IN ('p', 'u', 'x'))
ORDER BY c.relname, i.relname";
    private const TRIGGERS = 'SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid), p.proname, p.prosrc, l.lanname
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_language l ON l.oid = p.prolang
WHERE NOT t.tgisinternal AND c.relnamespace = current_schema()::regnamespace ORDER BY c.relname, t.tgname';
    private const ROUTINES = 'SELECT p.proname FROM pg_proc p WHERE p.pronamespace = current_schema()::regnamespace ORDER BY p.proname';
    private const TYPE = '/^(smallint|integer|bigint|boolean|double precision|text|bytea|uuid|date)$|^numeric\((\d+),(\d+)\)$|^character varying\((\d+)\)$|^(time|timestamp)\((\d)\) without time zone$/D';
    private const LITERAL = "/^'((?:[^']|'')*)'::([a-z ]+)$/D";
    private const TRIGGER = '/^CREATE TRIGGER (\S+) (BEFORE|AFTER) (INSERT|UPDATE|DELETE) ON (?:\S+\.)?(\S+) FOR EACH ROW EXECUTE FUNCTION (\S+)\(\)$/D';

    public static function read(\PDO $connection): Catalog
    {
        $c = new Catalog();
        foreach (CatalogRows::read($connection, self::TABLES) as $row) {
            $name = CatalogRows::text($row, 0, self::TABLES);
            $kind = CatalogRows::text($row, 1, self::TABLES);
            if ($kind === 'p' || CatalogRows::flag($row, 2, self::TABLES)) {
                $c->report('partition', $name, $name, 'a partitioned table or a partition has no dbspec definition');
            } elseif ($kind === 'r') {
                $c->tables[] = new CatalogTable($name);
            } else {
                $c->report('view', $name, $name, "a relation of kind $kind has no dbspec definition");
            }
        }
        foreach (CatalogRows::read($connection, self::SEQUENCES) as $row) {
            $c->report('sequence', '', CatalogRows::text($row, 0, self::SEQUENCES), 'a sequence outside identity has no dbspec definition');
        }
        $quoted = [];
        $pending = [];
        $q = self::COLUMNS;
        foreach (CatalogRows::read($connection, $q) as $row) {
            [$table, $name, $quotedName, $formatted] = array_map(static fn(int $i): string => CatalogRows::text($row, $i, $q), [0, 1, 2, 3]);
            $notNull = CatalogRows::flag($row, 4, $q);
            $default = CatalogRows::nullableText($row, 5, $q);
            [$identity, $generated, $collation] = array_map(static fn(int $i): string => CatalogRows::text($row, $i, $q), [6, 7, 8]);
            $t = $c->table($table);
            if ($t === null) {
                continue;
            }
            $type = self::type($formatted, $collation);
            if ($type === null || $generated !== '') {
                $c->report('column', $table, $name, "type $formatted with collation \"$collation\" has no dbspec type");
                continue;
            }
            $column = ['name' => $name, 'type' => $type, 'null' => !$notNull, 'identity' => false, 'default' => ''];
            if ($identity === 'd') {
                $column['identity'] = true;
            } elseif ($identity === 'a') {
                $c->report('column', $table, $name, 'an identity generated always has no dbspec definition');
                continue;
            }
            if ($default !== null) {
                $value = self::defaultLiteral($default, $type);
                if ($value === null) {
                    $c->report('column', $table, $name, "default $default is not a dbspec default");
                    continue;
                }
                $column['default'] = $value;
            }
            $column['type'] = $c->sharedType($column['type']);
            $t->columns[] = $column;
            $quoted[$table][$name] = $quotedName;
            if ($type->name === 'time') {
                $pending[$table][$name] = true;
            }
        }
        $checked = [];
        $q = self::CONSTRAINTS;
        foreach (CatalogRows::read($connection, $q) as $row) {
            [$table, $name, $kind, $definition] = array_map(static fn(int $i): string => CatalogRows::text($row, $i, $q), [0, 1, 2, 3]);
            $deferrable = CatalogRows::flag($row, 4, $q);
            $validated = CatalogRows::flag($row, 5, $q);
            [$match, $onDelete, $onUpdate, $refTable, $columns, $refs] = array_map(static fn(int $i): string => CatalogRows::text($row, $i, $q), range(6, 11));
            $t = $c->table($table);
            if ($t === null) {
                continue;
            }
            $list = explode(',', $columns);
            if (!$validated || $deferrable) {
                $c->report(self::kind($kind), $table, $name, 'a deferrable or not validated constraint has no dbspec definition');
            } elseif ($kind === 'p') {
                $t->primary = $list;
            } elseif ($kind === 'u') {
                if (str_contains($name, '$') || !str_starts_with($definition, 'UNIQUE (')) {
                    $c->report('unique', $table, $name, "the unique constraint $definition has no dbspec definition");
                    continue;
                }
                $t->uniques[] = ['name' => $name, 'columns' => $list, 'desc' => array_fill(0, count($list), false)];
            } elseif ($kind === 'f' && $refTable === '') {
                // 다른 schema 의 table 을 가리키는 foreign key 는 이 문서 밖의 table 을 가리킨다.
                $c->report('foreign_key', $table, $name, 'the referenced table is outside the current schema');
            } elseif ($kind === 'f') {
                $delete = self::action($onDelete);
                $update = self::action($onUpdate);
                if ($delete === null || $update === null || $match !== 's') {
                    $c->report('foreign_key', $table, $name, "actions $onDelete, $onUpdate or match $match have no dbspec definition");
                    continue;
                }
                $t->foreignKeys[] = ['name' => $name, 'columns' => $list, 'table' => $refTable, 'refs' => explode(',', $refs), 'onDelete' => $delete, 'onUpdate' => $update];
            } elseif ($kind === 'c') {
                if (str_contains($name, '$')) {
                    [$owner, $column] = explode('$', $name, 2);
                    $want = 'CHECK ((' . ($quoted[$table][$column] ?? '') . " < '24:00:00'::time without time zone))";
                    if ($owner !== $table || !isset($pending[$table][$column]) || $definition !== $want) {
                        $c->report('check', $table, $name, "the check $definition is not the renderer CHECK");
                        continue;
                    }
                    $checked[$table][$column] = true;
                    continue;
                }
                try {
                    $t->checks[] = ['name' => $name, 'predicate' => CheckDecoder::decode('postgres', $definition, $t->columnTypes())];
                } catch (CheckDecodeFailure $e) {
                    $c->report('check', $table, $name, $e->getMessage());
                }
            } else {
                $c->report(self::kind($kind), $table, $name, "a constraint of kind $kind has no dbspec definition");
            }
        }
        foreach ($pending as $table => $cols) {
            foreach ($cols as $column => $_) {
                if (!isset($checked[$table][$column])) {
                    $c->report('column', (string) $table, (string) $column, 'time without its renderer CHECK has no dbspec type');
                    $c->table((string) $table)->dropColumn((string) $column);
                }
            }
        }
        $q = self::INDEXES;
        foreach (CatalogRows::read($connection, $q) as $row) {
            $table = CatalogRows::text($row, 0, $q);
            $name = CatalogRows::text($row, 1, $q);
            [$unique, $partial, $expression, $include] = array_map(static fn(int $i): bool => CatalogRows::flag($row, $i, $q), [2, 3, 4, 5]);
            [$method, $columns, $options] = array_map(static fn(int $i): string => CatalogRows::text($row, $i, $q), [6, 7, 8]);
            $t = $c->table($table);
            if ($t === null) {
                continue;
            }
            if ($unique || $partial || $expression || $include || $method !== 'btree' || str_contains($name, '$')) {
                $c->report('index', $table, $name, "a unique, partial, expression, covering or $method index has no dbspec index");
                continue;
            }
            $t->indexes[] = ['name' => $name, 'columns' => explode(',', $columns), 'desc' => array_map(static fn(string $o): bool => $o === '1', explode(',', $options))];
        }
        $triggers = [];
        $functions = [];
        $q = self::TRIGGERS;
        foreach (CatalogRows::read($connection, $q) as $row) {
            [$table, $name, $definition, $function, $source, $language] = array_map(static fn(int $i): string => CatalogRows::text($row, $i, $q), range(0, 5));
            $functions[$function] = true;
            if (!preg_match(self::TRIGGER, $definition, $m) || $language !== 'plpgsql' || trim($m[1], '"') !== $name || trim($m[5], '"') !== $function) {
                $triggers[$table][] = ['name' => $name, 'statements' => [$definition]];
                continue;
            }
            $triggers[$table][] = ['name' => $name, 'statements' => [
                "CREATE FUNCTION \"$function\"() RETURNS trigger LANGUAGE plpgsql AS \$\$$source\$\$",
                "CREATE TRIGGER \"$name\" $m[2] $m[3] ON \"" . trim($m[4], '"') . "\" FOR EACH ROW EXECUTE FUNCTION \"$function\"()",
            ]];
        }
        CatalogTriggers::recognize($c, 'postgres', $triggers);
        foreach (CatalogRows::read($connection, self::ROUTINES) as $row) {
            $name = CatalogRows::text($row, 0, self::ROUTINES);
            if (!isset($functions[$name])) {
                $c->report('routine', '', $name, 'a function outside the renderer triggers has no dbspec definition');
            }
        }
        return $c;
    }

    /** format_type 과 collation 을 dbspec type 으로 읽는다. */
    private static function type(string $formatted, string $collation): ?ColumnType
    {
        if (!preg_match(self::TYPE, $formatted, $m)) {
            return null;
        }
        $g = static fn(int $i): string => $m[$i] ?? '';
        if ($g(2) !== '') {
            return new ColumnType('decimal', [(int) $g(2), (int) $g(3)]);
        }
        if ($g(4) !== '') {
            return $collation === 'C' ? new ColumnType('varchar', [(int) $g(4)]) : null;
        }
        if ($g(5) !== '') {
            return new ColumnType($g(5) === 'time' ? 'time' : 'datetime', [(int) $g(6)]);
        }
        return match ($g(1)) {
            'smallint' => new ColumnType('i16'),
            'integer' => new ColumnType('i32'),
            'bigint' => new ColumnType('i64'),
            'boolean' => new ColumnType('bool'),
            'double precision' => new ColumnType('f64'),
            'text' => $collation === 'C' ? new ColumnType('text') : null,
            'bytea' => new ColumnType('bytes'),
            'uuid' => new ColumnType('uuid'),
            'date' => new ColumnType('date'),
        };
    }

    /** pg_get_expr 의 default 를 dbspec literal 이나 now 로 읽는다. 아니면 null. */
    private static function defaultLiteral(string $text, ColumnType $type): ?string
    {
        if ($text === 'statement_timestamp()') {
            return $type->name === 'datetime' ? 'now' : null;
        }
        if (preg_match(self::LITERAL, $text, $m)) {
            $value = str_replace("''", "'", $m[1]);
            return in_array($type->name, ['i16', 'i32', 'i64', 'decimal', 'f64'], true) ? $value : Literal::quote($value);
        }
        if ($text === 'true' || $text === 'false') {
            return $type->name === 'bool' ? $text : null;
        }
        return preg_match('/^-?\d+(\.\d+)?$/D', $text) ? $text : null;
    }

    private static function action(string $code): ?string
    {
        return match ($code) {
            'r' => 'restrict',
            'c' => 'cascade',
            'n' => 'set_null',
            default => null,
        };
    }

    private static function kind(string $contype): string
    {
        return match ($contype) {
            'p', 'u' => 'unique',
            'f' => 'foreign_key',
            'c' => 'check',
            default => 'index',
        };
    }
}
