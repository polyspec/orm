<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Document;
use Polyspec\Orm\Dbspec\Table;
use Polyspec\Orm\Orm;
use RuntimeException;

/** The dbspec.introspect op (docs/spec/feature-coverage.md FCV-4, DIA-133, DIA-198) of the recipe runner. */
final class RecipeIntrospect
{
    /** The SQL dialect of a case database: a corpus runs SQL in SQLite's (DIA-185), and MariaDB in MySQL's (DIA-200). */
    private const DIALECT_OF = ['markdown' => 'sqlite', 'mariadb' => 'mysql'];

    private const CONNECTION_RULES = [
        'mysql' => ["SET time_zone = '+00:00'"],
        'postgres' => ['SET client_min_messages = warning', "SET TimeZone = 'UTC'"],
        'sqlite' => ['PRAGMA foreign_keys = ON'],
    ];

    /**
     * On one native connection of the case database, the connection rules, the rendered documents and the statements of
     * the vector, then the public Dbspec::introspect. A vector with a document compares the emitted document and the
     * unsupported objects; any other requires none unsupported and the schema text of the source. It returns the number
     * of catalog queries, which the expect of the database compares. Where that expect names refused, a statement of
     * the vector that the server refuses ends the step with the server's error number, which the expect compares; a
     * refusal elsewhere, and of a statement other than the vector's, is an error (DIA-200, rule 4).
     *
     * @param array<string, mixed> $step
     * @param array<string, mixed> $context
     * @return array{queries: int}|array{refused: int}
     */
    public static function step(RecipeStep $step, array $context): array
    {
        // A corpus runs SQL in SQLite's dialect (DIA-185): its native session is its flowmark server's, and its SQL is
        // SQLite's; MariaDB runs SQL in MySQL's (DIA-200).
        $markdown = $context['database'] === 'markdown';
        $database = self::DIALECT_OF[$context['database']] ?? $context['database'];
        $server = self::server($context['database']);
        if (isset($step['catalog_of'])) {
            return self::catalogQueryFailure($step['catalog_of'], $context['dsn']);
        }
        [$texts, $vector] = self::source($step, $context['dir']);
        $documents = self::parseSet($texts);
        $rendered = Dbspec::render($documents, $database);
        if ($rendered->statements === null) {
            throw new RuntimeException('render: ' . json_encode($rendered->diagnostics));
        }
        // tests/dbspec/ddl.json holds the rendered statements of each dialect as an object; only a list runs.
        $extra = $vector['statements'] ?? [];
        $extra = array_is_list($extra) ? $extra : [];
        if ($markdown) {
            $pdo = CountingPdo::over(markdown_session_pdo($context['dsn']));
        } else {
            [, $pdoDsn, $user, $password] = Orm::parseDsn($context['dsn']);
            $pdo = new CountingPdo($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        }
        $schema = match ($database) {
            'mysql' => ltrim((string) parse_url($context['dsn'], PHP_URL_PATH), '/'),
            'postgres' => 'public',
            default => 'main',
        };
        foreach ([...self::CONNECTION_RULES[$database], ...$rendered->statements] as $statement) {
            $pdo->exec(str_replace('{schema}', $schema, $statement));
        }
        $refusable = self::refusable($step, $context['database']);
        foreach ($extra as $statement) {
            try {
                $pdo->exec(str_replace('{schema}', $schema, $statement));
            } catch (\PDOException $error) {
                // A refusal is an error of a server of the MySQL protocol, which pdo_mysql gives as the second field of
                // errorInfo; the driver of the connection decides it, not the name of the database, as in every runtime
                // (DIA-200, rule 1).
                $number = $error->errorInfo[1] ?? null;
                if ($refusable && $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql' && is_int($number)) {
                    return ['refused' => $number];
                }
                throw $error;
            }
        }
        if ($refusable) {
            throw new RuntimeException(
                "the statements of vector {$step['case']} ran on {$context['database']}, "
                    . 'whose expect names their refusal'
            );
        }
        $pdo->queries = 0;
        $result = Dbspec::introspect($pdo, $database, $server, 'introspected');
        $queries = $pdo->queries;
        $pdo = null;
        // A vector may hold what MariaDB answers where the server itself answers otherwise, in place of its document
        // and unsupported objects (DIA-200, rule 4).
        if ($context['database'] === 'mariadb' && isset($vector['mariadb'])) {
            $vector['document'] = $vector['mariadb']['document'] ?? null;
            $vector['unsupported'] = $vector['mariadb']['unsupported'] ?? null;
        }
        if (isset($vector['document'])) {
            $got = Dbspec::emit($result->document);
            if ($got !== implode("\n", $vector['document']) . "\n") {
                throw new RuntimeException("the introspected document differs:\n$got");
            }
            $triples = array_map(static fn($u): array => [$u->kind, $u->table, $u->name], $result->unsupported);
            $want = array_map(static fn(array $entry): array => array_slice($entry, 0, 3), $vector['unsupported']);
            if ($triples !== $want) {
                throw new RuntimeException(
                    'unsupported objects ' . json_encode($triples) . ', want ' . json_encode($want)
                );
            }
            foreach ($vector['unsupported'] as $index => $entry) {
                if ($result->unsupported[$index]->reason === '') {
                    throw new RuntimeException("the reason of {$entry[2]} is empty");
                }
                if (isset($entry[3]) && !str_contains($result->unsupported[$index]->reason, $entry[3])) {
                    throw new RuntimeException(
                        "the reason of {$entry[2]}: {$result->unsupported[$index]->reason}, want rule {$entry[3]}"
                    );
                }
            }
            return ['queries' => $queries];
        }
        if ($result->unsupported !== []) {
            throw new RuntimeException('unsupported objects ' . json_encode($result->unsupported));
        }
        $got = self::schemaText([$result->document]);
        $want = self::schemaText($documents);
        if ($got !== $want) {
            throw new RuntimeException("the schema text differs:\n$got\nwant\n$want");
        }
        return ['queries' => $queries];
    }

    /**
     * On one native connection of the case database (PLN-102): the connection rules, the rendered source and the before
     * steps; the plan steps before finalize, on SQLite with foreign keys off and no row of foreign_key_check, and the
     * public Dbspec::introspect reads the target with nothing unsupported; without an irreversible step, the rollback
     * statements return to the source and the steps run again; then the after steps and the finalize steps run, the
     * target is read again and no table or column named dbspec$ remains.
     *
     * @param array<string, mixed> $context
     * @return array{}
     */
    public static function planPhysical(RecipeStep $step, array $context): array
    {
        // A corpus runs SQL in SQLite's dialect (DIA-185): its native session is its flowmark server's (case_admin);
        // MariaDB runs SQL in MySQL's (DIA-200).
        $database = self::DIALECT_OF[$context['database']] ?? $context['database'];
        $id = $step['case'];
        $matching = array_values(array_filter(
            plan_vectors_at($context['dir'] . '/' . $step['vectors'])['cases'],
            static fn(array $c): bool => $c['id'] === $id
        ));
        if ($matching === []) {
            throw new RuntimeException("the vectors have no case $id");
        }
        $vector = $matching[0];
        $parsed = Dbspec::parsePlan(dbspec_plan_text($vector['plan']));
        $plan = $parsed->plan ?? throw new RuntimeException('the plan: ' . plan_diagnostics($parsed->diagnostics));
        $target = self::planSchemaText($plan->schema);
        $source = null;
        $setup = [];
        $sourceText = '';
        if (isset($vector['source'])) {
            $sourceParse = Dbspec::parse(dbspec_plan_text($vector['source']), []);
            $source = $sourceParse->document
                ?? throw new RuntimeException('the source: ' . plan_diagnostics($sourceParse->diagnostics));
            $rendered = Dbspec::render([$source], $database);
            $setup = $rendered->statements
                ?? throw new RuntimeException('the render of the source: ' . plan_diagnostics($rendered->diagnostics));
            $sourceText = self::planSchemaText($source);
        }
        $planned = Dbspec::planSteps($source, $plan, $database);
        $steps = $planned->steps ?? throw new RuntimeException(
            'the plan steps: ' . plan_diagnostics($planned->diagnostics)
        );
        $reversible = true;
        foreach ($steps as $planStep) {
            if (!$planStep->finalize && $planStep->rollback === '') {
                $reversible = false;
            }
        }
        $sqlite = $database === 'sqlite';
        $pdo = case_admin($context['dsn']);
        $behavior = static function (array $entries) use ($pdo, $database): void {
            foreach ($entries as $entry) {
                if (isset($entry['dialects']) && !in_array($database, $entry['dialects'], true)) {
                    continue;
                }
                if (isset($entry['query'])) {
                    $got = dbspec_value($pdo, $entry['query']);
                    if ($got !== $entry['want']) {
                        throw new RuntimeException("{$entry['query']}: got $got, want {$entry['want']}");
                    }
                    continue;
                }
                try {
                    $pdo->exec($entry['sql']);
                } catch (\PDOException $error) {
                    if (!($entry['fails'] ?? false)) {
                        throw new RuntimeException("{$entry['sql']}: {$error->getMessage()}", 0, $error);
                    }
                    continue;
                }
                if ($entry['fails'] ?? false) {
                    throw new RuntimeException("{$entry['sql']} must fail");
                }
            }
        };
        $foreignKeys = static function () use ($pdo, $sqlite): void {
            if ($sqlite) {
                $violations = dbspec_value($pdo, 'SELECT COUNT(*) FROM pragma_foreign_key_check');
                if ($violations !== '0') {
                    throw new RuntimeException("foreign_key_check returns $violations rows");
                }
            }
        };
        $server = self::server($context['database']);
        $schemaIs = static function (string $what, string $want) use ($pdo, $database, $server): void {
            $result = Dbspec::introspect($pdo, $database, $server, 'introspected');
            if ($result->unsupported !== []) {
                throw new RuntimeException("$what: unsupported objects " . json_encode($result->unsupported));
            }
            $got = $result->document->tables !== [] ? self::planSchemaText($result->document) : '';
            if ($got !== $want) {
                throw new RuntimeException("$what: the schema text differs\n--- want\n$want--- got\n$got");
            }
        };
        $forward = static function (bool $restore) use ($pdo, $steps, $foreignKeys): void {
            foreach ($steps as $planStep) {
                if ($planStep->finalize) {
                    break;
                }
                $pdo->exec($restore && $planStep->restore !== '' ? $planStep->restore : $planStep->statement);
            }
            $foreignKeys();
        };
        foreach ([...self::CONNECTION_RULES[$database], ...$setup] as $statement) {
            $pdo->exec($statement);
        }
        $behavior($vector['before'] ?? []);
        // SQLite turns foreign keys off while it recreates a table, and checks them afterwards.
        if ($sqlite) {
            $pdo->exec('PRAGMA foreign_keys = OFF');
            $pdo->exec('PRAGMA legacy_alter_table = OFF');
        }
        $forward(false);
        $schemaIs('applied', $target);
        if ($reversible) {
            // A rollback that goes all the way back recreates the old table with the added column hidden.
            foreach (array_reverse($steps) as $planStep) {
                if (!$planStep->finalize) {
                    $pdo->exec($planStep->rollbackRestore !== '' ? $planStep->rollbackRestore : $planStep->rollback);
                }
            }
            $foreignKeys();
            $schemaIs('rolled back', $sourceText);
            $forward(true);
            $schemaIs('applied again', $target);
        }
        if ($sqlite) {
            $pdo->exec('PRAGMA foreign_keys = ON');
        }
        $behavior($vector['after'] ?? []);
        // Finalize also runs with SQLite foreign keys off, as apply does: hidden tables can reference each other.
        if ($sqlite) {
            $pdo->exec('PRAGMA foreign_keys = OFF');
        }
        foreach ($steps as $planStep) {
            if ($planStep->finalize) {
                $pdo->exec($planStep->statement);
            }
        }
        $foreignKeys();
        if ($sqlite) {
            $pdo->exec('PRAGMA foreign_keys = ON');
        }
        $schemaIs('finalized', $target);
        $hidden = dbspec_value($pdo, match ($database) {
            'mysql' => "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND "
                . "(TABLE_NAME LIKE 'dbspec\$%' OR COLUMN_NAME LIKE 'dbspec\$%')",
            'postgres' => "SELECT COUNT(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE "
                . "c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND "
                . "(c.relname LIKE 'dbspec\$%' OR a.attname LIKE 'dbspec\$%')",
            default => "SELECT COUNT(*) FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = "
                . "'table' AND (m.name LIKE 'dbspec\$%' OR p.name LIKE 'dbspec\$%')",
        });
        if ($hidden !== '0') {
            throw new RuntimeException("$hidden tables or columns named dbspec\$ remain after finalize");
        }
        return [];
    }

    /**
     * The server of a case database that the public dbspec calls take (DIA-203): a corpus answers in SQLite's dialect,
     * as its server.
     */
    private static function server(string $database): string
    {
        return $database === 'markdown' ? 'sqlite' : $database;
    }

    /**
     * Whether the expect of dbspec.introspect on database names refused: on the entry of database, or else of its
     * dialect.
     */
    private static function refusable(RecipeStep $step, string $database): bool
    {
        $expect = $step['expect'] ?? [];
        $key = array_key_exists($database, $expect) ? $database : (self::DIALECT_OF[$database] ?? $database);
        $outcome = $expect[$key] ?? null;
        return $outcome !== null && isset($outcome['refused']);
    }

    /** The schema text of one document. */
    private static function planSchemaText(Document $document): string
    {
        $manifest = Dbspec::manifest([$document]);
        return $manifest->manifest?->schemaText
            ?? throw new RuntimeException('the manifest is refused: ' . plan_diagnostics($manifest->diagnostics));
    }

    /**
     * The empty case database with the catalog queries of another dialect: their failure is the error of the call
     * (DIA-133).
     *
     * @return array{failed: true}
     */
    private static function catalogQueryFailure(string $dialect, string $dsn): array
    {
        $pdo = case_admin($dsn);
        try {
            Dbspec::introspect($pdo, $dialect, $dialect, 'introspected');
        } catch (RuntimeException) {
            return ['failed' => true];
        }
        throw new RuntimeException("the $dialect catalog queries did not fail");
    }

    /**
     * The documents of a step by name and its vector, which is empty for a step with paths.
     *
     * @param array<string, mixed> $step
     * @return array{0: array<string, string>, 1: array<string, mixed>}
     */
    private static function source(RecipeStep $step, string $dir): array
    {
        $texts = [];
        if (isset($step['paths'])) {
            foreach ($step['paths'] as $path) {
                $read = Dbspec::readFile("$dir/$path");
                if ($read->text === null) {
                    throw new RuntimeException("$path: " . json_encode($read->diagnostics));
                }
                $texts[basename($path, '.dbs')] = $read->text;
            }
            return [$texts, []];
        }
        $vectors = json_decode((string) file_get_contents("$dir/{$step['vectors']}"), true, 512, JSON_THROW_ON_ERROR);
        foreach ($vectors['cases'] as $vector) {
            if ($vector['id'] === $step['case']) {
                foreach ($vector['documents'] as $name => $lines) {
                    $texts[$name] = implode("\n", $lines) . "\n";
                }
                return [$texts, $vector];
            }
        }
        throw new RuntimeException("the vectors have no case {$step['case']}");
    }

    /**
     * @param array<string, string> $texts
     * @return list<Document>
     */
    private static function parseSet(array $texts): array
    {
        ksort($texts, SORT_STRING);
        $documents = [];
        foreach ($texts as $name => $text) {
            $others = $texts;
            unset($others[$name]);
            $result = Dbspec::parse($text, $others);
            if ($result->document === null) {
                throw new RuntimeException("$name: " . json_encode($result->diagnostics));
            }
            $documents[] = $result->document;
        }
        return $documents;
    }

    /**
     * The schema text of one document that holds the tables of documents in name order.
     *
     * @param list<Document> $documents
     */
    private static function schemaText(array $documents): string
    {
        $combined = new Document('introspected');
        foreach ($documents as $document) {
            array_push($combined->tables, ...$document->tables);
        }
        usort($combined->tables, static fn(Table $a, Table $b): int => strcmp($a->name, $b->name));
        $manifest = Dbspec::manifest([$combined]);
        return $manifest->manifest?->schemaText ?? throw new RuntimeException(
            'manifest: ' . json_encode($manifest->diagnostics)
        );
    }
}
