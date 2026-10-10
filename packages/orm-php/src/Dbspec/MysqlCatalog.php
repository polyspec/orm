<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * MySQL 의 현재 database 를 중간 model 로 읽는다. 모든 query 는 database 전체를
 * 한 번에 읽는다 (docs/dialects.md "Introspection").
 *
 * @internal
 */
final class MysqlCatalog
{
    private const TABLES = "SELECT TABLE_NAME, TABLE_TYPE, IFNULL(CREATE_OPTIONS, '') FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME NOT LIKE 'dbspec\$%' ORDER BY TABLE_NAME";
    private const COLUMNS = "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA,
IFNULL(CHARACTER_SET_NAME, ''), IFNULL(COLLATION_NAME, ''), IFNULL(GENERATION_EXPRESSION, '')
FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME NOT LIKE 'dbspec\$%' ORDER BY TABLE_NAME, ORDINAL_POSITION";
    private const INDEXES = "SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, IFNULL(COLUMN_NAME, ''), IFNULL(COLLATION, 'A'),
SUB_PART IS NOT NULL, EXPRESSION IS NOT NULL, INDEX_TYPE FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX";
    private const FOREIGN_KEYS = 'SELECT rc.TABLE_NAME, rc.CONSTRAINT_NAME, rc.REFERENCED_TABLE_NAME, rc.DELETE_RULE, rc.UPDATE_RULE,
rc.MATCH_OPTION, k.COLUMN_NAME, k.REFERENCED_COLUMN_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS rc
JOIN information_schema.KEY_COLUMN_USAGE k ON k.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
AND k.CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND k.TABLE_NAME = rc.TABLE_NAME
WHERE rc.CONSTRAINT_SCHEMA = DATABASE() ORDER BY rc.TABLE_NAME, rc.CONSTRAINT_NAME, k.ORDINAL_POSITION';
    // CHECK_CONSTRAINTS 와 TABLE_CONSTRAINTS 의 join 은 table 수에 비례해 느려지므로(2000 table 에서
    // 60초 이상) 두 query 로 읽고 이름으로 잇는다. MySQL 의 CHECK 이름은 database 안에서 유일하다.
    private const CHECK_CLAUSES = 'SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE() ORDER BY CONSTRAINT_NAME';
    private const CHECKS = "SELECT TABLE_NAME, CONSTRAINT_NAME, ENFORCED FROM information_schema.TABLE_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'CHECK' ORDER BY TABLE_NAME, CONSTRAINT_NAME";
    private const TRIGGERS = 'SELECT EVENT_OBJECT_TABLE, TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT
FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME';
    private const ROUTINES = 'SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE() ORDER BY ROUTINE_NAME';
    private const EVENTS = 'SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE() ORDER BY EVENT_NAME';
    private const TYPE = '/^(smallint|int|bigint|tinyint\(1\)|double|longtext|longblob|date|char\(36\)|time|datetime)(?:\((\d+)\))?$|^(decimal)\((\d+),(\d+)\)$|^(varchar)\((\d+)\)$/D';

    public static function read(\PDO $connection): Catalog
    {
        $c = new Catalog();
        foreach (CatalogRows::read($connection, self::TABLES) as $row) {
            $name = CatalogRows::text($row, 0, self::TABLES);
            $kind = CatalogRows::text($row, 1, self::TABLES);
            $options = CatalogRows::text($row, 2, self::TABLES);
            if ($kind !== 'BASE TABLE') {
                $c->report('view', $name, $name, 'a ' . strtolower($kind) . ' has no dbspec definition');
            } elseif (str_contains($options, 'partitioned')) {
                $c->report('partition', $name, $name, 'a partitioned table has no dbspec definition');
            } else {
                $c->tables[] = new CatalogTable($name);
            }
        }
        $columns = [];
        // table: column: renderer CHECK 이 있어야 정해지는 type 의 catalog type
        $pending = [];
        foreach (CatalogRows::read($connection, self::COLUMNS) as $row) {
            [$table, $name, $columnType, $nullable] = array_map(static fn(int $i): string => CatalogRows::text($row, $i, self::COLUMNS), [0, 1, 2, 3]);
            $default = CatalogRows::nullableText($row, 4, self::COLUMNS);
            [$extra, $charset, $collation, $generation] = array_map(static fn(int $i): string => CatalogRows::text($row, $i, self::COLUMNS), [5, 6, 7, 8]);
            $t = $c->table($table);
            if ($t === null) {
                continue;
            }
            $type = self::type($columnType, $charset, $collation);
            if ($type === null || $generation !== '') {
                $c->report('column', $table, $name, "type $columnType $charset $collation has no dbspec type");
                continue;
            }
            [$typ, $needsCheck] = $type;
            $column = ['name' => $name, 'type' => $typ, 'null' => $nullable === 'YES', 'identity' => false, 'default' => ''];
            $extra = trim($extra, " \t\n\r\v\f");
            if ($extra === 'auto_increment') {
                $column['identity'] = true;
            } elseif ($extra === 'DEFAULT_GENERATED' && $default !== null) {
                if (!self::now($default, $typ)) {
                    $c->report('column', $table, $name, "default $default is not a dbspec default");
                    continue;
                }
                $column['default'] = 'now';
            } elseif ($extra !== '') {
                $c->report('column', $table, $name, "extra $extra has no dbspec definition");
                continue;
            } elseif ($default !== null) {
                $column['default'] = self::defaultLiteral($default, $typ);
            }
            $column['type'] = $c->sharedType($column['type']);
            $t->columns[] = $column;
            $columns[$table][$name] = $column;
            if ($needsCheck !== '') {
                $pending[$table][$name] = $needsCheck;
            }
        }
        self::readIndexes($connection, $c);
        self::readForeignKeys($connection, $c);
        $checked = [];
        $clauses = [];
        foreach (CatalogRows::read($connection, self::CHECK_CLAUSES) as $row) {
            $clauses[CatalogRows::text($row, 0, self::CHECK_CLAUSES)] = CatalogRows::text($row, 1, self::CHECK_CLAUSES);
        }
        $shown = [];
        foreach (CatalogRows::read($connection, self::CHECKS) as $row) {
            [$table, $name, $enforced] = array_map(static fn(int $i): string => CatalogRows::text($row, $i, self::CHECKS), [0, 1, 2]);
            $clause = $clauses[$name] ?? throw new \RuntimeException("check $table.$name has no CHECK_CLAUSE");
            if (self::hasNonAscii($clause)) {
                $clause = self::shownCheck($connection, $table, $name, $shown);
            }
            $t = $c->table($table);
            if ($t === null) {
                continue;
            }
            if ($enforced !== 'YES') {
                $c->report('check', $table, $name, 'the check is not enforced');
                continue;
            }
            if (str_contains($name, '$')) {
                [$owner, $column] = explode('$', $name, 2);
                $known = $columns[$table][$column] ?? null;
                if ($owner !== $table || $known === null || self::withoutIntroducers($clause) !== self::withoutIntroducers(self::rendererCheck($known))) {
                    $c->report('check', $table, $name, "the check $clause is not the renderer CHECK");
                    continue;
                }
                $checked[$table][$column] = true;
                continue;
            }
            try {
                $t->checks[] = ['name' => $name, 'predicate' => CheckDecoder::decode('mysql', $clause, $t->columnTypes())];
            } catch (CheckDecodeFailure $e) {
                $c->report('check', $table, $name, $e->getMessage());
            }
        }
        // renderer CHECK 이 있어야 하는 type 은 그 CHECK 이 없으면 dbspec type 이 아니다.
        foreach ($pending as $table => $cols) {
            foreach ($cols as $column => $need) {
                if (!isset($checked[$table][$column])) {
                    $c->report('column', (string) $table, (string) $column, "$need without its renderer CHECK has no dbspec type");
                    $c->table((string) $table)->dropColumn((string) $column);
                }
            }
        }
        self::readTriggers($connection, $c);
        foreach (['routine' => self::ROUTINES, 'event' => self::EVENTS] as $kind => $query) {
            foreach (CatalogRows::read($connection, $query) as $row) {
                $c->report($kind, '', CatalogRows::text($row, 0, $query), "a $kind has no dbspec definition");
            }
        }
        return $c;
    }

    /**
     * COLUMN_TYPE 과 character set, collation 을 dbspec type 으로 읽는다. 두 번째
     * 값은 renderer CHECK 이 있어야 그 type 이 되는 경우의 catalog type 이다.
     *
     * @return ?array{0: ColumnType, 1: string}
     */
    private static function type(string $columnType, string $charset, string $collation): ?array
    {
        if (!preg_match(self::TYPE, $columnType, $m)) {
            return null;
        }
        $g = static fn(int $i): string => $m[$i] ?? '';
        $text = $charset === 'utf8mb4' && $collation === 'utf8mb4_0900_bin';
        if ($g(3) === 'decimal') {
            return $charset === '' ? [new ColumnType('decimal', [(int) $g(4), (int) $g(5)]), ''] : null;
        }
        if ($g(6) === 'varchar') {
            return $text ? [new ColumnType('varchar', [(int) $g(7)]), ''] : null;
        }
        $precision = $g(2) === '' ? 0 : (int) $g(2);
        [$type, $needsCheck, $ok] = match ($g(1)) {
            'smallint' => [new ColumnType('i16'), '', $g(2) === ''],
            'int' => [new ColumnType('i32'), '', $g(2) === ''],
            'bigint' => [new ColumnType('i64'), '', $g(2) === ''],
            'tinyint(1)' => [new ColumnType('bool'), $columnType, true],
            'double' => [new ColumnType('f64'), '', $g(2) === ''],
            'longtext' => [new ColumnType('text'), '', $text],
            'longblob' => [new ColumnType('bytes'), '', true],
            'char(36)' => [new ColumnType('uuid'), $columnType, $charset === 'ascii' && $collation === 'ascii_bin'],
            'date' => [new ColumnType('date'), '', $g(2) === ''],
            'time' => [new ColumnType('time', [$precision]), $columnType, true],
            'datetime' => [new ColumnType('datetime', [$precision]), '', true],
        };
        return $ok ? [$type, $needsCheck] : null;
    }

    /**
     * character set introducer 를 뺀 CHECK_CLAUSE 다. ALTER TABLE 은 CHECK_CLAUSE 를 다시
     * 쓰며 introducer 를 바꾸거나 빼므로(probe mysql.check.alter_rewrites_introducers)
     * renderer CHECK 은 introducer 없이 비교한다. 이 template 의 literal 은 ASCII 이므로
     * 의미가 같다.
     */
    private static function withoutIntroducers(string $clause): string
    {
        // ALTER TABLE 은 time(p) column 과 만나는 time literal 에 0 으로 된 p 자리 소수도
        // 붙이므로(probe mysql.check.alter_writes_time_precision) 그 소수도 뺀다.
        $clause = preg_replace("/_[a-z0-9]+\\\\'/", "\\'", $clause) ?? throw new \RuntimeException('introducer pattern failed');
        return preg_replace("/\\\\'(\\d\\d:\\d\\d:\\d\\d)\\.0+\\\\'/", "\\'\$1\\'", $clause) ?? throw new \RuntimeException('time fraction pattern failed');
    }

    /** CHECK_CLAUSE 가 0x80 이상의 byte 를 가지면 true 다. MySQL 8.4 는 non-ASCII literal 을 두 번 인코딩해 보여 준다. */
    private static function hasNonAscii(string $clause): bool
    {
        return preg_match('/[\x80-\xff]/', $clause) === 1;
    }

    /**
     * CHECK_CLAUSE 가 non-ASCII 를 깨뜨린 check 의 본문을 SHOW CREATE TABLE 에서 읽고, CHECK_CLAUSE
     * 형식으로 다시 escape 한다. information_schema 는 utf8 bytes 를 한 번 더 인코딩해 보여 주지만
     * SHOW CREATE TABLE 은 바르게 쓰며, 본문의 literal 은 `\` 와 `'` 를 한 번만 escape 한다.
     * table 별로 SHOW CREATE TABLE 을 한 번만 읽고, $shown 에 table 마다 모은다.
     *
     * @param array<string, array<string, string>> $shown
     */
    private static function shownCheck(\PDO $connection, string $table, string $name, array &$shown): string
    {
        if (!isset($shown[$table])) {
            $query = 'SHOW CREATE TABLE `' . str_replace('`', '``', $table) . '`';
            $rows = CatalogRows::read($connection, $query);
            $create = CatalogRows::text($rows[0] ?? throw new \RuntimeException("SHOW CREATE TABLE $table returned no row"), 1, $query);
            $shown[$table] = self::createChecks($create);
        }
        return $shown[$table][$name] ?? throw new \RuntimeException("check $table.$name has no CHECK in SHOW CREATE TABLE");
    }

    /**
     * SHOW CREATE TABLE 문장의 모든 CHECK 본문을 이름별로 CHECK_CLAUSE 형식으로 돌려준다.
     *
     * @return array<string, string>
     */
    private static function createChecks(string $create): array
    {
        $checks = [];
        $length = strlen($create);
        for ($at = strpos($create, 'CONSTRAINT `'); $at !== false; $at = strpos($create, 'CONSTRAINT `', $at + 1)) {
            $close = strpos($create, '` CHECK (', $at);
            if ($close === false) {
                break;
            }
            $name = substr($create, $at + 12, $close - ($at + 12));
            $start = $close + 9;
            $depth = 1;
            for ($i = $start; $i < $length; $i++) {
                $c = $create[$i];
                if ($c === "'") {
                    for ($i++; $i < $length && $create[$i] !== "'"; $i++) {
                        if ($create[$i] === '\\') {
                            $i++;
                        }
                    }
                } elseif ($c === '(') {
                    $depth++;
                } elseif ($c === ')' && --$depth === 0) {
                    $checks[$name] = str_replace(["\\", "'"], ["\\\\", "\\'"], substr($create, $start, $i - $start));
                    break;
                }
            }
        }
        return $checks;
    }

    /** renderer CHECK 이 CHECK_CLAUSE 에 남는 형식 (docs/dialects.md "Introspection", "Checks"). */
    private static function rendererCheck(array $column): string
    {
        $c = "`{$column['name']}`";
        return match ($column['type']->name) {
            'bool' => "($c in (0,1))",
            'uuid' => "regexp_like($c,_utf8mb4\\'" . Renderer::UUID_PATTERN . "\\',_utf8mb4\\'c\\')",
            'time' => "(($c >= _utf8mb4\\'00:00:00\\') and ($c < _utf8mb4\\'24:00:00\\'))",
            default => '',
        };
    }

    /** DEFAULT_GENERATED default 가 그 column 의 renderer 시각 default 인지 알려 준다. */
    private static function now(string $text, ColumnType $type): bool
    {
        if ($type->name !== 'datetime') {
            return false;
        }
        $p = $type->parameters[0];
        return $text === ($p === 0 ? 'CURRENT_TIMESTAMP' : "CURRENT_TIMESTAMP($p)");
    }

    /** escape 를 푼 COLUMN_DEFAULT 값을 dbspec literal 로 쓴다. parse 가 canonical form 과 유효성을 정한다. */
    private static function defaultLiteral(string $value, ColumnType $type): string
    {
        if ($type->name === 'bool' && ($value === '1' || $value === '0')) {
            return $value === '1' ? 'true' : 'false';
        }
        if (in_array($type->name, ['i16', 'i32', 'i64', 'decimal', 'f64'], true)) {
            return $value;
        }
        return Literal::quote($value);
    }

    private static function readIndexes(\PDO $connection, Catalog $c): void
    {
        $q = self::INDEXES;
        $rows = [];
        foreach (CatalogRows::read($connection, $q) as $row) {
            $rows[] = [
                'table' => CatalogRows::text($row, 0, $q), 'name' => CatalogRows::text($row, 1, $q),
                'unique' => CatalogRows::integer($row, 2, $q) === 0, 'column' => CatalogRows::text($row, 3, $q),
                'collation' => CatalogRows::text($row, 4, $q), 'part' => CatalogRows::flag($row, 5, $q),
                'expression' => CatalogRows::flag($row, 6, $q), 'kind' => CatalogRows::text($row, 7, $q),
            ];
        }
        $n = count($rows);
        for ($i = 0; $i < $n;) {
            $j = $i;
            while ($j < $n && $rows[$j]['table'] === $rows[$i]['table'] && $rows[$j]['name'] === $rows[$i]['name']) {
                $j++;
            }
            $group = array_slice($rows, $i, $j - $i);
            $i = $j;
            $t = $c->table($group[0]['table']);
            if ($t === null) {
                continue;
            }
            $key = ['name' => $group[0]['name'], 'columns' => [], 'desc' => []];
            $supported = $group[0]['kind'] === 'BTREE';
            foreach ($group as $x) {
                if ($x['part'] || $x['expression'] || $x['column'] === '') {
                    $supported = false;
                }
                $key['columns'][] = $x['column'];
                $key['desc'][] = $x['collation'] === 'D';
            }
            if (!$supported) {
                $c->report('index', $t->name, $key['name'], 'a prefix, expression or ' . strtolower($group[0]['kind']) . ' index has no dbspec definition');
            } elseif ($key['name'] === 'PRIMARY') {
                $t->primary = $key['columns'];
            } elseif (str_contains($key['name'], '$')) {
                $c->report('index', $t->name, $key['name'], 'the name contains $');
            } elseif ($group[0]['unique']) {
                $t->uniques[] = $key;
            } else {
                $t->indexes[] = $key;
            }
        }
    }

    /**
     * foreign key 마다 column row 를 모은다. 지원하지 않는 key 는 Go reference 와
     * 같게 column row 마다 보고된다.
     */
    private static function readForeignKeys(\PDO $connection, Catalog $c): void
    {
        $q = self::FOREIGN_KEYS;
        $current = null;
        $currentTable = null;
        // 보고한 key 의 나머지 column row 는 건너뛴다.
        $skipped = '';
        $flush = static function () use (&$current, &$currentTable): void {
            if ($current !== null && $currentTable !== null) {
                $currentTable->foreignKeys[] = $current;
            }
            $current = null;
            $currentTable = null;
        };
        foreach (CatalogRows::read($connection, $q) as $row) {
            [$table, $name, $refTable, $onDelete, $onUpdate, $match, $column, $refColumn] = array_map(static fn(int $i): string => CatalogRows::text($row, $i, $q), range(0, 7));
            if ($current !== null && ($current['name'] !== $name || $currentTable->name !== $table)) {
                $flush();
            }
            if ($skipped === "$table\0$name") {
                continue;
            }
            $skipped = '';
            if ($current === null) {
                $t = $c->table($table);
                $delete = Catalog::actionName($onDelete);
                $update = Catalog::actionName($onUpdate);
                if ($t === null) {
                    continue;
                }
                if ($delete === null || $update === null || $match !== 'NONE') {
                    $c->report('foreign_key', $table, $name, "actions $onDelete, $onUpdate or match $match have no dbspec definition");
                    $skipped = "$table\0$name";
                    continue;
                }
                $current = ['name' => $name, 'columns' => [], 'table' => $refTable, 'refs' => [], 'onDelete' => $delete, 'onUpdate' => $update];
                $currentTable = $t;
            }
            $current['columns'][] = $column;
            $current['refs'][] = $refColumn;
        }
        $flush();
    }

    /** trigger 를 renderer statement 형식으로 다시 쓰고 알아본다. */
    private static function readTriggers(\PDO $connection, Catalog $c): void
    {
        $q = self::TRIGGERS;
        $triggers = [];
        foreach (CatalogRows::read($connection, $q) as $row) {
            [$table, $name, $timing, $event, $statement] = array_map(static fn(int $i): string => CatalogRows::text($row, $i, $q), range(0, 4));
            $triggers[$table][] = ['name' => $name, 'statements' => ["CREATE TRIGGER `$name` $timing $event ON `$table` FOR EACH ROW $statement"]];
        }
        CatalogTriggers::recognize($c, 'mysql', $triggers);
    }
}
