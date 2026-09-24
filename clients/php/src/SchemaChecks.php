<?php
declare(strict_types=1);

namespace Orm;

/**
 * MySQL and PostgreSQL store a CHECK expression in their own normalized form,
 * so the text read from the catalog differs from the declared expression. To
 * compare them, the declared expression is created on a temporary table of
 * the same database and read back through the same catalog path; SQLite
 * keeps the text it was given, so its form is the rendered DDL text.
 */
final class SchemaChecks
{
    private const PROBE = '__orm_check_probe';

    /**
     * Replaces the expression of every live check that is equivalent to the
     * declared check of the same name with the declared text, so a diff
     * reports only real changes. A changed live manifest gets the hash of its
     * new content, so a plan that stores it stays self-consistent.
     */
    public static function alignLive(\PDO $db, string $driver, array &$live, array $want): void
    {
        $changed = false;
        foreach ($want['entities'] as $name => $declared) {
            if ($declared['checks'] === []) {
                continue;
            }
            $key = isset($live['entities'][$name]) ? $name : null;
            if ($key === null) {
                foreach ($live['entities'] as $candidateName => $candidate) {
                    if ($candidate['table'] === SchemaDdl::table($declared['table'], $driver)) {
                        $key = $candidateName;
                    }
                }
            }
            if ($key === null || $live['entities'][$key]['checks'] === []) {
                continue;
            }
            try {
                $canonical = self::canonical($db, $driver, $declared);
            } catch (\Throwable $e) {
                throw new \RuntimeException("table {$declared['table']}: normalize CHECK expressions: " . $e->getMessage());
            }
            foreach ($live['entities'][$key]['checks'] as $i => $current) {
                foreach ($declared['checks'] as $j => $check) {
                    if ($check['name'] === $current['name'] && $canonical[$j] === $current['expr'] && $current['expr'] !== $check['expr']) {
                        $live['entities'][$key]['checks'][$i]['expr'] = $check['expr'];
                        $changed = true;
                    }
                }
            }
        }
        if ($changed) {
            $live['schema_hash'] = SchemaBuilder::hash($live);
        }
    }

    /**
     * Aligns the checks of a db: source with the other side of a diff, which
     * is compared in that database.
     */
    public static function alignSources(string $fromPath, string $toPath, array &$from, array &$to): void
    {
        foreach ([[$fromPath, &$from, $to], [$toPath, &$to, $from]] as [$source, &$live, $want]) {
            if (!str_starts_with($source, 'db:')) {
                continue;
            }
            [$dialect, $db] = SchemaImport::connect(substr($source, 3));
            self::alignLive($db, $dialect, $live, $want);
        }
    }

    /**
     * The catalog form of each declared check of an entity, in declaration order.
     * @return list<string>
     */
    private static function canonical(\PDO $db, string $driver, array $e): array
    {
        $quote = $driver === 'mysql' ? static fn(string $s): string => '`' . $s . '`' : static fn(string $s): string => '"' . $s . '"';
        $exprs = [];
        foreach ($e['checks'] as $check) {
            $exprs[] = SchemaDdl::renderedCheckExpression($check['expr'], $driver, $quote);
        }
        if ($driver === 'sqlite') {
            return $exprs;
        }
        $lines = [];
        foreach ($e['columns'] as $c) {
            $c['auto'] = false;
            $lines[] = SchemaDdl::column($c, $driver, $quote);
        }
        foreach ($exprs as $i => $expr) {
            $lines[] = 'CONSTRAINT ' . $quote(self::name($i)) . " CHECK ($expr)";
        }
        $db->exec('CREATE TEMPORARY TABLE ' . $quote(self::PROBE) . ' (' . implode(', ', $lines) . ')');
        try {
            $byName = [];
            if ($driver === 'mysql') {
                $text = (string) $db->query('SHOW CREATE TABLE ' . $quote(self::PROBE))->fetch(\PDO::FETCH_NUM)[1];
                foreach ($exprs as $i => $_) {
                    $marker = 'CONSTRAINT ' . $quote(self::name($i)) . ' CHECK ';
                    $at = strpos($text, $marker);
                    if ($at === false) {
                        throw new \RuntimeException("check {$e['checks'][$i]['name']} is missing from the probe table");
                    }
                    $open = $at + strlen($marker);
                    $end = SchemaImport::balancedParen($text, $open);
                    $byName[self::name($i)] = substr($text, $open + 1, $end - $open - 1);
                }
            } else {
                $rows = $db->query("SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'pg_temp." . self::PROBE . "'::regclass AND contype = 'c'");
                foreach ($rows->fetchAll(\PDO::FETCH_NUM) as [$name, $definition]) {
                    $byName[$name] = SchemaImport::postgresCheckExpr($definition);
                }
            }
            $out = [];
            foreach ($exprs as $i => $_) {
                if (!isset($byName[self::name($i)])) {
                    throw new \RuntimeException("check {$e['checks'][$i]['name']} is missing from the probe table");
                }
                $out[] = $byName[self::name($i)];
            }
            return $out;
        } finally {
            $db->exec('DROP TABLE IF EXISTS ' . $quote(self::PROBE));
        }
    }

    private static function name(int $i): string
    {
        return '__orm_check_probe_' . ($i + 1);
    }
}
