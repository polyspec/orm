<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * Writes the statements that create the tables of a document set in one
 * dialect (docs/dialects.md "Rendered statements").
 *
 * @internal
 */
final class Renderer
{
    public const DIALECTS = ['mysql', 'postgres', 'sqlite'];
    public const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    private const COMPARISONS = ['=' => true, '<>' => true, '<' => true, '<=' => true, '>' => true, '>=' => true];
    private const KEYWORDS = ['and' => true, 'or' => true, 'not' => true, 'in' => true, 'between' => true, 'is' => true, 'null' => true, 'true' => true, 'false' => true];

    /** @var list<string> 읽고 있는 check 의 토큰; 위치, 테이블과 check 이름이 함께 간다. */
    private array $tokens = [];
    private int $at = 0;
    private ?Table $table = null;
    private string $checkName = '';

    /** The dialect is one of DIALECTS; another is an InvalidArgumentException. */
    public function __construct(public readonly string $dialect)
    {
        if (!in_array($dialect, self::DIALECTS, true)) {
            throw new \InvalidArgumentException("Unknown dialect `$dialect`; the dialects are mysql, postgres and sqlite");
        }
    }

    /**
     * The documents are a set that DocumentSet::check accepts and the dialect
     * is one of DIALECTS.
     *
     * @param list<Document> $documents
     * @return list<string>
     */
    public static function render(array $documents, string $dialect): array
    {
        $r = new self($dialect);
        // 외부 문서의 table은 그 문서를 소유한 set이 만든다.
        $ordered = array_values(array_filter(self::useOrder($documents), static fn(Document $d): bool => !$d->external));
        $out = [];
        foreach ($ordered as $document) {
            foreach ($document->tables as $table) {
                array_push($out, ...$r->table($table));
            }
        }
        if ($dialect !== 'sqlite') {
            foreach ($ordered as $document) {
                foreach ($document->tables as $table) {
                    foreach (self::byName($table->foreignKeys) as $foreignKey) {
                        $out[] = 'ALTER TABLE ' . $r->q($table->name) . ' ADD ' . $r->foreignKey($foreignKey);
                    }
                }
            }
        }
        foreach ($ordered as $document) {
            foreach ($document->tables as $table) {
                array_push($out, ...$r->triggers($table));
            }
        }
        return $out;
    }

    /** table 의 immutable 과 audit trigger statement; introspection 이 catalog trigger 와 비교한다. @return list<string> */
    public static function tableTriggers(Table $t, string $dialect): array
    {
        return (new self($dialect))->triggers($t);
    }

    /** column 의 renderer CHECK 식, 없으면 ""; introspection 이 catalog CHECK 와 비교한다. */
    public static function columnCheck(Column $c, string $dialect): string
    {
        return (new self($dialect))->typeCheck($c);
    }

    /** column type 의 default 를 dialect 형태로 쓴다; introspection 이 catalog default 와 비교한다. */
    public static function columnDefault(ColumnType $t, string $default, string $dialect): string
    {
        return (new self($dialect))->defaultText($t, $default);
    }

    /**
     * 사용되는 문서가 그것을 사용하는 문서보다 먼저, 같은 순위는 문서 이름 순.
     *
     * @param list<Document> $documents
     * @return list<Document>
     */
    private static function useOrder(array $documents): array
    {
        $byName = [];
        foreach ($documents as $document) {
            $byName[$document->name] = $document;
        }
        $names = array_keys($byName);
        usort($names, static fn($a, $b): int => strcmp((string) $a, (string) $b));
        $out = [];
        $done = [];
        $visit = static function (string $name) use (&$visit, &$out, &$done, $byName): void {
            if (isset($done[$name])) {
                return;
            }
            $done[$name] = true;
            $used = array_map(static fn(UseLine $u): string => $u->document, $byName[$name]->uses);
            usort($used, strcmp(...));
            foreach ($used as $u) {
                $visit($u);
            }
            $out[] = $byName[$name];
        };
        foreach ($names as $name) {
            $visit((string) $name);
        }
        return $out;
    }

    /**
     * @template T of object
     * @param list<T> $items items with a `name`
     * @return list<T>
     */
    private static function byName(array $items): array
    {
        usort($items, static fn(object $a, object $b): int => strcmp($a->name, $b->name));
        return $items;
    }

    /** 식별자를 인용한다. */
    public function q(string $name): string
    {
        return $this->dialect === 'mysql' ? "`$name`" : "\"$name\"";
    }

    /** @param list<string> $names */
    public function list(array $names): string
    {
        return implode(', ', array_map($this->q(...), $names));
    }

    /** @return list<string> */
    public function table(Table $t): array
    {
        $create = $this->createTable($t, $t->name, static fn(string $column): string => $t->name . '$' . $column, []);
        $out = [$create];
        if ($this->dialect === 'sqlite') {
            foreach (self::byName($t->uniqueKeys) as $unique) {
                $out[] = 'CREATE UNIQUE INDEX ' . $this->q($unique->name) . ' ON ' . $this->q($t->name) . ' (' . $this->list($unique->columns) . ')';
            }
        }
        foreach (self::byName($t->indexes) as $index) {
            $columns = array_map(fn(IndexColumn $c): string => $this->q($c->name) . ($c->descending ? ' DESC' : ''), $index->columns);
            $out[] = 'CREATE INDEX ' . $this->q($index->name) . ' ON ' . $this->q($t->name) . ' (' . implode(', ', $columns) . ')';
        }
        return $out;
    }

    /**
     * table t 를 name 으로 만드는 CREATE TABLE 이다. checkName 은 column 의 renderer
     * CHECK 이름이고, hidden 은 t 의 column 뒤에 nullable 이며 CHECK 없이 더하는
     * column 이다(docs/plans.md "Steps"의 SQLite 다시 만들기).
     *
     * @param \Closure(string): string $checkName
     * @param list<Column> $hidden
     */
    public function createTable(Table $t, string $name, \Closure $checkName, array $hidden): string
    {
        $parts = [];
        $identity = false;
        foreach ($t->columns as $column) {
            $parts[] = $this->column($column);
            $identity = $identity || $column->identity;
        }
        foreach ($hidden as $column) {
            $parts[] = $this->column(new Column($column->name, $column->type, true, false, $column->default));
        }
        if ($t->primaryKey === null) {
            throw new \InvalidArgumentException("Table {$t->name} has no primary key");
        }
        if (!($this->dialect === 'sqlite' && $identity)) {
            $parts[] = 'PRIMARY KEY (' . $this->list($t->primaryKey->columns) . ')';
        }
        if ($this->dialect !== 'sqlite') {
            foreach (self::byName($t->uniqueKeys) as $unique) {
                $parts[] = 'CONSTRAINT ' . $this->q($unique->name) . ' UNIQUE (' . $this->list($unique->columns) . ')';
            }
        } else {
            foreach (self::byName($t->foreignKeys) as $foreignKey) {
                $parts[] = $this->foreignKey($foreignKey);
            }
        }
        foreach ($t->columns as $column) {
            $check = $this->typeCheck($column);
            if ($check !== '') {
                $parts[] = 'CONSTRAINT ' . $this->q($checkName($column->name)) . " CHECK ($check)";
            }
        }
        foreach (self::byName($t->checks) as $check) {
            $parts[] = 'CONSTRAINT ' . $this->q($check->name) . ' CHECK (' . $this->checkText($t, $check) . ')';
        }
        $create = 'CREATE TABLE ' . $this->q($name) . ' (' . implode(', ', $parts) . ')';
        if ($this->dialect === 'mysql') {
            $create .= ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin';
        }
        return $create;
    }

    public function column(Column $c): string
    {
        if ($c->identity) {
            return $this->q($c->name) . match ($this->dialect) {
                'mysql' => ' BIGINT NOT NULL AUTO_INCREMENT',
                'postgres' => ' bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL',
                'sqlite' => ' INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT',
            };
        }
        $s = $this->q($c->name) . ' ' . $this->typeText($c->type) . ($c->nullable ? ' NULL' : ' NOT NULL');
        if ($c->default !== null) {
            $s .= ' DEFAULT ' . $this->defaultText($c->type, $c->default);
        }
        return $s;
    }

    public function typeText(ColumnType $t): string
    {
        $p = $t->parameters;
        $text = match ($this->dialect) {
            'mysql' => match ($t->name) {
                'i16' => 'SMALLINT',
                'i32' => 'INT',
                'i64' => 'BIGINT',
                'bool' => 'tinyint(1)',
                'decimal' => "DECIMAL($p[0],$p[1])",
                'f64' => 'DOUBLE',
                'varchar' => "varchar($p[0]) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin",
                'text' => 'LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin',
                'bytes' => 'LONGBLOB',
                'uuid' => 'char(36) CHARACTER SET ascii COLLATE ascii_bin',
                'date' => 'DATE',
                'time' => "TIME($p[0])",
                'datetime' => "DATETIME($p[0])",
                default => null,
            },
            'postgres' => match ($t->name) {
                'i16' => 'smallint',
                'i32' => 'integer',
                'i64' => 'bigint',
                'bool' => 'boolean',
                'decimal' => "numeric($p[0],$p[1])",
                'f64' => 'double precision',
                'varchar' => "varchar($p[0]) COLLATE \"C\"",
                'text' => 'text COLLATE "C"',
                'bytes' => 'bytea',
                'uuid' => 'uuid',
                'date' => 'date',
                'time' => "time($p[0])",
                'datetime' => "timestamp($p[0])",
                default => null,
            },
            'sqlite' => match ($t->name) {
                'i16' => 'smallint',
                'i32' => 'integer',
                'i64' => 'bigint',
                'bool' => 'BOOLEAN',
                'decimal' => "DECIMALINT($p[0],$p[1])",
                'f64' => 'REAL',
                'varchar' => "varchar($p[0])",
                'text', 'uuid' => 'TEXT',
                'bytes' => 'BLOB',
                'date' => 'DATE',
                'time' => 'TIME',
                'datetime' => 'DATETIME',
                default => null,
            },
        };
        return $text ?? throw new \InvalidArgumentException("Unknown column type {$t->text()}");
    }

    public function defaultText(ColumnType $t, string $default): string
    {
        if ($default !== 'now') {
            return $this->literal($t, $default);
        }
        $p = $t->parameters[0];
        return match (true) {
            $this->dialect === 'mysql' => "CURRENT_TIMESTAMP($p)",
            $this->dialect === 'postgres' => 'statement_timestamp()',
            $p === 0 => "(strftime('%Y-%m-%d %H:%M:%S', 'now'))",
            $p <= 3 => "(substr(strftime('%Y-%m-%d %H:%M:%f', 'now'), 1, " . (20 + $p) . '))',
            default => "(strftime('%Y-%m-%d %H:%M:%f', 'now') || '" . str_repeat('0', $p - 3) . "')",
        };
    }

    /** 컬럼 타입 $t 의 정규 literal 을 dialect 형태로 쓴다. */
    private function literal(ColumnType $t, string $text): string
    {
        if ($text === 'true' || $text === 'false') {
            if ($this->dialect === 'postgres') {
                return strtoupper($text);
            }
            return $text === 'true' ? '1' : '0';
        }
        if (str_starts_with($text, "'")) {
            return $this->dialect === 'mysql' ? str_replace('\\', '\\\\', $text) : $text;
        }
        if ($t->name === 'decimal' && $this->dialect === 'sqlite') {
            return self::scaledDecimal($text);
        }
        return $text;
    }

    /** 정규 decimal literal × 10^scale: 소수점과 앞의 0 을 뺀 숫자. */
    private static function scaledDecimal(string $text): string
    {
        $negative = str_starts_with($text, '-');
        $digits = ltrim(str_replace('.', '', ltrim($text, '-')), '0');
        if ($digits === '') {
            return '0';
        }
        return ($negative ? '-' : '') . $digits;
    }

    public function foreignKey(ForeignKey $f): string
    {
        return 'CONSTRAINT ' . $this->q($f->name) . ' FOREIGN KEY (' . $this->list($f->columns) . ') REFERENCES ' . $this->q($f->table)
            . ' (' . $this->list($f->referencedColumns) . ') ON DELETE ' . self::action($f->onDelete) . ' ON UPDATE ' . self::action($f->onUpdate);
    }

    private static function action(string $action): string
    {
        return match ($action) {
            'restrict' => 'RESTRICT',
            'cascade' => 'CASCADE',
            'set_null' => 'SET NULL',
            default => throw new \InvalidArgumentException("Unknown foreign key action `$action`"),
        };
    }

    /** 컬럼의 renderer CHECK, dialect 가 타입을 직접 지키면 "". */
    public function typeCheck(Column $c): string
    {
        if ($c->identity) {
            return '';
        }
        $q = $this->q($c->name);
        $t = $c->type;
        if ($this->dialect === 'mysql') {
            return match ($t->name) {
                'bool' => "$q IN (0, 1)",
                'uuid' => "REGEXP_LIKE($q, '" . self::UUID_PATTERN . "', 'c')",
                'time' => "$q >= '00:00:00' AND $q < '24:00:00'",
                default => '',
            };
        }
        if ($this->dialect === 'postgres') {
            return $t->name === 'time' ? "$q < '24:00:00'" : '';
        }
        $integer = "typeof($q) IN ('integer', 'null')";
        $digits = static fn(int $n): string => str_repeat('[0-9]', $n);
        switch ($t->name) {
            case 'i16':
                return "$integer AND $q BETWEEN -32768 AND 32767";
            case 'i32':
                return "$integer AND $q BETWEEN -2147483648 AND 2147483647";
            case 'i64':
                return $integer;
            case 'bool':
                return "$q IN (0, 1)";
            case 'decimal':
                $limit = str_repeat('9', $t->parameters[0]);
                return "$integer AND $q BETWEEN -$limit AND $limit";
            case 'f64':
                return "typeof($q) IN ('real', 'null')";
            case 'varchar':
                return "length($q) <= {$t->parameters[0]}";
            case 'uuid':
                $hex = static fn(int $n): string => str_repeat('[0-9a-f]', $n);
                return "$q GLOB '" . $hex(8) . '-' . $hex(4) . '-' . $hex(4) . '-' . $hex(4) . '-' . $hex(12) . "'";
            case 'date':
                return "$q IS date($q)";
            case 'time':
                $p = $t->parameters[0];
                if ($p === 0) {
                    return "$q IS time($q) AND $q < '24:00:00'";
                }
                $clock = "substr($q, 1, 8)";
                return "length($q) = " . (9 + $p) . " AND $clock IS time($clock) AND $clock < '24:00:00' AND substr($q, 9, 1) = '.' AND substr($q, 10) GLOB '" . $digits($p) . "'";
            case 'datetime':
                $p = $t->parameters[0];
                if ($p === 0) {
                    return "length($q) = 19 AND $q IS datetime($q) AND substr($q, 12, 2) < '24'";
                }
                $stamp = "substr($q, 1, 19)";
                return "length($q) = " . (20 + $p) . " AND $stamp IS datetime($stamp) AND substr($q, 12, 2) < '24' AND substr($q, 20, 1) = '.' AND substr($q, 21) GLOB '" . $digits($p) . "'";
        }
        return '';
    }

    /**
     * 정규 check 텍스트를 dialect 형태로 쓴다: 컬럼은 인용하고, 키워드는 대문자로,
     * literal 은 그것이 만나는 컬럼의 타입으로 쓴다. 정규 텍스트의 간격과
     * 괄호는 (and 안의 or 만 묶는다) 렌더링된 텍스트의 간격, 괄호와 같다.
     */
    public function checkText(Table $t, Check $check): string
    {
        $this->table = $t;
        $this->checkName = $check->name;
        $this->at = 0;
        $pattern = "/\\G(?:'(?:[^']|'')*'|<>|<=|>=|[=<>(),]|-?[0-9]+(?:\\.[0-9]+)?(?![A-Za-z0-9_])|[A-Za-z0-9_]+)/";
        $this->tokens = [];
        $offset = 0;
        $length = strlen($check->expression);
        while ($offset < $length) {
            if ($check->expression[$offset] === ' ') {
                $offset++;
                continue;
            }
            if (!preg_match($pattern, $check->expression, $m, 0, $offset)) {
                $this->invalid("unexpected text at byte $offset");
            }
            $this->tokens[] = $m[0];
            $offset += strlen($m[0]);
        }
        $text = $this->disjunction();
        if ($this->at < count($this->tokens)) {
            $this->invalid("unexpected `{$this->tokens[$this->at]}`");
        }
        return $text;
    }

    private function invalid(string $problem): never
    {
        throw new \InvalidArgumentException("Table {$this->table?->name} check {$this->checkName} is not a canonical predicate: $problem");
    }

    private function peek(int $ahead = 0): ?string
    {
        return $this->tokens[$this->at + $ahead] ?? null;
    }

    private function expect(string $token): void
    {
        if ($this->peek() !== $token) {
            $this->invalid("expected `$token`, found `" . ($this->peek() ?? 'the end') . '`');
        }
        $this->at++;
    }

    private function disjunction(): string
    {
        $text = $this->conjunction();
        while ($this->peek() === 'or') {
            $this->at++;
            $text .= ' OR ' . $this->conjunction();
        }
        return $text;
    }

    private function conjunction(): string
    {
        $text = $this->group();
        while ($this->peek() === 'and') {
            $this->at++;
            $text .= ' AND ' . $this->group();
        }
        return $text;
    }

    private function group(): string
    {
        if ($this->peek() === '(') {
            $this->at++;
            $text = '(' . $this->disjunction() . ')';
            $this->expect(')');
            return $text;
        }
        return $this->predicate();
    }

    private function predicate(): string
    {
        $left = $this->operand();
        $next = $this->peek();
        if ($next !== null && isset(self::COMPARISONS[$next])) {
            $this->at++;
            $right = $this->operand();
            $type = $this->operandType($left, $right);
            return $this->operandText($type, $left) . " $next " . $this->operandText($type, $right);
        }
        $negated = $next === 'not' && $this->peek(1) === 'in';
        if ($negated) {
            $this->at++;
            $next = $this->peek();
        }
        if ($next === 'in') {
            $type = $this->operandType($left, null);
            $this->at++;
            $this->expect('(');
            $list = [$this->operandText($type, $this->checkLiteral())];
            while ($this->peek() === ',') {
                $this->at++;
                $list[] = $this->operandText($type, $this->checkLiteral());
            }
            $this->expect(')');
            return $this->operandText($type, $left) . ($negated ? ' NOT' : '') . ' IN (' . implode(', ', $list) . ')';
        }
        if ($next === 'is') {
            $this->at++;
            $isNot = $this->peek() === 'not';
            if ($isNot) {
                $this->at++;
            }
            $this->expect('null');
            return $this->operandText(null, $left) . ($isNot ? ' IS NOT NULL' : ' IS NULL');
        }
        $this->invalid('`' . ($left[0] === 'column' ? $left[1]->name : $left[1]) . '` alone is not a predicate');
    }

    /** 테이블의 컬럼, 또는 literal: ['column', Column] 또는 ['literal', text]. */
    private function operand(): array
    {
        $token = $this->peek();
        if ($token !== null && preg_match('/^[A-Za-z0-9_]+$/D', $token) && !ctype_digit($token) && !isset(self::KEYWORDS[$token])) {
            $this->at++;
            return ['column', $this->findColumn($token) ?? $this->invalid("`$token` is not a column of the table")];
        }
        return $this->checkLiteral();
    }

    private function checkLiteral(): array
    {
        $token = $this->peek();
        if ($token === null || ($token !== 'true' && $token !== 'false' && Literal::number($token) === null && Literal::stringValue($token) === null)) {
            $this->invalid('expected a literal, found `' . ($token ?? 'the end') . '`');
        }
        $this->at++;
        return ['literal', $token];
    }

    private function findColumn(string $name): ?Column
    {
        foreach ($this->table->columns as $column) {
            if ($column->name === $name) {
                return $column;
            }
        }
        return null;
    }

    /** 피연산자 중 컬럼의 타입; 검증이 적어도 하나를 컬럼으로 만들었다. */
    private function operandType(array $a, ?array $b): ColumnType
    {
        foreach ([$a, $b] as $operand) {
            if ($operand !== null && $operand[0] === 'column') {
                return $operand[1]->type;
            }
        }
        $this->invalid('a predicate has no column operand');
    }

    private function operandText(?ColumnType $type, array $operand): string
    {
        if ($operand[0] === 'column') {
            return $this->q($operand[1]->name);
        }
        return $this->literal($type ?? $this->invalid("literal `{$operand[1]}` meets no column"), $operand[1]);
    }

    /** immutable 과 audit 설정의 trigger. @return list<string> */
    public function triggers(Table $t): array
    {
        if ($t->settings === null) {
            return [];
        }
        $immutable = false;
        $audit = null;
        foreach ($t->settings->settings as $setting) {
            if ($setting->kind === 'immutable') {
                $immutable = true;
            } elseif ($setting->kind === 'audit') {
                $audit = $setting;
            }
        }
        $out = [];
        if ($immutable) {
            $message = "table {$t->name} is immutable";
            array_push($out, ...$this->reject($t, 'immutable_update', 'BEFORE UPDATE', $message));
            array_push($out, ...$this->reject($t, 'immutable_delete', 'BEFORE DELETE', $message));
        }
        if ($audit !== null) {
            $column = $audit->arguments[1];
            array_push($out, ...$this->history($t, $audit, 'audit_insert', 'AFTER INSERT', "'insert'", 'NULL'));
            array_push($out, ...$this->history($t, $audit, 'audit_update', 'AFTER UPDATE', "'update'", 'OLD.' . $this->q($column)));
            array_push($out, ...$this->reject($t, 'audit_delete', 'BEFORE DELETE', "table {$t->name} deletes through its soft delete column"));
        }
        return $out;
    }

    /**
     * <table>$<event> trigger 의 본문은 단일 statement 이다; PostgreSQL 은 같은 이름의 함수로 감싼다.
     *
     * @return list<string>
     */
    private function trigger(Table $t, string $event, string $timing, string $body, bool $rejects): array
    {
        $name = $this->q($t->name . '$' . $event);
        $on = " $timing ON " . $this->q($t->name) . ' FOR EACH ROW ';
        return match ($this->dialect) {
            'mysql' => ["CREATE TRIGGER $name$on$body"],
            'postgres' => [
                "CREATE FUNCTION $name() RETURNS trigger LANGUAGE plpgsql AS \$\$BEGIN $body; " . ($rejects ? '' : 'RETURN NULL; ') . 'END$$',
                "CREATE TRIGGER $name{$on}EXECUTE FUNCTION $name()",
            ],
            'sqlite' => ["CREATE TRIGGER $name{$on}BEGIN $body; END"],
        };
    }

    /** @return list<string> */
    private function reject(Table $t, string $event, string $timing, string $message): array
    {
        $body = match ($this->dialect) {
            'mysql' => "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '$message'",
            'postgres' => "RAISE EXCEPTION '$message'",
            'sqlite' => "SELECT RAISE(ABORT, '$message')",
        };
        return $this->trigger($t, $event, $timing, $body, true);
    }

    /** @return list<string> */
    private function history(Table $t, Setting $audit, string $event, string $timing, string $actionValue, string $previousValue): array
    {
        [$history, , , $action, $previous] = $audit->arguments;
        $columns = [$this->q($action), $this->q($previous)];
        $values = [$actionValue, $previousValue];
        foreach ($t->columns as $column) {
            if (!$audit->records($column->name)) {
                continue;
            }
            $columns[] = $this->q($column->name);
            $values[] = 'NEW.' . $this->q($column->name);
        }
        $body = 'INSERT INTO ' . $this->q($history) . ' (' . implode(', ', $columns) . ') VALUES (' . implode(', ', $values) . ')';
        return $this->trigger($t, $event, $timing, $body, false);
    }
}
