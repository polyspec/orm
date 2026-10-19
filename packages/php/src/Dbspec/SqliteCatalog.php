<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * Reads the SQLite main database into an intermediate model. It joins sqlite_master and table-valued
 * pragmas to read all tables at once (docs/spec/dialects.md "Introspection").
 *
 * @internal
 */
final class SqliteCatalog
{
    private const MASTER = "SELECT type, name, tbl_name, IFNULL(sql, '') FROM sqlite_master
WHERE name NOT LIKE 'sqlite_%' AND tbl_name NOT LIKE 'dbspec\$%' ORDER BY type, name";
    private const COLUMNS = "SELECT m.name, p.name, p.type, p.\"notnull\", p.dflt_value, p.pk, p.hidden FROM sqlite_master m
JOIN pragma_table_xinfo(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND p.name NOT LIKE 'dbspec\$%' ORDER BY m.name, p.cid";
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
        // table: constraints read from the CREATE TABLE text
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
            // pk is not used: primary key and identity are decided by the CREATE text. Only the shape of the value is checked.
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
            $checkName = Names::render($table, $name);
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
            $t->columns[] = ['name' => $column['name'], 'type' => $c->sharedType($column['type']), 'null' => $column['null'], 'identity' => $column['identity'], 'default' => $column['default']];
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
            // The pk and u origin indexes come from the primary key and unique definitions, and that definition is read or reported.
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

    /** Decides the dbspec type from the declared type and the column's renderer CHECK. The CHECK must match the renderer output of that type exactly. */
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
                // SQLite reports integer, which is a keyword, as INTEGER. Identity is decided by the CREATE text.
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

    /** Reads dflt_value as a dbspec literal or now. A decimal is an integer multiplied by the scale; a bool is 1 or 0. Otherwise null. */
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
     * Reads the primary key, identity,
     * foreign keys, and checks from the one-line CREATE TABLE text the renderer writes. Other table-level items are unsupported.
     *
     * @return array{0: array{checks: array<string, string>, order: list<string>, foreignKeys: list<array>, primary: list<string>, identity: string, columns: array<string, string>, unsupported: string}, 1: list<array{0: string, 1: string, 2: string}>}
     */
    private static function parseTable(string $text): array
    {
        // If unsupported is not empty, it is the reason the whole table could not be read.
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
                // A constraint without a name is reported with an empty name. Any other form of primary key makes the table unreadable.
                $kind = ['CHECK' => 'check', 'UNIQUE' => 'unique', 'FOREIGN KEY' => 'foreign_key'][$m[2]] ?? null;
                if ($kind === null) {
                    $st['unsupported'] = "the primary key \"$item\" has no dbspec definition";
                    return [$st, []];
                }
                $unsupported[] = [$kind, $m[1], "the table item \"$item\" has no dbspec definition"];
            } elseif (preg_match(self::COLUMN_ITEM, $item, $m)) {
                // The definition is read by pragma_table_xinfo, and its text is checked to be in renderer form.
                $st['columns'][$m[1]] = $item;
            } else {
                $st['unsupported'] = "the table item \"$item\" has no dbspec definition";
                return [$st, []];
            }
        }
        return [$st, $unsupported];
    }

    /**
     * Tells whether the column definition text is the renderer's column form: name, declared type, NULL or NOT
     * NULL, and, if present, only a DEFAULT. SQLite reports a type name that is a keyword
     * in upper case, so the type is compared without regard to case.
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

    /** Splits on commas outside parentheses and quotes. @return list<string> */
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
