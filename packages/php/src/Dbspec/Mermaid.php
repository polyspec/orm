<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * dbspec 문서를 표준 Mermaid erDiagram 으로 쓰고, erDiagram 을 dbspec 문서로
 * 읽는다 (docs/mermaid.md). 둘 다 옮기지 못한 것을 [kind, table, name] 순서로 알린다.
 *
 * @internal
 */
final class Mermaid
{
    /** import 가 읽지 못한 Mermaid 줄의 diagnostic rule. */
    public const RULE = 'mermaid';

    // Go regexp 의 \s 는 [\t\n\f\r ] 이다. PCRE 의 \s 는 \v 도 받으므로 class 를 그대로 쓴다.
    private const ENTITY_NAME = '([A-Za-z0-9_-]+|"[^"]*")';
    private const ENTITY_START = '/^' . self::ENTITY_NAME . '[\t\n\f\r ]*\{$/D';
    private const ATTRIBUTE = '/^([A-Za-z][A-Za-z0-9_()\[\]-]*)[\t\n\f\r ]+([A-Za-z_*][A-Za-z0-9_-]*)((?:[\t\n\f\r ]+(?:PK|FK|UK)(?:[\t\n\f\r ]*,[\t\n\f\r ]*(?:PK|FK|UK))*)?)(?:[\t\n\f\r ]+"([^"]*)")?$/D';
    private const RELATION = '/^' . self::ENTITY_NAME . '[\t\n\f\r ]+(\|o|\|\||\}o|\}\|)(--|\.\.)(o\||\|\||o\{|\|\{)[\t\n\f\r ]+' . self::ENTITY_NAME . '[\t\n\f\r ]*:[\t\n\f\r ]*("[^"]*"|[^\t\n\f\r "]+)$/D';
    private const LABEL = '/^([a-z][a-z0-9_]*) \(([a-z0-9_, ]+)\) references \(([a-z0-9_, ]+)\)$/D';
    // comment 뒤에 공백 하나를 붙인 text 에 맞춘다. 각 부분이 공백 하나로 끝나야 하므로 부분 사이에 공백이 정확히 하나 있다.
    private const SUFFIX = '/^(?:(null) )?(?:(identity) )?(?:default (.+) )?$/D';
    private const KNOWN_TYPE = '/^(i16|i32|i64|bool|f64|text|bytes|uuid|date)$|^varchar\((\d+)\)$|^(time|datetime)\((\d)\)$|^decimal\((\d+)-(\d+)\)$/D';
    /** Go strings.TrimSpace 가 지우는 Unicode White_Space 의 UTF-8 byte 열. */
    private const SPACE = '(?:[\t\n\v\f\r ]|\xC2[\x85\xA0]|\xE1\x9A\x80|\xE2\x80[\x80-\x8A\xA8\xA9\xAF]|\xE2\x81\x9F|\xE3\x80\x80)';

    public static function export(Document $d): MermaidExportResult
    {
        $dropped = [];
        $report = static function (string $kind, string $table, string $name, string $reason) use (&$dropped): void {
            $dropped[] = new Unsupported($kind, $table, $name, $reason);
        };
        foreach ($d->uses as $u) {
            $report('use', '', $u->document, 'export writes the tables of one document; used tables appear only as relationship ends');
            if ($u->comments !== []) {
                $report('comment', '', $u->document, 'Mermaid has no comments on use lines');
            }
        }
        foreach ($d->diagrams as $g) {
            $report('diagram', '', $g->name, 'a dbspec diagram has no Mermaid form');
            if ($g->comments !== [] || $g->closingComments !== [] || array_any($g->placements, static fn(Placement $p): bool => $p->comments !== [])) {
                $report('comment', '', $g->name, 'Mermaid has no diagram comments');
            }
        }
        if ($d->trailingComments !== []) {
            $report('comment', '', $d->name, 'Mermaid has no comments after the last block');
        }
        $tables = $d->tables;
        usort($tables, static fn(Table $a, Table $b): int => strcmp($a->name, $b->name));
        $out = "erDiagram\n";
        foreach ($tables as $t) {
            if ($t->comments !== [] || $t->closingComments !== [] || ($t->primaryKey?->comments ?? []) !== [] || self::settingsCommented($t->settings)) {
                $report('comment', $t->name, $t->name, 'Mermaid has no comments on the table, primary key and settings lines');
            }
            $out .= "    {$t->name} {\n";
            foreach ($t->columns as $c) {
                if ($c->comments !== []) {
                    $report('comment', $t->name, $c->name, 'Mermaid has no column comments');
                }
                $line = '        ' . self::type($c->type) . ' ' . $c->name;
                $keys = [];
                if (in_array($c->name, $t->primaryKey?->columns ?? [], true)) {
                    $keys[] = 'PK';
                }
                if (array_any($t->foreignKeys, static fn(ForeignKey $f): bool => in_array($c->name, $f->columns, true))) {
                    $keys[] = 'FK';
                }
                if (array_any($t->uniqueKeys, static fn(UniqueKey $u): bool => in_array($c->name, $u->columns, true))) {
                    $keys[] = 'UK';
                }
                if ($keys !== []) {
                    $line .= ' ' . implode(', ', $keys);
                }
                $suffix = [];
                if ($c->nullable) {
                    $suffix[] = 'null';
                }
                if ($c->identity) {
                    $suffix[] = 'identity';
                }
                if ($c->default !== null) {
                    if (str_contains($c->default, '"')) {
                        $report('default', $t->name, $c->name, 'a Mermaid comment cannot hold the default, which contains a double quote');
                    } else {
                        $suffix[] = "default {$c->default}";
                    }
                }
                if ($suffix !== []) {
                    $line .= ' "' . implode(' ', $suffix) . '"';
                }
                $out .= "$line\n";
            }
            $out .= "    }\n";
            $keyComment = static function (string $name, array $comments) use ($report, $t): void {
                if ($comments !== []) {
                    $report('comment', $t->name, $name, 'Mermaid has no key comments');
                }
            };
            foreach ($t->uniqueKeys as $u) {
                $report('unique', $t->name, $u->name, 'Mermaid marks the columns of a unique key with UK but has no key');
                $keyComment($u->name, $u->comments);
            }
            foreach ($t->indexes as $x) {
                $report('index', $t->name, $x->name, 'Mermaid has no indexes');
                $keyComment($x->name, $x->comments);
            }
            foreach ($t->checks as $k) {
                $report('check', $t->name, $k->name, 'Mermaid has no checks');
                $keyComment($k->name, $k->comments);
            }
            foreach ($t->foreignKeys as $f) {
                if ($f->onDelete !== 'restrict' || $f->onUpdate !== 'restrict') {
                    $report('foreign_key', $t->name, $f->name, 'Mermaid has no foreign key actions');
                }
                $keyComment($f->name, $f->comments);
            }
            if ($t->settings !== null) {
                $report('settings', $t->name, $t->name, 'Mermaid has no settings');
            }
        }
        foreach ($tables as $t) {
            $foreignKeys = $t->foreignKeys;
            usort($foreignKeys, static fn(ForeignKey $a, ForeignKey $b): int => strcmp($a->name, $b->name));
            foreach ($foreignKeys as $f) {
                $marker = '||--o{';
                foreach ($f->columns as $name) {
                    foreach ($t->columns as $c) {
                        if ($c->name === $name && $c->nullable) {
                            $marker = '|o--o{';
                        }
                    }
                }
                $out .= "    {$f->table} $marker {$t->name} : \"{$f->name} (" . implode(', ', $f->columns) . ') references (' . implode(', ', $f->referencedColumns) . ")\"\n";
            }
        }
        usort($dropped, static fn(Unsupported $a, Unsupported $b): int => strcmp("{$a->table}\0{$a->kind}\0{$a->name}", "{$b->table}\0{$b->kind}\0{$b->name}"));
        return new MermaidExportResult($out, $dropped);
    }

    /** settings block 의 여는 줄, setting 줄, 닫는 줄 중 하나에 comment 가 있는지 알려준다. */
    private static function settingsCommented(?Settings $s): bool
    {
        return $s !== null && ($s->comments !== [] || $s->closingComments !== [] || array_any($s->settings, static fn(Setting $x): bool => $x->comments !== []));
    }

    /** Mermaid type 에는 쉼표가 없으므로 decimal(p,s) 를 decimal(p-s) 로 쓴다. */
    private static function type(ColumnType $t): string
    {
        return $t->name === 'decimal' ? "decimal({$t->parameters[0]}-{$t->parameters[1]})" : $t->text();
    }

    public static function import(string $text, string $name): MermaidImportResult
    {
        $lines = explode("\n", str_ends_with($text, "\n") ? substr($text, 0, -1) : $text);
        /** @var array<string, array{name: string, attributes: list<array{type: string, name: string, comment: string, keys: list<string>}>}> $byName 선언 순서를 지킨다 */
        $byName = [];
        $entity = static function (string $n) use (&$byName): string {
            $n = trim($n, '"');
            $byName[$n] ??= ['name' => $n, 'attributes' => []];
            return $n;
        };
        $relations = [];
        $open = null;
        $header = false;
        $fail = static fn(int $line, string $message): MermaidImportResult => MermaidImportResult::invalid([new Diagnostic(self::RULE, $line, 1, $message)]);
        foreach ($lines as $i => $raw) {
            $n = $i + 1;
            $line = preg_replace('/^' . self::SPACE . '+|' . self::SPACE . '+$/D', '', str_ends_with($raw, "\r") ? substr($raw, 0, -1) : $raw);
            if ($line === '' || str_starts_with($line, '%%')) {
                continue;
            }
            if (!$header) {
                if ($line !== 'erDiagram') {
                    return $fail($n, 'a Mermaid entity relationship diagram starts with erDiagram');
                }
                $header = true;
            } elseif ($open !== null) {
                if ($line === '}') {
                    $open = null;
                    continue;
                }
                if (preg_match(self::ATTRIBUTE, $line, $m) !== 1) {
                    return $fail($n, 'an attribute is <type> <name> [PK|FK|UK, ...] ["comment"]');
                }
                $keys = [];
                foreach (explode(',', $m[3]) as $k) {
                    $k = trim($k, " \t\n\f\r");
                    if ($k !== '') {
                        $keys[] = $k;
                    }
                }
                $byName[$open]['attributes'][] = ['type' => $m[1], 'name' => $m[2], 'comment' => $m[4] ?? '', 'keys' => $keys];
            } elseif (preg_match(self::ENTITY_START, $line, $m) === 1) {
                $open = $entity($m[1]);
            } elseif (preg_match(self::RELATION, $line, $m) === 1) {
                $relations[] = ['left' => $entity($m[1]), 'leftCard' => $m[2], 'rightCard' => $m[4], 'right' => $entity($m[5]), 'label' => trim($m[6], '"')];
            } else {
                return $fail($n, 'a line is an entity block, an attribute, a relationship, a %% comment or blank');
            }
        }
        if (!$header) {
            return $fail(1, 'a Mermaid entity relationship diagram starts with erDiagram');
        }
        if ($open !== null) {
            return $fail(count($lines), "entity $open has no closing brace");
        }
        $c = new Catalog();
        $usedForeignKeys = [];
        foreach ($byName as $e) {
            if (!Parser::validName($e['name'])) {
                $c->report('table', $e['name'], $e['name'], 'the entity name is not a dbspec name');
                continue;
            }
            $t = new CatalogTable($e['name']);
            foreach ($e['attributes'] as $a) {
                if (!Parser::validName($a['name'])) {
                    $c->report('column', $e['name'], $a['name'], 'the attribute name is not a dbspec name');
                    continue;
                }
                $type = self::importType($a['type']);
                if ($type === null) {
                    $c->report('column', $e['name'], $a['name'], "type {$a['type']} is not a dbspec type");
                    continue;
                }
                $column = ['name' => $a['name'], 'type' => $type, 'null' => false, 'identity' => false, 'default' => ''];
                if ($a['comment'] !== '') {
                    if (preg_match(self::SUFFIX, $a['comment'] . ' ', $s) === 1) {
                        [$column['null'], $column['identity'], $column['default']] = [($s[1] ?? '') !== '', ($s[2] ?? '') !== '', $s[3] ?? ''];
                    } else {
                        $c->report('comment', $e['name'], $a['name'], 'the comment ' . self::quoted($a['comment']) . ' is not a dbspec column suffix');
                    }
                }
                $t->columns[] = $column;
                if (in_array('PK', $a['keys'], true)) {
                    $t->primary[] = $a['name'];
                }
                if (in_array('UK', $a['keys'], true)) {
                    $c->report('unique', $e['name'], $a['name'], 'Mermaid does not say which UK attributes form one key');
                }
            }
            $c->tables[] = $t;
        }
        $columnIn = static function (CatalogTable $t, string $n): ?array {
            foreach ($t->columns as $column) {
                if ($column['name'] === $n) {
                    return $column;
                }
            }
            return null;
        };
        $isForeignKey = static function (string $entity, string $column) use ($byName): bool {
            foreach ($byName[$entity]['attributes'] as $a) {
                if ($a['name'] === $column) {
                    return in_array('FK', $a['keys'], true);
                }
            }
            return false;
        };
        foreach ($relations as $r) {
            [$parent, $child, $parentCard, $childCard] = [$r['left'], $r['right'], $r['leftCard'], $r['rightCard']];
            $manyRight = str_ends_with($r['rightCard'], '{');
            $manyLeft = str_starts_with($r['leftCard'], '}');
            if ($manyLeft === $manyRight) {
                $c->report('relationship', $r['left'], $r['label'], "the relationship to {$r['right']} is not one to many");
                continue;
            }
            if ($manyLeft) {
                [$parent, $child, $parentCard, $childCard] = [$r['right'], $r['left'], $r['rightCard'], $r['leftCard']];
            }
            $pt = $c->table($parent);
            $ct = $c->table($child);
            if (preg_match(self::LABEL, $r['label'], $m) !== 1 || $pt === null || $ct === null) {
                $c->report('relationship', $child, $r['label'], 'the label does not give the foreign key columns, or an end is not a table');
                continue;
            }
            $columns = self::splitNames($m[2]);
            $refs = self::splitNames($m[3]);
            // column 수가 참조 column 수와 다르면 foreign key 가 아니므로 column 을 보지 않는다.
            $ok = count($columns) === count($refs);
            $nullable = false;
            foreach ($ok ? $columns : [] as $i => $column) {
                $cc = $columnIn($ct, $column);
                if ($cc === null || !$isForeignKey($child, $column) || $columnIn($pt, $refs[$i]) === null) {
                    $ok = false;
                    break;
                }
                $nullable = $nullable || $cc['null'];
            }
            if (!$ok) {
                $c->report('relationship', $child, $m[1], "its columns are not FK attributes of $child or its referenced columns are not attributes of $parent");
                continue;
            }
            $wantParent = $nullable ? '|o' : '||';
            if ($manyLeft) {
                $wantParent = ['||' => '||', '|o' => 'o|'][$wantParent];
            }
            if ($parentCard !== $wantParent || ($childCard !== 'o{' && $childCard !== '}o')) {
                $c->report('cardinality', $child, $m[1], "the cardinalities differ from the ones the foreign key's nullability gives");
            }
            $ct->foreignKeys[] = ['name' => $m[1], 'columns' => $columns, 'table' => $parent, 'refs' => $refs, 'onDelete' => 'restrict', 'onUpdate' => 'restrict'];
            foreach ($columns as $column) {
                $usedForeignKeys[$child][$column] = true;
            }
            $index = "ix_{$child}_" . implode('_', $columns);
            // 같은 column 의 foreign key 가 이미 더한 index 는 다시 더하지 않는다.
            $indexed = array_any($ct->indexes, static fn(array $x): bool => $x['name'] === $index);
            if (array_slice($ct->primary, 0, count($columns)) !== $columns && !$indexed) {
                $ct->indexes[] = ['name' => $index, 'columns' => $columns, 'desc' => array_fill(0, count($columns), false)];
                $c->report('index', $child, $index, 'Mermaid has no indexes; the foreign key needs one');
            }
        }
        foreach ($byName as $e) {
            foreach ($e['attributes'] as $a) {
                if (in_array('FK', $a['keys'], true) && !isset($usedForeignKeys[$e['name']][$a['name']]) && $c->table($e['name']) !== null) {
                    $c->report('foreign_key', $e['name'], $a['name'], 'no relationship gives the foreign key of this FK attribute');
                }
            }
        }
        try {
            $result = $c->document($name);
        } catch (\RuntimeException $e) {
            return MermaidImportResult::invalid([new Diagnostic(self::RULE, 1, 1, $e->getMessage())]);
        }
        return MermaidImportResult::valid($result->document, $result->unsupported);
    }

    /** @return list<string> */
    private static function splitNames(string $s): array
    {
        return array_map(static fn(string $p): string => trim($p, " \t\n\v\f\r"), explode(',', $s));
    }

    /**
     * Mermaid type 이 dbspec type 이면 그 ColumnType, 아니면 null. 수가 dbspec 범위
     * (varchar 1-16383, time 과 datetime 0-6, decimal p 1-18 과 s 0-p)를 벗어나면 dbspec
     * type 이 아니다. 범위를 여기서 정하므로 key column 도 모든 client 에서 같은 지점에서 빠진다.
     */
    private static function importType(string $s): ?ColumnType
    {
        if (preg_match(self::KNOWN_TYPE, $s, $m) !== 1) {
            return null;
        }
        if (($m[1] ?? '') !== '') {
            return new ColumnType($m[1]);
        }
        if (($m[2] ?? '') !== '') {
            $length = self::within($m[2], 1, 16383);
            return $length === null ? null : new ColumnType('varchar', [$length]);
        }
        if (($m[3] ?? '') !== '') {
            $precision = self::within($m[4], 0, 6);
            return $precision === null ? null : new ColumnType($m[3], [$precision]);
        }
        $precision = self::within($m[5], 1, 18);
        $scale = $precision === null ? null : self::within($m[6], 0, $precision);
        return $scale === null ? null : new ColumnType('decimal', [$precision, $scale]);
    }

    /** 숫자 text 가 lo 이상 hi 이하인 값이면 그 값, 아니면 null. 9자리를 넘는 수는 범위 밖이다. */
    private static function within(string $digits, int $lo, int $hi): ?int
    {
        $digits = ltrim($digits, '0');
        if (strlen($digits) > 9) {
            return null;
        }
        $n = (int) $digits;
        return $n >= $lo && $n <= $hi ? $n : null;
    }

    /**
     * Go 의 %q 처럼 따옴표로 감싼다. ASCII 의 escape 는 Go 와 같고, ASCII 가 아닌 byte 는
     * 그대로 둔다.
     */
    private static function quoted(string $s): string
    {
        $escapes = ["\x07" => '\\a', "\x08" => '\\b', "\f" => '\\f', "\n" => '\\n', "\r" => '\\r', "\t" => '\\t', "\v" => '\\v', '\\' => '\\\\', '"' => '\\"'];
        return '"' . preg_replace_callback('/[\x00-\x1F\x7F\\\\"]/', static fn(array $m): string => $escapes[$m[0]] ?? sprintf('\\x%02x', ord($m[0])), $s) . '"';
    }
}
