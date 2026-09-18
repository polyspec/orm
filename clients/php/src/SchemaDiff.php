<?php
declare(strict_types=1);

namespace Orm;

/**
 * Renders the migration SQL from one schema manifest to another: table and
 * column additions, drops, explicit renames, type and default changes,
 * indexes, foreign keys, checks, comments, and SQLite table rebuilds.
 */
final class SchemaDiff
{
    private const SQLITE_COMMENTS = 'CREATE TABLE IF NOT EXISTS orm_schema_comments (table_name TEXT NOT NULL, column_name TEXT NOT NULL, comment TEXT NOT NULL, PRIMARY KEY (table_name, column_name));';

    public static function render(array $from, array $to, string $dialect, bool $allowDestructive): string
    {
        if ($dialect !== 'mysql' && $dialect !== 'postgres' && $dialect !== 'sqlite') {
            throw new \RuntimeException('unknown dialect ' . Go::quote($dialect));
        }
        $quote = $dialect === 'mysql' ? static fn(string $s): string => '`' . $s . '`' : static fn(string $s): string => '"' . $s . '"';
        self::validateRenameSources($from, $to);
        $changes = [];
        $rebuilt = [];
        foreach (self::matchEntities($from, $to) as [$old, $next]) {
            if ($old === null) {
                $one = ['schema_hash' => $to['schema_hash'], 'order' => [$next['name']], 'entities' => [$next['name'] => $next], 'orm' => [], 'external_fks' => [], 'immutable' => [], 'audit_log' => null, 'audits' => []];
                $create = self::removeDropStatement(SchemaDdl::render($one, $dialect));
                $changes[] = [SchemaParser::trim($create), false];
                continue;
            }
            if ($next === null) {
                $changes[] = ['DROP TABLE ' . $quote($old['table']) . ';', true];
                continue;
            }
            $tableRename = '';
            if ($old['table'] !== $next['table']) {
                if ($next['renamed_from'] !== $old['name'] && $old['renamed_from'] !== $next['name']) {
                    throw new \RuntimeException("table rename {$old['table']} -> {$next['table']} requires explicit migration");
                }
                $tableRename = 'ALTER TABLE ' . $quote($old['table']) . ' RENAME TO ' . $quote($next['table']) . ';';
            }
            if ($dialect === 'sqlite') {
                self::validateSqliteAddedColumns($old, $next);
                if (self::sqliteNeedsRebuild($from, $to, $old, $next)) {
                    $rebuilt[$old['table']] = true;
                    $rebuilt[$next['table']] = true;
                    $changes[] = [self::sqliteRebuild($from, $to, $old, $next, $quote), true];
                    continue;
                }
            }
            [$drops, $adds] = self::indexesAndForeignKeys($from, $to, $old, $next, $dialect, $quote);
            [$checkDrops, $checkAdds] = self::checks($old, $next, $dialect, $quote);
            array_push($changes, ...$drops, ...$checkDrops);
            if ($tableRename !== '') {
                $changes[] = [$tableRename, false];
            }
            foreach (self::matchColumns($old, $next) as [$o, $n]) {
                $col = $n !== null ? $n['name'] : $o['name'];
                if ($o === null) {
                    $def = SchemaDdl::column($n, $dialect, $quote);
                    if ($dialect === 'mysql' && $n['comment'] !== '') {
                        $def .= " COMMENT '" . SchemaDdl::str($n['comment']) . "'";
                    }
                    $changes[] = ['ALTER TABLE ' . $quote($next['table']) . ' ADD COLUMN ' . $def . ';', false];
                    if ($dialect !== 'mysql' && $n['comment'] !== '') {
                        $changes[] = [self::alterComment($next['table'], $n, $dialect, $quote), false];
                    }
                } elseif ($n === null) {
                    $changes[] = ['ALTER TABLE ' . $quote($old['table']) . ' DROP COLUMN ' . $quote($col) . ';', true];
                } else {
                    if ($o['name'] !== $n['name']) {
                        $changes[] = ['ALTER TABLE ' . $quote($next['table']) . ' RENAME COLUMN ' . $quote($o['name']) . ' TO ' . $quote($n['name']) . ';', false];
                    }
                    $changed = $dialect === 'sqlite' ? !self::sqliteColumnsEquivalent($o, $n) : self::columnChanged($o, $n, $dialect);
                    if ($changed) {
                        try {
                            $stmts = self::alterColumn($next['table'], $o, $n, $dialect, $quote);
                        } catch (\RuntimeException $e) {
                            throw new \RuntimeException(sprintf('column %s.%s changed from type=%s raw=%s nullable=%s default=%s to type=%s raw=%s nullable=%s default=%s: %s',
                                $next['table'], $col, $o['type'], $o['raw'], $o['nullable'] ? 'true' : 'false', $o['default'] ?? '',
                                $n['type'], $n['raw'], $n['nullable'] ? 'true' : 'false', $n['default'] ?? '', $e->getMessage()));
                        }
                        foreach ($stmts as $stmt) {
                            $changes[] = [$stmt, true];
                        }
                    }
                }
                if ($o !== null && $n !== null && $o['comment'] !== $n['comment']) {
                    $changes[] = [self::alterComment($next['table'], $n, $dialect, $quote), false];
                }
            }
            if ($old['comment'] !== $next['comment']) {
                $changes[] = [self::alterTableComment($next['table'], $next['comment'], $dialect, $quote), false];
            }
            array_push($changes, ...$adds, ...$checkAdds);
        }
        [$triggerDrops, $triggerCreates] = SchemaTriggers::diff($from, $to, $dialect, $rebuilt);
        $changes = [
            ...array_map(static fn(string $sql): array => [$sql, false], $triggerDrops),
            ...$changes,
            ...array_map(static fn(string $sql): array => [$sql, false], $triggerCreates),
        ];
        foreach ($changes as [$sql, $destructive]) {
            if ($destructive && !$allowDestructive) {
                throw new \RuntimeException('destructive schema change requires --allow-destructive: ' . $sql);
            }
        }
        $b = "-- generated by ormgen diff ($dialect) from {$from['schema_hash']} to {$to['schema_hash']}\n" . SchemaDdl::metadata($to);
        if ($changes === []) {
            $b .= "-- no changes\n";
        }
        foreach ($changes as [$sql]) {
            $b .= $sql . "\n";
        }
        return $b;
    }

    private static function validateSqliteAddedColumns(array $old, array $next): void
    {
        foreach (self::matchColumns($old, $next) as [$previous, $c]) {
            if ($c === null || $previous !== null) {
                continue;
            }
            if (!$c['nullable'] && $c['default'] === null && !$c['auto']) {
                throw new \RuntimeException("sqlite table {$next['table']} cannot add required column {$c['name']} without a default during a data-preserving migration");
            }
        }
    }

    private static function sqliteNeedsRebuild(array $from, array $to, array $old, array $next): bool
    {
        if (($old['pk'] ?? []) !== ($next['pk'] ?? []) || !self::groupsEqual($old['unique'], $next['unique']) || !self::checksEqual($old['checks'], $next['checks'])) {
            return true;
        }
        foreach (self::matchColumns($old, $next) as [$o, $n]) {
            if ($o === null || $n === null) {
                if ($n === null) {
                    return true;
                }
                continue;
            }
            if (!self::sqliteColumnsEquivalent($o, $n)) {
                return true;
            }
        }
        $oldFks = SchemaDdl::foreignKeys($from, $old);
        $newFks = SchemaDdl::foreignKeys($to, $next);
        if (count($oldFks) !== count($newFks)) {
            return true;
        }
        foreach ($oldFks as $column => $left) {
            if (!isset($newFks[$column]) || !self::foreignKeysEqual($left, $newFks[$column], false)) {
                return true;
            }
        }
        return false;
    }

    private static function checksEqual(array $left, array $right): bool
    {
        $keys = static function (array $values): array {
            $out = array_map(static fn(array $v): string => $v['name'] . "\0" . $v['expr'], $values);
            sort($out, SORT_STRING);
            return $out;
        };
        return count($left) === count($right) && $keys($left) === $keys($right);
    }

    private static function groupsEqual(array $left, array $right): bool
    {
        $keys = static function (array $groups): array {
            $out = array_map(static fn(array $g): string => implode("\0", $g), $groups);
            sort($out, SORT_STRING);
            return $out;
        };
        return count($left) === count($right) && $keys($left) === $keys($right);
    }

    /** @return array{list<array>, list<array>} */
    private static function checks(array $old, array $next, string $dialect, \Closure $quote): array
    {
        if ($dialect === 'sqlite' && !self::checksEqual($old['checks'], $next['checks'])) {
            throw new \RuntimeException('sqlite CHECK constraint changes require a verified table rebuild');
        }
        $oldChecks = array_column($old['checks'], null, 'name');
        $newChecks = array_column($next['checks'], null, 'name');
        $names = SchemaDdl::sortedKeys($oldChecks + $newChecks);
        $drops = [];
        $adds = [];
        foreach ($names as $name) {
            $o = $oldChecks[$name] ?? null;
            $n = $newChecks[$name] ?? null;
            if ($o !== null && ($n === null || $o['expr'] !== $n['expr'])) {
                $drops[] = ['ALTER TABLE ' . $quote($old['table']) . ' DROP CONSTRAINT ' . $quote($name) . ';', true];
            }
            if ($n !== null && ($o === null || $o['expr'] !== $n['expr'])) {
                try {
                    $expr = SchemaDdl::checkExpression($n['expr'], $quote);
                } catch (\RuntimeException $e) {
                    throw new \RuntimeException("{$next['table']} check $name: " . $e->getMessage());
                }
                $adds[] = ['ALTER TABLE ' . $quote($next['table']) . ' ADD CONSTRAINT ' . $quote($name) . " CHECK ($expr);", false];
            }
        }
        return [$drops, $adds];
    }

    public static function sqliteColumnsEquivalent(array $left, array $right): bool
    {
        $typeMatch = self::sqliteTypeMatches($right['type'], $left['type']) || self::sqliteTypeMatches($left['type'], $right['type']);
        return $typeMatch && $left['nullable'] === $right['nullable'] && self::normalizedDefault($left) === self::normalizedDefault($right) && $left['auto'] === $right['auto'];
    }

    private static function normalizedDefault(array $c): string
    {
        return $c['default'] === null ? '' : trim($c['default'], "'\"");
    }

    /** Whether a live SQLite storage type can hold a declared type. */
    public static function sqliteTypeMatches(string $want, string $live): bool
    {
        if ($want === $live) {
            return true;
        }
        return match ($live) {
            'i32' => in_array($want, ['i32', 'i64', 'bool'], true),
            'f64' => in_array($want, ['f64', 'decimal'], true),
            'text' => in_array($want, ['string', 'text', 'jsontext', 'datetime', 'date', 'time', 'enum', 'point'], true),
            'bytes' => in_array($want, ['bytes', 'inet'], true),
            default => false,
        };
    }

    private static function sqliteRebuild(array $from, array $to, array $old, array $next, \Closure $quote): string
    {
        $temp = '__orm_rebuild_' . $next['table'];
        $lines = [];
        foreach ($next['columns'] as $c) {
            $lines[] = '  ' . SchemaDdl::column($c, 'sqlite', $quote);
        }
        $pk = $next['pk'] ?? [];
        if (count($pk) === 1 && $next['auto'] === $pk[0]) {
            foreach ($lines as $i => $line) {
                if (str_starts_with($line, '  ' . $quote($pk[0]) . ' ')) {
                    $lines[$i] = '  ' . $quote($pk[0]) . ' INTEGER PRIMARY KEY AUTOINCREMENT';
                }
            }
        } else {
            $lines[] = '  PRIMARY KEY (' . SchemaDdl::joinQuoted($pk, $quote) . ')';
        }
        foreach ($next['unique'] as $unique) {
            $lines[] = '  CONSTRAINT ' . $quote('uq_' . $next['table'] . '_' . implode('_', $unique)) . ' UNIQUE (' . SchemaDdl::joinQuoted($unique, $quote) . ')';
        }
        foreach (SchemaDdl::sortedForeignKeys($to, $next) as $fk) {
            $lines[] = '  ' . SchemaDdl::foreignKeyClause($fk, $to, 'sqlite', $quote);
        }
        foreach ($next['checks'] as $check) {
            try {
                $expr = SchemaDdl::checkExpression($check['expr'], $quote);
            } catch (\RuntimeException $e) {
                throw new \RuntimeException("{$next['table']} check {$check['name']}: " . $e->getMessage());
            }
            $lines[] = '  CONSTRAINT ' . $quote($check['name']) . ' CHECK (' . $expr . ')';
        }
        $targetCols = [];
        $sourceCols = [];
        foreach (self::matchColumns($old, $next) as [$o, $n]) {
            if ($o === null || $n === null) {
                continue;
            }
            $targetCols[] = $quote($n['name']);
            $sourceCols[] = $quote($o['name']);
        }
        $b = "SELECT 'orm-sqlite-rebuild table={$old['table']} target={$next['table']} temp=$temp';\n";
        $b .= "PRAGMA defer_foreign_keys = ON;\n";
        $b .= 'CREATE TABLE ' . $quote($temp) . " (\n" . implode(",\n", $lines) . "\n);\n";
        if ($targetCols !== []) {
            $b .= 'INSERT INTO ' . $quote($temp) . ' (' . implode(', ', $targetCols) . ') SELECT ' . implode(', ', $sourceCols) . ' FROM ' . $quote($old['table']) . ";\n";
        }
        $b .= 'DROP TABLE ' . $quote($old['table']) . ";\n";
        $b .= 'ALTER TABLE ' . $quote($temp) . ' RENAME TO ' . $quote($next['table']) . ";\n";
        foreach (SchemaDdl::sortedKeys($next['indexes'] ?? []) as $name) {
            $b .= 'CREATE INDEX ' . $quote($next['table'] . '_' . $name) . ' ON ' . $quote($next['table']) . ' (' . SchemaDdl::joinQuoted($next['indexes'][$name], $quote) . ");\n";
        }
        $b .= self::SQLITE_COMMENTS . "\n";
        $b .= "DELETE FROM orm_schema_comments WHERE table_name='" . SchemaDdl::str($old['table']) . "';\n";
        if ($next['comment'] !== '') {
            $b .= "INSERT OR REPLACE INTO orm_schema_comments (table_name,column_name,comment) VALUES ('" . SchemaDdl::str($next['table']) . "','','" . SchemaDdl::str($next['comment']) . "');\n";
        }
        foreach ($next['columns'] as $c) {
            if ($c['comment'] !== '') {
                $b .= "INSERT OR REPLACE INTO orm_schema_comments (table_name,column_name,comment) VALUES ('" . SchemaDdl::str($next['table']) . "','" . SchemaDdl::str($c['name']) . "','" . SchemaDdl::str($c['comment']) . "');\n";
            }
        }
        return SchemaParser::trim($b);
    }

    private static function validateRenameSources(array $from, array $to): void
    {
        foreach (SchemaDdl::sortedKeys($to['entities']) as $name) {
            $next = $to['entities'][$name];
            $old = $from['entities'][$next['name']] ?? null;
            if ($next['renamed_from'] !== '' && $old === null) {
                $old = $from['entities'][$next['renamed_from']] ?? null;
                if ($old === null) {
                    throw new \RuntimeException("table {$next['name']} rename source {$next['renamed_from']} does not exist");
                }
            }
            if ($old === null) {
                continue;
            }
            $oldColumns = array_flip(array_column($old['columns'], 'name'));
            foreach ($next['columns'] as $column) {
                if ($column['renamed_from'] !== '' && !isset($oldColumns[$column['name']]) && !isset($oldColumns[$column['renamed_from']])) {
                    throw new \RuntimeException("column {$next['name']}.{$column['name']} rename source {$column['renamed_from']} does not exist");
                }
            }
        }
    }

    /** @return list<array{?array, ?array}> */
    private static function matchEntities(array $from, array $to): array
    {
        $used = [];
        $pairs = [];
        foreach (SchemaDdl::sortedKeys($to['entities']) as $name) {
            $next = $to['entities'][$name];
            $old = $from['entities'][$name] ?? null;
            if ($old === null && $next['renamed_from'] !== '') {
                $old = $from['entities'][$next['renamed_from']] ?? null;
            }
            if ($old === null) {
                foreach (SchemaDdl::sortedKeys($from['entities']) as $candidate) {
                    if ($from['entities'][$candidate]['renamed_from'] === $name) {
                        $old = $from['entities'][$candidate];
                        break;
                    }
                }
            }
            if ($old !== null) {
                $used[$old['name']] = true;
            }
            $pairs[] = [$old, $next];
        }
        foreach (SchemaDdl::sortedKeys($from['entities']) as $name) {
            if (!isset($used[$name])) {
                $pairs[] = [$from['entities'][$name], null];
            }
        }
        return $pairs;
    }

    /** @return list<array{?array, ?array}> */
    private static function matchColumns(array $old, array $next): array
    {
        $oldByName = array_column($old['columns'], null, 'name');
        $used = [];
        $out = [];
        foreach ($next['columns'] as $n) {
            $o = $oldByName[$n['name']] ?? null;
            if ($o === null && $n['renamed_from'] !== '') {
                $o = $oldByName[$n['renamed_from']] ?? null;
            }
            if ($o === null) {
                foreach ($old['columns'] as $candidate) {
                    if ($candidate['renamed_from'] === $n['name']) {
                        $o = $candidate;
                        break;
                    }
                }
            }
            if ($o !== null) {
                $used[$o['name']] = true;
            }
            $out[] = [$o, $n];
        }
        foreach ($old['columns'] as $o) {
            if (!isset($used[$o['name']])) {
                $out[] = [$o, null];
            }
        }
        return $out;
    }

    private static function removeDropStatement(string $s): string
    {
        $out = [];
        foreach (explode("\n", $s) as $line) {
            if (!str_starts_with($line, 'DROP TABLE IF EXISTS ') && !str_starts_with($line, '-- generated by')) {
                $out[] = $line;
            }
        }
        return implode("\n", $out);
    }

    /**
     * Reports a physical column difference. The update time is a column
     * property only on MySQL; the other dialects assign it in the planned
     * UPDATE statement.
     */
    private static function columnChanged(array $a, array $b, string $dialect): bool
    {
        if ($dialect === 'mysql' && $a['on_update'] !== $b['on_update']) {
            return true;
        }
        if (self::columnStorage($a, $dialect) !== self::columnStorage($b, $dialect)) {
            return true;
        }
        foreach (['nullable', 'auto', 'unsigned', 'precision', 'scale'] as $k) {
            if ($a[$k] !== $b[$k]) {
                return true;
            }
        }
        return ($a['default'] ?? '') !== ($b['default'] ?? '');
    }

    /**
     * The type, raw type, and length a dialect stores; a MySQL uuid column is
     * char(36).
     * @return array{string, string, int}
     */
    public static function columnStorage(array $c, string $dialect): array
    {
        if ($dialect === 'mysql' && strcasecmp($c['raw'], 'uuid') === 0) {
            return [$c['type'], SchemaDdl::MYSQL_UUID, 36];
        }
        if ($c['type'] === 'jsontext' || $c['type'] === 'text') {
            return ['text', $dialect === 'mysql' ? SchemaDdl::MYSQL_JSONTEXT : 'text', 0];
        }
        return [$c['type'], $c['raw'], $c['len']];
    }

    /** @return list<string> */
    private static function alterColumn(string $table, array $old, array $next, string $dialect, \Closure $quote): array
    {
        if ($dialect === 'mysql') {
            $def = SchemaDdl::column($next, $dialect, $quote);
            if ($next['comment'] !== '') {
                $def .= " COMMENT '" . SchemaDdl::str($next['comment']) . "'";
            }
            return ['ALTER TABLE ' . $quote($table) . ' MODIFY COLUMN ' . $def . ';'];
        }
        if ($dialect === 'sqlite') {
            throw new \RuntimeException('sqlite does not support deterministic ALTER COLUMN; recreate the table explicitly');
        }
        $out = [];
        $oldType = SchemaDdl::type($old, $dialect);
        $newType = SchemaDdl::type($next, $dialect);
        $prefix = 'ALTER TABLE ' . $quote($table) . ' ALTER COLUMN ' . $quote($next['name']) . ' ';
        if ($oldType !== $newType) {
            $out[] = $prefix . 'TYPE ' . $newType . ';';
        }
        if ($old['nullable'] !== $next['nullable']) {
            $out[] = $prefix . ($next['nullable'] ? 'DROP NOT NULL;' : 'SET NOT NULL;');
        }
        if (($old['default'] ?? '') !== ($next['default'] ?? '') || ($old['default'] === null) !== ($next['default'] === null)) {
            $out[] = $next['default'] === null ? $prefix . 'DROP DEFAULT;' : $prefix . 'SET DEFAULT ' . SchemaDdl::defaultValue($next, $dialect) . ';';
        }
        if ($old['auto'] !== $next['auto']) {
            $out[] = $prefix . ($next['auto'] ? 'ADD GENERATED BY DEFAULT AS IDENTITY;' : 'DROP IDENTITY IF EXISTS;');
        }
        if ($out === []) {
            throw new \RuntimeException('postgres does not support the requested attribute change');
        }
        return $out;
    }

    /** @return array{list<array>, list<array>} */
    private static function indexesAndForeignKeys(array $from, array $to, array $old, array $next, string $dialect, \Closure $quote): array
    {
        $oldIndexes = self::indexes($old, $dialect);
        $newIndexes = self::indexes($next, $dialect);
        $indexDrops = $indexAdds = $foreignDrops = $foreignAdds = [];
        foreach (SchemaDdl::sortedKeys($oldIndexes + $newIndexes) as $key) {
            $o = $oldIndexes[$key] ?? null;
            $n = $newIndexes[$key] ?? null;
            if ($o !== null && $n !== null && $o['kind'] === $n['kind'] && $o['cols'] === $n['cols']) {
                continue;
            }
            if ($o !== null) {
                $indexDrops[] = [self::dropIndex($old['table'], $o, $dialect, $quote), false];
            }
            if ($n !== null) {
                $indexAdds[] = [self::createIndex($next['table'], $n, $dialect, $quote), false];
            }
        }
        $oldFks = SchemaDdl::foreignKeys($from, $old);
        $newFks = SchemaDdl::foreignKeys($to, $next);
        foreach (SchemaDdl::sortedKeys($oldFks + $newFks) as $key) {
            $o = $oldFks[$key] ?? null;
            $n = $newFks[$key] ?? null;
            if ($o !== null && $n !== null && self::foreignKeysEqual($o, $n, $dialect !== 'sqlite')) {
                continue;
            }
            if ($dialect === 'sqlite') {
                throw new \RuntimeException('sqlite foreign key changes require a verified table rebuild');
            }
            if ($o !== null) {
                $verb = $dialect === 'mysql' ? 'DROP FOREIGN KEY' : 'DROP CONSTRAINT';
                $foreignDrops[] = ['ALTER TABLE ' . $quote($old['table']) . " $verb " . $quote($o['name']) . ';', false];
            }
            if ($n !== null) {
                $foreignAdds[] = ['ALTER TABLE ' . $quote($next['table']) . ' ADD ' . SchemaDdl::foreignKeyClause($n, $to, $dialect, $quote) . ';', false];
            }
        }
        return [array_merge($foreignDrops, $indexDrops), array_merge($indexAdds, $foreignAdds)];
    }

    private static function foreignKeysEqual(array $left, array $right, bool $compareName): bool
    {
        return (!$compareName || $left['name'] === $right['name']) && $left['columns'] === $right['columns'] && $left['target'] === $right['target']
            && $left['target_columns'] === $right['target_columns'] && $left['on_delete'] === $right['on_delete'] && $left['deferred'] === $right['deferred'];
    }

    /**
     * Lists the physical indexes of an entity. SQLite evaluates full-text
     * conditions without an index, so it has no full-text objects.
     * @return array<string, array{name: string, kind: string, cols: list<string>}>
     */
    private static function indexes(array $e, string $dialect): array
    {
        $out = [];
        foreach ($e['indexes'] ?? [] as $name => $cols) {
            $out['index:' . $name] = ['name' => (string) $name, 'kind' => 'index', 'cols' => $cols];
        }
        foreach ($e['unique'] as $cols) {
            $name = 'uq_' . $e['table'] . '_' . implode('_', $cols);
            $out['unique:' . $name] = ['name' => $name, 'kind' => 'unique', 'cols' => $cols];
        }
        foreach ($dialect === 'sqlite' ? [] : $e['fulltext'] as $cols) {
            $name = 'ft_' . implode('_', $cols);
            $out['fulltext:' . $name] = ['name' => $name, 'kind' => 'fulltext', 'cols' => $cols];
        }
        return $out;
    }

    private static function dropIndex(string $table, array $index, string $dialect, \Closure $quote): string
    {
        if ($index['kind'] === 'unique') {
            if ($dialect === 'postgres') {
                return 'ALTER TABLE ' . $quote($table) . ' DROP CONSTRAINT ' . $quote($index['name']) . ';';
            }
            if ($dialect === 'sqlite') {
                throw new \RuntimeException('sqlite unique constraint changes require a verified table rebuild');
            }
        }
        $name = $dialect !== 'mysql' && $index['kind'] !== 'unique' ? $table . '_' . $index['name'] : $index['name'];
        if ($dialect === 'mysql') {
            return 'DROP INDEX ' . $quote($name) . ' ON ' . $quote($table) . ';';
        }
        return 'DROP INDEX ' . $quote($name) . ';';
    }

    private static function createIndex(string $table, array $index, string $dialect, \Closure $quote): string
    {
        $cols = SchemaDdl::joinQuoted($index['cols'], $quote);
        if ($index['kind'] === 'unique') {
            if ($dialect === 'postgres') {
                return 'ALTER TABLE ' . $quote($table) . ' ADD CONSTRAINT ' . $quote($index['name']) . " UNIQUE ($cols);";
            }
            if ($dialect === 'sqlite') {
                throw new \RuntimeException('sqlite unique constraint changes require a verified table rebuild');
            }
        }
        $name = $dialect !== 'mysql' && $index['kind'] !== 'unique' ? $table . '_' . $index['name'] : $index['name'];
        switch ($index['kind']) {
            case 'index':
                return 'CREATE INDEX ' . $quote($name) . ' ON ' . $quote($table) . " ($cols);";
            case 'unique':
                return 'CREATE UNIQUE INDEX ' . $quote($name) . ' ON ' . $quote($table) . " ($cols);";
            case 'fulltext':
                if ($dialect === 'mysql') {
                    return 'CREATE FULLTEXT INDEX ' . $quote($name) . ' ON ' . $quote($table) . " ($cols);";
                }
                if ($dialect === 'postgres') {
                    $doc = array_map(static fn(string $c): string => 'coalesce(' . $quote($c) . ", '')", $index['cols']);
                    return 'CREATE INDEX ' . $quote($name) . ' ON ' . $quote($table) . " USING GIN (to_tsvector('simple', " . implode(" || ' ' || ", $doc) . '));';
                }
        }
        throw new \RuntimeException('unknown index kind ' . Go::quote($index['kind']));
    }

    private static function alterTableComment(string $table, string $comment, string $dialect, \Closure $quote): string
    {
        $q = SchemaDdl::str($comment);
        return match ($dialect) {
            'mysql' => 'ALTER TABLE ' . $quote($table) . " COMMENT = '$q';",
            'postgres' => $comment === '' ? 'COMMENT ON TABLE ' . $quote($table) . ' IS NULL;' : 'COMMENT ON TABLE ' . $quote($table) . " IS '$q';",
            default => $comment === ''
                ? "DELETE FROM orm_schema_comments WHERE table_name='" . SchemaDdl::str($table) . "' AND column_name='';"
                : "INSERT OR REPLACE INTO orm_schema_comments (table_name,column_name,comment) VALUES ('" . SchemaDdl::str($table) . "','','$q');",
        };
    }

    private static function alterComment(string $table, array $c, string $dialect, \Closure $quote): string
    {
        $q = SchemaDdl::str($c['comment']);
        return match ($dialect) {
            'mysql' => 'ALTER TABLE ' . $quote($table) . ' MODIFY COLUMN ' . SchemaDdl::column($c, $dialect, $quote) . " COMMENT '" . ($c['comment'] !== '' ? $q : '') . "';",
            'postgres' => $c['comment'] === ''
                ? 'COMMENT ON COLUMN ' . $quote($table) . '.' . $quote($c['name']) . ' IS NULL;'
                : 'COMMENT ON COLUMN ' . $quote($table) . '.' . $quote($c['name']) . " IS '$q';",
            default => $c['comment'] === ''
                ? "DELETE FROM orm_schema_comments WHERE table_name='" . SchemaDdl::str($table) . "' AND column_name='" . SchemaDdl::str($c['name']) . "';"
                : "CREATE TABLE IF NOT EXISTS orm_schema_comments (table_name TEXT NOT NULL, column_name TEXT NOT NULL, comment TEXT NOT NULL, PRIMARY KEY (table_name, column_name));\nINSERT OR REPLACE INTO orm_schema_comments (table_name,column_name,comment) VALUES ('" . SchemaDdl::str($table) . "','" . SchemaDdl::str($c['name']) . "','$q');",
        };
    }
}
