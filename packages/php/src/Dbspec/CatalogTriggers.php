<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * The immutable and audit settings are recognized from the catalog triggers, rewritten in the renderer's
 * statement form, (docs/spec/dialects.md "Introspection", "Triggers").
 *
 * @internal
 */
final class CatalogTriggers
{
    private const AUDIT_INSERT = '/^INSERT INTO [`"]([a-z0-9_]+)[`"] \(([^)]*)\) VALUES /';
    private const AUDIT_COLUMN = '/^[`"]([a-z0-9_]+)[`"]$/D';
    private const AUDIT_TABLES = '/; INSERT INTO [`"]([a-z0-9_]+)[`"] \\([`"]([a-z0-9_]+)[`"], [`"]([a-z0-9_]+)[`"]\\) VALUES \\(NEW\\./';
    private const AUDIT_UPDATE = '/VALUES \(\'update\', OLD\.[`"]([a-z0-9_]+)[`"],/';

    /**
     * For each table, if the trigger set is immutable or equal to the renderer output of audit, then
     * adds that setting; otherwise reports every trigger as unsupported.
     *
     * @param array<string, list<array{name: string, statements: list<string>}>> $triggers table: trigger
     */
    public static function recognize(Catalog $c, string $dialect, array $triggers): void
    {
        ksort($triggers, SORT_STRING);
        foreach ($triggers as $table => $list) {
            $table = (string) $table;
            $t = $c->table($table);
            if ($t === null) {
                foreach ($list as $tr) {
                    $c->report('trigger', $table, $tr['name'], 'the table is not read');
                }
                continue;
            }
            $settings = self::setting($dialect, $t, $list);
            if ($settings === null) {
                foreach ($list as $tr) {
                    $c->report('trigger', $table, $tr['name'],
                        'the trigger is not the renderer output of immutable or audit');
                }
                continue;
            }
            array_push($t->settings, ...$settings);
        }
    }

    /**
     * Recognizes each setting by its own trigger name (recomputed by the renderer), and returns those
     * setting lines only when the trigger set matches the recognized settings' renderer output in both
     * name and content. Otherwise returns null (docs/spec/dialects.md "Triggers"). A table with both
     * settings is the sum of the two outputs, and is not judged by count.
     *
     * @param list<array{name: string, statements: list<string>}> $list
     * @return ?list<string>
     */
    private static function setting(string $dialect, CatalogTable $t, array $list): ?array
    {
        $names = [];
        foreach ($list as $tr) {
            $names[$tr['name']] = $tr;
        }
        $model = new Table($t->name);
        foreach ($t->columns as $column) {
            $model->columns[] = new Column($column['name'], $column['type'], false, false, null);
        }
        $settings = [];
        foreach (['immutable_update', 'immutable_delete'] as $event) {
            if (isset($names[Names::render($t->name, $event)])) {
                $settings[] = new Setting('immutable', []);
                break;
            }
        }
        $insert = $names[Names::render($t->name, 'audit_insert')] ?? null;
        if ($insert !== null) {
            $update = $names[Names::render($t->name, 'audit_update')] ?? null;
            if (
                preg_match(self::AUDIT_INSERT, self::body($insert['statements']), $m)
                && preg_match(self::AUDIT_UPDATE, self::body($update['statements'] ?? []), $u)
            ) {
                $tables = preg_match(self::AUDIT_TABLES, self::body($insert['statements']), $tm) === 1
                    ? [$tm[1], $tm[2], $tm[3]] : [];
                $audit = self::audit($t, $m[1], explode(', ', $m[2]), $u[1], $tables);
                if ($audit !== null) {
                    $settings[] = $audit;
                }
            }
        }
        if ($settings === []) {
            return null;
        }
        $model->settings = new Settings();
        $model->settings->settings = $settings;
        $want = Renderer::tableTriggers($model, $dialect);
        $ordered = self::order($want);
        if (count($ordered) !== count($list)) {
            return null;
        }
        $got = [];
        foreach ($ordered as $name) {
            if (!isset($names[$name])) {
                return null;
            }
            array_push($got, ...$names[$name]['statements']);
        }
        if ($got !== $want) {
            return null;
        }
        return array_map(
            static fn(Setting $setting): string => $setting->kind === 'immutable'
                ? 'immutable' : $setting->auditLine('exclude', $setting->exclude),
            $settings
        );
    }

    /**
     * The column list of the audit insert trigger (action, previous, and the recorded columns) and the update trigger
     * builds the audit setting from the audit columns. The audit record table is the table of a foreign key that
     * points at a table with only one audit column. Columns not recorded become the exclude
     * list in table column order. If the list is not in renderer form, does not record an audit column, or the foreign
     * key is not exactly one, it is null. The built setting is rendered again and compared with the catalog trigger.
     *
     * @param list<string> $quoted
     */
    /** @param list<string> $tables the tables table and its record and name columns, or empty without the clause */
    private static function audit(CatalogTable $t, string $history, array $quoted, string $column, array $tables): ?Setting
    {
        $names = [];
        foreach ($quoted as $q) {
            if (preg_match(self::AUDIT_COLUMN, $q, $m) !== 1) {
                return null;
            }
            $names[] = $m[1];
        }
        $recorded = array_slice($names, 2);
        if ($recorded === [] || !in_array($column, $recorded, true)) {
            return null;
        }
        $references = '';
        foreach ($t->foreignKeys as $f) {
            if ($f['columns'] === [$column]) {
                if ($references !== '') {
                    return null;
                }
                $references = $f['table'];
            }
        }
        if ($references === '') {
            return null;
        }
        $excluded = [];
        foreach ($t->columns as $c) {
            if (!in_array($c['name'], $recorded, true)) {
                $excluded[] = $c['name'];
            }
        }
        // The arguments of audit are the history table, audit column, audit record table, action, and
        // previous, in order.
        return new Setting('audit', [$history, $column, $references, $names[0], $names[1], ...$tables], [],
            $excluded === [] ? null : $excluded);
    }

    /**
     * Takes the trigger names out of the renderer statement list in order.
     *
     * @param list<string> $statements
     * @return list<string>
     */
    private static function order(array $statements): array
    {
        $names = [];
        foreach ($statements as $s) {
            if (!str_starts_with($s, 'CREATE TRIGGER ')) {
                continue;
            }
            $rest = substr($s, strlen('CREATE TRIGGER '));
            $end = strpos($rest, $rest[0], 1);
            $names[] = substr($rest, 1, $end - 1);
        }
        return $names;
    }

    /**
     * Takes the body out of a trigger statement: for MySQL, after FOR EACH ROW; for PostgreSQL,
     * after BEGIN of the function; for SQLite, after BEGIN.
     *
     * @param list<string> $statements
     */
    private static function body(array $statements): string
    {
        foreach ($statements as $s) {
            foreach (['$$BEGIN ', 'FOR EACH ROW BEGIN ', 'FOR EACH ROW '] as $marker) {
                $i = strpos($s, $marker);
                if ($i !== false) {
                    return substr($s, $i + strlen($marker));
                }
            }
        }
        return '';
    }
}
