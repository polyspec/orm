<?php
declare(strict_types=1);

namespace Orm;

/**
 * Plans `utils().schema().addColumns()`: the statements that add the missing
 * nullable or defaulted columns of the existing tables of a manifest and
 * replace the audit triggers of each changed table. The live tables of the
 * manifest are read through the import, with the column facts that the
 * catalog does not hold (bool, int, lazy and styles) taken from the manifest.
 * Every other difference between those tables and the manifest is reported
 * with SCHEMA_DIFFERS before any statement runs.
 */
final class SchemaColumns
{
    /**
     * @return array{list<string>, list<string>} the statements and the added columns as table.column
     */
    public static function plan(\PDO $pdo, string $driver, array $want): array
    {
        $physical = [];
        foreach ($want['order'] as $name) {
            $table = $want['entities'][$name]['table'];
            if ($driver !== 'sqlite' && str_contains($table, '.')) {
                throw new OrmException(Code::CAPABILITY_UNSUPPORTED, "addColumns reads the tables of the connected schema; table $table is qualified");
            }
            $physical[$name] = SchemaDdl::table($table, $driver);
        }
        try {
            $tables = SchemaImport::readTables($pdo, $driver, array_fill_keys(array_values($physical), true));
        } catch (\PDOException $e) {
            throw $e;
        } catch (\RuntimeException $e) {
            throw new OrmException(Code::SCHEMA_DIFFERS, 'the existing tables of the manifest cannot be read: ' . $e->getMessage(), $e);
        }
        if ($tables === []) {
            return [[], []];
        }
        try {
            $live = SchemaBuilder::build([SchemaParser::parse(SchemaImport::renderMermaid($tables, self::facts($want, $physical)))], true);
        } catch (\RuntimeException | \InvalidArgumentException $e) {
            throw new OrmException(Code::SCHEMA_DIFFERS, 'the existing tables of the manifest cannot be read as a manifest: ' . $e->getMessage(), $e);
        }
        $byTable = [];
        foreach ($live['entities'] as $e) {
            $byTable[$e['table']] = $e;
        }
        $current = self::tables($live);
        $declared = self::tables($want);
        foreach ($want['order'] as $name) {
            $le = $byTable[$physical[$name]] ?? null;
            if ($le === null) {
                continue;
            }
            $le['name'] = $name;
            $le['table'] = $want['entities'][$name]['table'];
            $current['order'][] = $name;
            $current['entities'][$name] = $le;
            $declared['order'][] = $name;
            $declared['entities'][$name] = $want['entities'][$name];
        }
        try {
            SchemaChecks::alignLive($pdo, $driver, $current, $declared);
        } catch (\PDOException $e) {
            throw $e;
        } catch (\RuntimeException $e) {
            throw new OrmException(Code::SCHEMA_DIFFERS, 'compare the checks of the existing tables: ' . $e->getMessage(), $e);
        }
        self::alignDefaults($current, $declared);
        $expanded = $current;
        $added = [];
        $required = [];
        $changed = [];
        foreach ($declared['order'] as $name) {
            $we = $declared['entities'][$name];
            $liveColumns = array_column($current['entities'][$name]['columns'], null, 'name');
            $columns = [];
            foreach ($we['columns'] as $wc) {
                if (isset($liveColumns[$wc['name']])) {
                    $columns[] = $liveColumns[$wc['name']];
                    unset($liveColumns[$wc['name']]);
                } elseif ($wc['auto'] || (!$wc['nullable'] && $wc['default'] === null)) {
                    $required[] = "{$we['table']}.{$wc['name']}";
                } else {
                    $columns[] = $wc;
                    $added[] = "{$we['table']}.{$wc['name']}";
                    $changed[$we['table']] = true;
                }
            }
            array_push($columns, ...array_values($liveColumns));
            $expanded['entities'][$name]['columns'] = $columns;
            $expanded['entities'][$name]['cols'] = array_flip(array_column($columns, 'name'));
        }
        if ($required !== []) {
            throw new OrmException(Code::SCHEMA_DIFFERS, 'addColumns adds only nullable or defaulted columns; required columns: ' . implode(', ', $required));
        }
        try {
            $differences = SchemaDdl::splitSql(SchemaDiff::render($expanded, $declared, $driver, true));
        } catch (\RuntimeException $e) {
            throw new OrmException(Code::SCHEMA_DIFFERS, 'the existing tables differ from the manifest: ' . $e->getMessage(), $e);
        }
        if ($differences !== []) {
            throw new OrmException(Code::SCHEMA_DIFFERS, 'the existing tables differ from the manifest beyond missing columns: ' . implode(' ', $differences));
        }
        if ($added === []) {
            return [[], []];
        }
        try {
            $statements = SchemaDdl::splitSql(SchemaDiff::render($current, $expanded, $driver, false));
        } catch (\RuntimeException $e) {
            throw new OrmException(Code::SCHEMA_DIFFERS, 'add columns: ' . $e->getMessage(), $e);
        }
        foreach (SchemaTriggers::objects($want, $driver) as $o) {
            if ($o['kind'] === 'audit' && isset($changed[$o['table']])) {
                array_push($statements, ...$o['create']);
            }
        }
        return [$statements, $added];
    }

    /**
     * Replaces the default of every live column whose catalog text is
     * equivalent to the declared default with the declared text: the import
     * reads a string default with its quotes and a decimal default with the
     * digits of its scale, so a diff reports only real changes.
     */
    private static function alignDefaults(array &$current, array $declared): void
    {
        foreach ($declared['order'] as $name) {
            $declaredColumns = array_column($declared['entities'][$name]['columns'], null, 'name');
            foreach ($current['entities'][$name]['columns'] as $i => $c) {
                $d = $declaredColumns[$c['name']] ?? null;
                if ($d !== null && $c['default'] !== null && $d['default'] !== null && $c['default'] !== $d['default']
                    && self::defaultText($c['default']) === self::defaultText($d['default'])) {
                    $current['entities'][$name]['columns'][$i]['default'] = $d['default'];
                }
            }
        }
    }

    /** A default without its string quotes, and a number without trailing fraction zeros. */
    private static function defaultText(string $d): string
    {
        if (strlen($d) >= 2 && $d[0] === "'" && str_ends_with($d, "'")) {
            $d = str_replace("''", "'", substr($d, 1, -1));
        }
        if (preg_match('/^-?[0-9]+\.[0-9]+$/', $d) === 1) {
            $d = rtrim(rtrim($d, '0'), '.');
        }
        return $d === '-0' ? '0' : $d;
    }

    /** A manifest with no tables and no triggers that keeps the hash, ORM directives and external keys of $m. */
    private static function tables(array $m): array
    {
        return ['order' => [], 'entities' => [], 'immutable' => [], 'audit_log' => null, 'audits' => []] + $m;
    }

    /**
     * The column facts of the manifest that the catalog does not hold, as the
     * previous diagram of the import; entities are named by their tables.
     */
    private static function facts(array $want, array $physical): array
    {
        $entities = [];
        foreach ($want['order'] as $name) {
            $columns = [];
            foreach ($want['entities'][$name]['columns'] as $c) {
                $tinyint = str_starts_with(strtolower($c['raw']), 'tinyint');
                $columns[] = ['name' => $c['name'], 'lazy' => $c['lazy'], 'bool' => $c['type'] === 'bool',
                    'int' => $tinyint && $c['type'] !== 'bool' && str_starts_with($c['name'], 'is_'), 'styles' => $c['styles']];
            }
            $entities[] = ['name' => $physical[$name], 'columns' => $columns];
        }
        return ['entities' => $entities, 'relations' => []];
    }
}
