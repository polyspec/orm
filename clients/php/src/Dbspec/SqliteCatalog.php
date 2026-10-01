<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * SQLite 의 main database 를 중간 model 로 읽는다. sqlite_master 와 table-valued
 * pragma 를 join 해 모든 table 을 한 번에 읽는다 (docs/dialects.md "Introspection").
 *
 * @internal
 */
final class SqliteCatalog
{
    private const MASTER = "SELECT type, name, tbl_name, IFNULL(sql, '') FROM sqlite_master
WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name";
    private const COLUMNS = "SELECT m.name, p.name, p.type, p.\"notnull\", p.dflt_value, p.pk, p.hidden FROM sqlite_master m
JOIN pragma_table_xinfo(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid";
    private const INDEXES = "SELECT m.name, l.name, l.\"unique\", l.origin, l.partial,
IFNULL((SELECT group_concat(IFNULL(x.name, ''), ',') FROM (SELECT name FROM pragma_index_xinfo(l.name) WHERE key = 1 ORDER BY seqno) x), ''),
IFNULL((SELECT group_concat(x.\"desc\", ',') FROM (SELECT \"desc\" FROM pragma_index_xinfo(l.name) WHERE key = 1 ORDER BY seqno) x), '')
FROM sqlite_master m JOIN pragma_index_list(m.name) l WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, l.name";
    private const DECLARED = '/^(smallint|integer|bigint|BOOLEAN|REAL|TEXT|BLOB|DATE|TIME|DATETIME|INTEGER)$|^DECIMALINT\((\d+),(\d+)\)$|^varchar\((\d+)\)$/D';
    private const FOREIGN_KEY_ITEM = '/^CONSTRAINT "([^"]+)" FOREIGN KEY \(([^)]*)\) REFERENCES "([^"]+)" \(([^)]*)\) ON DELETE (RESTRICT|CASCADE|SET NULL) ON UPDATE (RESTRICT|CASCADE|SET NULL)$/D';
    private const CHECK_ITEM = '/^CONSTRAINT "([^"]+)" CHECK \((.*)\)$/D';
    private const PRIMARY_KEY_ITEM = '/^PRIMARY KEY \(([^)]*)\)$/D';
    private const IDENTITY_COLUMN = '/^"([^"]+)" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT$/D';
    private const COLUMN_ITEM = '/^"([^"]+)" /';
    private const CONSTRAINT_ITEM = '/^(?:CONSTRAINT "([^"]+)" )?(CHECK|UNIQUE|FOREIGN KEY|PRIMARY KEY)\b/';
    private const NUMBER_DEFAULT = '/^-?\d+(\.\d+)?$/D';

    public static function read(\PDO $connection): Catalog
    {
        $c = new Catalog();
        // table: CREATE TABLE text 에서 읽은 constraint
        $parsed = [];
        $triggers = [];
        $q = self::MASTER;
        foreach (CatalogRows::read($connection, $q) as $row) {
            [$kind, $name, $table, $text] = array_map(static fn(int $i): string => CatalogRows::text($row, $i, $q), [0, 1, 2, 3]);
            if ($kind === 'table') {
                if (str_starts_with($text, 'CREATE VIRTUAL TABLE') || str_ends_with($text, 'WITHOUT ROWID')) {
                    $c->report('table', $name, $name, 'a virtual or WITHOUT ROWID table has no dbspec definition');
                    continue;
                }
                [$st, $unsupported] = self::parseTable($text);
                if ($st['unsupported'] !== '') {
                    $c->report('table', $name, $name, $st['unsupported']);
                    continue;
                }
                foreach ($unsupported as [$unsupportedKind, $unsupportedName, $reason]) {
                    $c->report($unsupportedKind, $name, $unsupportedName, $reason);
                }
                $parsed[$name] = $st;
                $t = new CatalogTable($name);
                $t->primary = $st['primary'];
                $t->foreignKeys = $st['foreignKeys'];
                $c->tables[] = $t;
            } elseif ($kind === 'view') {
                $c->report('view', $name, $name, 'a view has no dbspec definition');
            } elseif ($kind === 'trigger') {
                $triggers[$table][] = ['name' => $name, 'statements' => [$text]];
            }
        }
        $q = self::COLUMNS;
        foreach (CatalogRows::read($connection, $q) as $row) {
            [$table, $name, $declared] = array_map(static fn(int $i): string => CatalogRows::text($row, $i, $q), [0, 1, 2]);
            $notNull = CatalogRows::integer($row, 3, $q);
            $default = CatalogRows::nullableText($row, 4, $q);
            // pk 는 쓰지 않는다: primary key 와 identity 는 CREATE text 가 정한다. 값의 모양만 확인한다.
            CatalogRows::integer($row, 5, $q);
            $hidden = CatalogRows::integer($row, 6, $q);
            $t = $c->table($table);
            if ($t === null) {
                continue;
            }
            if ($hidden !== 0) {
                $c->report('column', $table, $name, 'a generated column has no dbspec definition');
                continue;
            }
            $item = $parsed[$table]['columns'][$name] ?? '';
            if ($parsed[$table]['identity'] !== $name && !self::columnText($item, $name, $declared, $notNull !== 0, $default)) {
                $c->report('column', $table, $name, "the column definition \"$item\" has clauses that dbspec does not read");
                continue;
            }
            $column = ['name' => $name, 'null' => $notNull === 0, 'identity' => false, 'default' => ''];
            $checkName = Catalog::rendererCheckName($table, $name);
            $hasCheck = array_key_exists($checkName, $parsed[$table]['checks']);
            $check = $parsed[$table]['checks'][$checkName] ?? '';
            if ($parsed[$table]['identity'] === $name) {
                $column['type'] = new ColumnType('i64');
                $column['identity'] = true;
            } else {
                $type = self::type($declared, $name, $check, $hasCheck);
                if ($type === null) {
                    $c->report('column', $table, $name, "declared type $declared with CHECK \"$check\" has no dbspec type");
                    continue;
                }
                $column['type'] = $type;
            }
            unset($parsed[$table]['checks'][$checkName]);
            if ($default !== null) {
                $value = self::defaultLiteral($default, $column['type']);
                if ($value === null) {
                    $c->report('column', $table, $name, "default $default is not a dbspec default");
                    continue;
                }
                $column['default'] = $value;
            }
            $t->columns[] = ['name' => $column['name'], 'type' => $column['type'], 'null' => $column['null'], 'identity' => $column['identity'], 'default' => $column['default']];
        }
        foreach ($c->tables as $t) {
            $st = $parsed[$t->name];
            foreach ($st['order'] as $name) {
                if (!array_key_exists($name, $st['checks'])) {
                    continue;
                }
                $expression = $st['checks'][$name];
                if (str_contains($name, '$')) {
                    $c->report('check', $t->name, $name, "the check $expression is not the renderer CHECK");
                    continue;
                }
                try {
                    $t->checks[] = ['name' => $name, 'predicate' => CheckDecoder::decode('sqlite', $expression, $t->columnTypes())];
                } catch (CheckDecodeFailure $e) {
                    $c->report('check', $t->name, $name, $e->getMessage());
                }
            }
        }
        $q = self::INDEXES;
        foreach (CatalogRows::read($connection, $q) as $row) {
            $table = CatalogRows::text($row, 0, $q);
            $name = CatalogRows::text($row, 1, $q);
            $unique = CatalogRows::integer($row, 2, $q);
            $origin = CatalogRows::text($row, 3, $q);
            $partial = CatalogRows::integer($row, 4, $q);
            $columns = CatalogRows::text($row, 5, $q);
            $desc = CatalogRows::text($row, 6, $q);
            $t = $c->table($table);
            // pk 와 u origin index 는 primary key 와 unique 정의에서 나오며, 그 정의를 읽거나 보고한다.
            if ($t === null || $origin === 'pk' || $origin === 'u') {
                continue;
            }
            $list = explode(',', $columns);
            if ($origin !== 'c' || $partial !== 0 || str_contains($name, '$') || in_array('', $list, true)) {
                $c->report('index', $table, $name, "an index of origin $origin, a partial or an expression index has no dbspec definition");
                continue;
            }
            $key = ['name' => $name, 'columns' => $list, 'desc' => array_map(static fn(string $d): bool => $d === '1', explode(',', $desc))];
            if ($unique !== 0) {
                $t->uniques[] = $key;
            } else {
                $t->indexes[] = $key;
            }
        }
        CatalogTriggers::recognize($c, 'sqlite', $triggers);
        return $c;
    }

    /** 선언 type 과 그 column 의 renderer CHECK 로 dbspec type 을 정한다. CHECK 은 그 type 의 renderer 출력과 정확히 같아야 한다. */
    private static function type(string $declared, string $column, string $check, bool $hasCheck): ?ColumnType
    {
        if (!preg_match(self::DECLARED, $declared, $m)) {
            return null;
        }
        $g = static fn(int $i): string => $m[$i] ?? '';
        if ($g(2) !== '') {
            $candidates = [new ColumnType('decimal', [(int) $g(2), (int) $g(3)])];
        } elseif ($g(4) !== '') {
            $candidates = [new ColumnType('varchar', [(int) $g(4)])];
        } else {
            $candidates = match ($g(1)) {
                'smallint' => [new ColumnType('i16')],
                // SQLite 는 keyword 인 integer 를 INTEGER 로 보고한다. identity 는 CREATE text 가 정한다.
                'integer', 'INTEGER' => [new ColumnType('i32')],
                'bigint' => [new ColumnType('i64')],
                'BOOLEAN' => [new ColumnType('bool')],
                'REAL' => [new ColumnType('f64')],
                'TEXT' => [new ColumnType('text'), new ColumnType('uuid')],
                'BLOB' => [new ColumnType('bytes')],
                'DATE' => [new ColumnType('date')],
                'TIME', 'DATETIME' => array_map(static fn(int $p): ColumnType => new ColumnType($g(1) === 'TIME' ? 'time' : 'datetime', [$p]), range(0, 6)),
            };
        }
        foreach ($candidates as $type) {
            $want = Renderer::columnCheck(new Column($column, $type, false, false, null), 'sqlite');
            if (($want === '' && !$hasCheck) || ($want !== '' && $hasCheck && $want === $check)) {
                return $type;
            }
        }
        return null;
    }

    /** dflt_value 를 dbspec literal 이나 now 로 읽는다. decimal 은 scale 을 곱한 정수이고 bool 은 1 과 0 이다. 아니면 null. */
    private static function defaultLiteral(string $text, ColumnType $type): ?string
    {
        if ($type->name === 'datetime' && "($text)" === Renderer::columnDefault($type, 'now', 'sqlite')) {
            return 'now';
        }
        if ($type->name === 'bool' && ($text === '1' || $text === '0')) {
            return $text === '1' ? 'true' : 'false';
        }
        if (preg_match(self::NUMBER_DEFAULT, $text)) {
            return $type->name === 'decimal' ? Catalog::unscaledDecimal($text, $type->parameters[1]) : $text;
        }
        if (str_starts_with($text, "'") && str_ends_with($text, "'")) {
            return $text;
        }
        return null;
    }

    /**
     * renderer 가 쓰는 한 줄 CREATE TABLE text 에서 primary key, identity,
     * foreign key, check 를 읽는다. 그 밖의 table 수준 항목은 미지원이다.
     *
     * @return array{0: array{checks: array<string, string>, order: list<string>, foreignKeys: list<array>, primary: list<string>, identity: string, columns: array<string, string>, unsupported: string}, 1: list<array{0: string, 1: string, 2: string}>}
     */
    private static function parseTable(string $text): array
    {
        // unsupported 가 비어 있지 않으면 table 전체를 읽지 못한 이유다.
        $st = ['checks' => [], 'order' => [], 'foreignKeys' => [], 'primary' => [], 'identity' => '', 'columns' => [], 'unsupported' => ''];
        $open = strpos($text, '(');
        if ($open === false || !str_ends_with($text, ')')) {
            $st['unsupported'] = 'the CREATE TABLE text has no column list';
            return [$st, []];
        }
        $unsupported = [];
        foreach (self::splitTopLevel(substr($text, $open + 1, -1)) as $item) {
            if (preg_match(self::IDENTITY_COLUMN, $item, $m)) {
                $st['identity'] = $m[1];
                $st['primary'] = [$m[1]];
            } elseif (preg_match(self::PRIMARY_KEY_ITEM, $item, $m)) {
                $st['primary'] = self::unquoteList($m[1]);
            } elseif (preg_match(self::FOREIGN_KEY_ITEM, $item, $m)) {
                $st['foreignKeys'][] = ['name' => $m[1], 'columns' => self::unquoteList($m[2]), 'table' => $m[3], 'refs' => self::unquoteList($m[4]),
                    'onDelete' => Catalog::actionName($m[5]), 'onUpdate' => Catalog::actionName($m[6])];
            } elseif (preg_match(self::CHECK_ITEM, $item, $m)) {
                $st['checks'][$m[1]] = $m[2];
                $st['order'][] = $m[1];
            } elseif (preg_match(self::CONSTRAINT_ITEM, $item, $m)) {
                // 이름 없는 constraint 는 이름이 빈 객체로 보고한다. primary key 의 다른 형식은 table 을 읽지 못하게 한다.
                $kind = ['CHECK' => 'check', 'UNIQUE' => 'unique', 'FOREIGN KEY' => 'foreign_key'][$m[2]] ?? null;
                if ($kind === null) {
                    $st['unsupported'] = "the primary key \"$item\" has no dbspec definition";
                    return [$st, []];
                }
                $unsupported[] = [$kind, $m[1], "the table item \"$item\" has no dbspec definition"];
            } elseif (preg_match(self::COLUMN_ITEM, $item, $m)) {
                // 정의는 pragma_table_xinfo 가 읽고, 그 text 는 renderer 형식인지 확인한다.
                $st['columns'][$m[1]] = $item;
            } else {
                $st['unsupported'] = "the table item \"$item\" has no dbspec definition";
                return [$st, []];
            }
        }
        return [$st, $unsupported];
    }

    /**
     * column 정의 text 가 renderer 의 column 형식, 곧 이름, 선언 type, NULL 이나 NOT
     * NULL, 그리고 있으면 DEFAULT 뿐인지 알려 준다. SQLite 는 keyword 인 type 이름을
     * 대문자로 보고하므로 type 은 대소문자 없이 비교한다.
     */
    private static function columnText(string $item, string $name, string $declared, bool $notNull, ?string $default): bool
    {
        $prefix = "\"$name\" ";
        if (!str_starts_with($item, $prefix)) {
            return false;
        }
        $rest = substr($item, strlen($prefix));
        if (strlen($rest) < strlen($declared) || strcasecmp(substr($rest, 0, strlen($declared)), $declared) !== 0) {
            return false;
        }
        $rest = substr($rest, strlen($declared));
        $tail = $notNull ? ' NOT NULL' : ' NULL';
        if ($default === null) {
            return $rest === $tail;
        }
        return $rest === "$tail DEFAULT $default" || $rest === "$tail DEFAULT ($default)";
    }

    /** 괄호와 따옴표 밖의 쉼표로 나눈다. @return list<string> */
    private static function splitTopLevel(string $text): array
    {
        $out = [];
        $depth = 0;
        $start = 0;
        $quote = '';
        $n = strlen($text);
        for ($i = 0; $i < $n; $i++) {
            $ch = $text[$i];
            if ($quote !== '') {
                if ($ch === $quote) {
                    $quote = '';
                }
            } elseif ($ch === "'" || $ch === '"') {
                $quote = $ch;
            } elseif ($ch === '(') {
                $depth++;
            } elseif ($ch === ')') {
                $depth--;
            } elseif ($ch === ',' && $depth === 0) {
                $out[] = self::trimSpace(substr($text, $start, $i - $start));
                $start = $i + 1;
            }
        }
        $out[] = self::trimSpace(substr($text, $start));
        return $out;
    }

    /** @return list<string> */
    private static function unquoteList(string $text): array
    {
        return array_map(static fn(string $part): string => trim(self::trimSpace($part), '"'), explode(',', $text));
    }

    private static function trimSpace(string $text): string
    {
        return trim($text, " \t\n\r\v\f");
    }
}
