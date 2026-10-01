<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * Reads and writes plan documents (docs/plans.md "Plan document").
 *
 * @internal
 */
final class PlanText
{
    private const NAME = '[a-z][a-z0-9_]*';

    /** 잘못된 plan 은 위치가 붙은 `plan` diagnostic 하나다. */
    public static function parse(string $text): PlanParseResult
    {
        if (!str_ends_with($text, "\n")) {
            return self::fail(substr_count($text, "\n") + 1, 'a plan ends with a line end');
        }
        $name = self::NAME;
        $lines = explode("\n", substr($text, 0, -1));
        if (!preg_match("/^dbplan 1 ($name)\$/D", $lines[0], $m) || in_array($m[1], Parser::RESERVED, true)) {
            return self::fail(1, 'the first line is exactly `dbplan 1 <name>`');
        }
        $planName = $m[1];
        if (count($lines) < 2 || !preg_match('/^from (empty|sha256:[0-9a-f]{64})$/D', $lines[1], $f)) {
            return self::fail(2, 'the second line is `from empty` or `from <schemaHash>`');
        }
        $from = $f[1] === 'empty' ? null : $f[1];
        $renameTables = [];
        $renameColumns = [];
        $dropTables = [];
        $dropColumns = [];
        $seen = [];
        $given = [];
        $i = 2;
        for (; $i < count($lines) && $lines[$i] !== ''; $i++) {
            $line = $lines[$i];
            $n = $i + 1;
            if (isset($seen[$line])) {
                return self::fail($n, "line {$seen[$line]} repeats this line");
            }
            $seen[$line] = $n;
            if (preg_match("/^rename table ($name) ($name)\$/D", $line, $r)) {
                $error = self::names([$r[1], $r[2]]);
                if ($error !== null) {
                    return self::fail($n, $error);
                }
                $key = "table {$r[2]}";
                if (isset($given[$key])) {
                    return self::fail($n, "line {$given[$key]} renames another table to {$r[2]}");
                }
                $given[$key] = $n;
                $renameTables[] = new TableRename($r[1], $r[2]);
            } elseif (preg_match("/^rename column ($name)\\.($name) ($name)\$/D", $line, $r)) {
                $error = self::names([$r[1], $r[2], $r[3]]);
                if ($error !== null) {
                    return self::fail($n, $error);
                }
                $key = "column {$r[1]}.{$r[3]}";
                if (isset($given[$key])) {
                    return self::fail($n, "line {$given[$key]} renames another column to {$r[1]}.{$r[3]}");
                }
                $given[$key] = $n;
                $renameColumns[] = new ColumnRename($r[1], $r[2], $r[3]);
            } elseif (preg_match("/^allow drop table ($name)\$/D", $line, $r)) {
                $error = self::names([$r[1]]);
                if ($error !== null) {
                    return self::fail($n, $error);
                }
                $dropTables[] = $r[1];
            } elseif (preg_match("/^allow drop column ($name)\\.($name)\$/D", $line, $r)) {
                $error = self::names([$r[1], $r[2]]);
                if ($error !== null) {
                    return self::fail($n, $error);
                }
                $dropColumns[] = new ColumnName($r[1], $r[2]);
            } else {
                return self::fail($n, 'a header line is `rename table`, `rename column`, `allow drop table` or `allow drop column`');
            }
        }
        if ($i >= count($lines)) {
            return self::fail($i + 1, 'a blank line and the target schema text follow the header');
        }
        $offset = $i + 1;
        $schemaText = implode("\n", array_slice($lines, $offset)) . "\n";
        $parsed = Dbspec::parse($schemaText, []);
        if ($parsed->document === null) {
            // target diagnostic 은 plan 안의 위치로 옮긴다.
            return PlanParseResult::invalid(array_map(static fn(Diagnostic $d): Diagnostic => new Diagnostic($d->rule, $d->line + $offset, $d->column, $d->message), $parsed->diagnostics));
        }
        $manifest = Dbspec::manifest([$parsed->document]);
        if ($manifest->manifest === null) {
            return PlanParseResult::invalid($manifest->diagnostics);
        }
        if ($manifest->manifest->schemaText !== $schemaText) {
            return self::fail($offset + 1, 'the target is not a schema text: one document named schema in canonical form with its tables in name order and only the immutable and audit settings');
        }
        if ($manifest->manifest->schemaHash === $from) {
            return self::fail(2, 'the plan starts from its own target schema');
        }
        return PlanParseResult::valid(new Plan($planName, $from, $renameTables, $renameColumns, $dropTables, $dropColumns, $parsed->document, $manifest->manifest->schemaHash));
    }

    /**
     * canonical plan: rename table, rename column, allow drop table, allow drop
     * column 순서로, 각각 이름 순이다.
     */
    public static function emit(Plan $plan): string
    {
        $out = "dbplan 1 {$plan->name}\n" . 'from ' . ($plan->from ?? 'empty') . "\n";
        foreach (self::sortedBy($plan->renameTables, static fn(TableRename $r): string => $r->old) as $r) {
            $out .= "rename table {$r->old} {$r->new}\n";
        }
        foreach (self::sortedBy($plan->renameColumns, static fn(ColumnRename $r): string => "{$r->table}.{$r->old}") as $r) {
            $out .= "rename column {$r->table}.{$r->old} {$r->new}\n";
        }
        foreach (self::sortedBy($plan->dropTables, static fn(string $t): string => $t) as $t) {
            $out .= "allow drop table $t\n";
        }
        foreach (self::sortedBy($plan->dropColumns, static fn(ColumnName $c): string => "{$c->table}.{$c->name}") as $c) {
            $out .= "allow drop column {$c->table}.{$c->name}\n";
        }
        return $out . "\n" . self::schemaText($plan);
    }

    /** plan target 의 schema text; parsePlan 이 받은 target 은 유효한 schema 다. */
    public static function schemaText(Plan $plan): string
    {
        $manifest = Dbspec::manifest([$plan->schema]);
        if ($manifest->manifest === null) {
            throw new \InvalidArgumentException("Plan {$plan->name} has an invalid target: " . $manifest->diagnostics[0]->message);
        }
        return $manifest->manifest->schemaText;
    }

    /**
     * key 의 byte 순서로 안정 정렬한다.
     *
     * @template T
     * @param list<T> $items
     * @param callable(T): string $key
     * @return list<T>
     */
    public static function sortedBy(array $items, callable $key): array
    {
        usort($items, static fn($a, $b): int => strcmp($key($a), $key($b)));
        return $items;
    }

    /** @param list<string> $names */
    private static function names(array $names): ?string
    {
        foreach ($names as $n) {
            if (in_array($n, Parser::RESERVED, true) || strlen($n) > 63) {
                return "name \"$n\" is reserved or longer than 63 bytes";
            }
        }
        return null;
    }

    private static function fail(int $line, string $message): PlanParseResult
    {
        return PlanParseResult::invalid([new Diagnostic('plan', $line, 1, $message)]);
    }
}
