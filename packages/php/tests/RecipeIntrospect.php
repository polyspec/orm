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
    private const CONNECTION_RULES = [
        'mysql' => ["SET time_zone = '+00:00'"],
        'postgres' => ['SET client_min_messages = warning', "SET TimeZone = 'UTC'"],
        'sqlite' => ['PRAGMA foreign_keys = ON'],
    ];

    /**
     * On one native connection of the case database, the connection rules, the rendered documents and the statements of
     * the vector, then the public Dbspec::introspect. A vector with a document compares the emitted document and the
     * unsupported objects; any other requires none unsupported and the schema text of the source. It returns the number
     * of catalog queries, which the expect of the database compares.
     *
     * @param array<string, mixed> $step
     * @param array<string, mixed> $context
     * @return array{queries: int}
     */
    public static function step(RecipeStep $step, array $context): array
    {
        $database = $context['database'];
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
        [, $pdoDsn, $user, $password] = Orm::parseDsn($context['dsn']);
        $pdo = new CountingPdo($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $schema = match ($database) {
            'mysql' => ltrim((string) parse_url($context['dsn'], PHP_URL_PATH), '/'),
            'postgres' => 'public',
            default => 'main',
        };
        foreach ([...self::CONNECTION_RULES[$database], ...$rendered->statements, ...$extra] as $statement) {
            $pdo->exec(str_replace('{schema}', $schema, $statement));
        }
        $pdo->queries = 0;
        $result = Dbspec::introspect($pdo, $database, 'introspected');
        $queries = $pdo->queries;
        $pdo = null;
        if (isset($vector['document'])) {
            $got = Dbspec::emit($result->document);
            if ($got !== implode("\n", $vector['document']) . "\n") {
                throw new RuntimeException("the introspected document differs:\n$got");
            }
            $triples = array_map(static fn($u): array => [$u->kind, $u->table, $u->name], $result->unsupported);
            $want = array_map(static fn(array $entry): array => array_slice($entry, 0, 3), $vector['unsupported']);
            if ($triples !== $want) {
                throw new RuntimeException('unsupported objects ' . json_encode($triples) . ', want ' . json_encode($want));
            }
            foreach ($vector['unsupported'] as $index => $entry) {
                if ($result->unsupported[$index]->reason === '') {
                    throw new RuntimeException("the reason of {$entry[2]} is empty");
                }
                if (isset($entry[3]) && !str_contains($result->unsupported[$index]->reason, $entry[3])) {
                    throw new RuntimeException("the reason of {$entry[2]}: {$result->unsupported[$index]->reason}, want rule {$entry[3]}");
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
     * The empty case database with the catalog queries of another dialect: their failure is the error of the call (DIA-133).
     *
     * @return array{failed: true}
     */
    private static function catalogQueryFailure(string $dialect, string $dsn): array
    {
        [, $pdoDsn, $user, $password] = Orm::parseDsn($dsn);
        $pdo = new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        try {
            Dbspec::introspect($pdo, $dialect, 'introspected');
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
        return $manifest->manifest?->schemaText ?? throw new RuntimeException('manifest: ' . json_encode($manifest->diagnostics));
    }
}
