<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * dialect reader 가 채우는 중립 중간 model 이다. document() 가 그것을 dbspec
 * 문서로 만든다 (docs/dialects.md "Introspection").
 *
 * @internal
 */
final class Catalog
{
    /** @var list<CatalogTable> */
    public array $tables = [];
    /** @var list<Unsupported> */
    public array $unsupported = [];

    /** @var array<string, ColumnType> type text 마다 하나의 ColumnType */
    private array $types = [];

    /**
     * 같은 type 의 ColumnType 을 하나로 나눠 쓴다. ColumnType 은 readonly 이므로
     * 공유해도 안전하고, 2000 table 의 catalog 에서 수만 개의 객체를 줄인다.
     */
    public function sharedType(ColumnType $type): ColumnType
    {
        return $this->types[$type->text()] ??= $type;
    }

    public function report(string $kind, string $table, string $name, string $reason): void
    {
        $this->unsupported[] = new Unsupported($kind, $table, $name, $reason);
    }

    public function table(string $name): ?CatalogTable
    {
        foreach ($this->tables as $table) {
            if ($table->name === $name) {
                return $table;
            }
        }
        return null;
    }

    /**
     * 중간 model 을 dbspec text 로 쓰고 parse 한다. parse 가 어떤 줄을 거부하면
     * 그 줄의 객체를 미지원으로 보고하고 빼서 다시 만든다. 빠진 객체를 참조하던
     * 객체는 다음 parse 에서 거부되므로 같은 방식으로 빠진다. 객체에 속하지 않는
     * 줄의 diagnostic 은 reader 의 결함이므로 error 다.
     */
    public function document(string $name): IntrospectResult
    {
        $this->dropTablesWithoutKey();
        while (true) {
            [$text, $objects] = $this->text($name);
            $result = Dbspec::parse($text, []);
            if ($result->document !== null) {
                $unsupported = $this->unsupported;
                usort($unsupported, static fn(Unsupported $a, Unsupported $b): int => strcmp("{$a->table}\0{$a->kind}\0{$a->name}", "{$b->table}\0{$b->kind}\0{$b->name}"));
                return new IntrospectResult($result->document, $unsupported);
            }
            // 거부된 table 의 객체는 table 과 함께 빠지므로 따로 보고하지 않는다.
            $rejected = [];
            foreach ($result->diagnostics as $d) {
                $packed = $objects[$d->line] ?? null;
                if ($packed === null) {
                    $found = implode("\n", array_map(static fn(Diagnostic $x): string => "{$x->line}:{$x->column} {$x->rule} {$x->message}", $result->diagnostics));
                    throw new \RuntimeException("Introspected document does not parse:\n$found\n$text");
                }
                $object = explode("\0", $packed);
                if ($object[0] === 'table') {
                    $rejected[$object[1]] = true;
                }
            }
            $removed = [];
            foreach ($result->diagnostics as $d) {
                $object = explode("\0", $objects[$d->line]);
                if ($object[0] !== 'table' && isset($rejected[$object[1]])) {
                    continue;
                }
                $key = implode("\0", $object);
                if (!isset($removed[$key])) {
                    $removed[$key] = true;
                    $this->report($object[0], $object[1], $object[2], "{$d->rule}: {$d->message}");
                    $this->remove($object);
                }
            }
        }
    }

    /**
     * 객체 하나를 뺀다. table 이나 primary key 를 빼면 table 전체가 빠진다.
     *
     * @param array{0: string, 1: string, 2: string} $object kind, table, name
     */
    private function remove(array $object): void
    {
        [$kind, $tableName, $name] = $object;
        $t = $this->table($tableName);
        $without = static fn(array $items): array => array_values(array_filter($items, static fn(array $x): bool => $x['name'] !== $name));
        match ($kind) {
            'table' => $this->tables = array_values(array_filter($this->tables, static fn(CatalogTable $x): bool => $x !== $t)),
            'column' => $t->columns = $without($t->columns),
            'unique' => $t->uniques = $without($t->uniques),
            'index' => $t->indexes = $without($t->indexes),
            'foreign_key' => $t->foreignKeys = $without($t->foreignKeys),
            'check' => $t->checks = $without($t->checks),
            'trigger' => $t->settings = array_values(array_filter($t->settings, static fn(string $s): bool => self::firstWord($s) !== $name)),
        };
    }

    /** primary key 가 없는 table 을 뺀다. 그 table 을 참조하던 foreign key 는 parse 가 거부해 빠진다. */
    private function dropTablesWithoutKey(): void
    {
        $kept = [];
        foreach ($this->tables as $t) {
            if ($t->primary === []) {
                $this->report('table', $t->name, $t->name, 'the table has no primary key');
                continue;
            }
            $kept[] = $t;
        }
        $this->tables = $kept;
    }

    /**
     * table 을 이름 순으로 쓴 dbspec text 와, 줄 번호마다 그 줄의 객체를
     * 돌려준다. 닫는 괄호와 primary key 줄은 table 에 속한다.
     *
     * @return array{0: string, 1: array<int, string>} text 와, 줄 번호마다 "kind\0table\0name"
     */
    private function text(string $name): array
    {
        $tables = $this->tables;
        usort($tables, static fn(CatalogTable $a, CatalogTable $b): int => strcmp($a->name, $b->name));
        $lines = ["dbspec 1 $name"];
        $objects = [];
        // 줄의 객체는 "kind\0table\0name" 문자열로 둔다. 배열보다 작아서 큰 catalog 의
        // 메모리를 줄인다.
        $add = static function (string $line, array $object) use (&$lines, &$objects): void {
            $lines[] = $line;
            $objects[count($lines)] = implode("\0", $object);
        };
        foreach ($tables as $t) {
            $table = ['table', $t->name, $t->name];
            $lines[] = '';
            $add("table {$t->name} {", $table);
            foreach ($t->columns as $c) {
                $s = "  {$c['name']} " . $c['type']->text();
                if ($c['null']) {
                    $s .= ' null';
                }
                if ($c['identity']) {
                    $s .= ' identity';
                }
                if ($c['default'] !== '') {
                    $s .= " default {$c['default']}";
                }
                $add($s, ['column', $t->name, $c['name']]);
            }
            $add('  primary key (' . implode(', ', $t->primary) . ')', $table);
            foreach ($t->uniques as $u) {
                $add("  unique {$u['name']} (" . implode(', ', $u['columns']) . ')', ['unique', $t->name, $u['name']]);
            }
            foreach ($t->indexes as $x) {
                $columns = [];
                foreach ($x['columns'] as $i => $column) {
                    $columns[] = $column . ($x['desc'][$i] ? ' desc' : '');
                }
                $add("  index {$x['name']} (" . implode(', ', $columns) . ')', ['index', $t->name, $x['name']]);
            }
            foreach ($t->foreignKeys as $f) {
                $add("  foreign key {$f['name']} (" . implode(', ', $f['columns']) . ") references {$f['table']} (" . implode(', ', $f['refs'])
                    . ") on delete {$f['onDelete']} on update {$f['onUpdate']}", ['foreign_key', $t->name, $f['name']]);
            }
            foreach ($t->checks as $k) {
                $add("  check {$k['name']} ({$k['predicate']})", ['check', $t->name, $k['name']]);
            }
            if ($t->settings !== []) {
                $add('  settings {', $table);
                foreach ($t->settings as $s) {
                    $add("    $s", ['trigger', $t->name, self::firstWord($s)]);
                }
                $add('  }', $table);
            }
            $add('}', $table);
        }
        return [implode("\n", $lines) . "\n", $objects];
    }

    private static function firstWord(string $line): string
    {
        return explode(' ', $line, 2)[0];
    }

    /** catalog 의 참조 action 을 dbspec action 으로 바꾼다. 없으면 null. */
    public static function actionName(string $rule): ?string
    {
        return match (strtoupper($rule)) {
            'RESTRICT' => 'restrict',
            'CASCADE' => 'cascade',
            'SET NULL' => 'set_null',
            default => null,
        };
    }

    /** renderer CHECK 의 이름 <table>$<column>. */
    public static function rendererCheckName(string $table, string $column): string
    {
        return $table . '$' . $column;
    }

    /** 10^scale 을 곱한 정수 text 를 scale 자리 소수로 쓴다. */
    public static function unscaledDecimal(string $text, int $scale): string
    {
        $negative = str_starts_with($text, '-');
        $digits = $negative ? substr($text, 1) : $text;
        if ($scale > 0) {
            if (strlen($digits) <= $scale) {
                $digits = str_repeat('0', $scale - strlen($digits) + 1) . $digits;
            }
            $digits = substr($digits, 0, -$scale) . '.' . substr($digits, -$scale);
        }
        return ($negative ? '-' : '') . $digits;
    }
}
