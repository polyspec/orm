<?php
declare(strict_types=1);
// Polyspec\Orm\Dbspec\Native\Dbspec::introspect of the PHP extension orm_dbspec on
// MySQL, PostgreSQL and SQLite, the same cases as the PHP client's
// packages/php/tests/DbspecIntrospectTest.php: the round trip of every case
// of tests/dbspec/ddl.json and every schema document with the source schema
// text, no unsupported object and one query count per dialect, the
// unsupported cases of tests/dbspec/introspect.json, the unknown dialect and
// a failing catalog query in both error modes. ORM_TEST_MYSQL_DSN and
// ORM_TEST_POSTGRES_DSN name the servers; the test fails when either is
// unset. The DSN is parsed by the PHP client's Orm::parseDsn.

use Polyspec\Orm\Dbspec\Native\Dbspec;
use Polyspec\Orm\Dbspec\Native\Document;
use Polyspec\Orm\Dbspec\Native\Table;
use Polyspec\Orm\Dbspec\Native\Unsupported;
use Polyspec\Orm\Orm;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

/** Counts the catalog queries sent by introspection. */
final class CountingPdo extends PDO
{
    public int $queries = 0;

    public function query(string $query, ?int $fetchMode = null, mixed ...$fetchModeArgs): PDOStatement|false
    {
        $this->queries++;
        return parent::query($query, $fetchMode, ...$fetchModeArgs);
    }
}

// Number of catalog queries per dialect that do not depend on the number of tables (docs/spec/dialects.md "Introspection").
const QUERY_COUNTS = ['mysql' => 9, 'postgres' => 7, 'sqlite' => 3];
// The statement that every client runs on a new connection.
const INTROSPECT_CONNECTION_RULES = ['mysql' => ["SET time_zone = '+00:00'"], 'postgres' => ["SET TimeZone = 'UTC'"], 'sqlite' => ['PRAGMA foreign_keys = ON']];

/** The DSNs of the servers; the test fails when either is unset. */
function introspect_dsns(): array
{
    $dsns = ['mysql' => getenv('ORM_TEST_MYSQL_DSN'), 'postgres' => getenv('ORM_TEST_POSTGRES_DSN')];
    foreach ($dsns as $dsn) {
        if (!is_string($dsn) || $dsn === '') {
            throw new RuntimeException('ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; pass TEST_ENV');
        }
    }
    return $dsns;
}

/**
 * Each case creates a new database, schema, or file, the connection that points at it,
 * and the function that removes it, and returns its name.
 *
 * @return array{0: CountingPdo, 1: Closure(): void, 2: string}
 */
function open_database(string $dialect): array
{
    static $caseIndex = 0;
    $dsns = introspect_dsns();
    $caseIndex++;
    $name = sprintf('dbspec_php_%d_%03d', getmypid(), $caseIndex);
    $options = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION];
    if ($dialect === 'sqlite') {
        $path = sys_get_temp_dir() . "/$name.sqlite";
        if (file_exists($path)) {
            throw new RuntimeException("SQLite file $path already exists");
        }
        $pdo = new CountingPdo("sqlite:$path", null, null, $options);
        return [$pdo, static function () use (&$pdo, $path): void {
            $pdo = null;
            foreach (['', '-journal', '-wal', '-shm'] as $suffix) {
                if (file_exists($path . $suffix) && !unlink($path . $suffix)) {
                    throw new RuntimeException("$path$suffix cannot be removed");
                }
            }
        }, $name];
    }
    [, $pdoDsn, $user, $password] = Orm::parseDsn($dsns[$dialect]);
    $admin = new PDO($pdoDsn, $user, $password, $options);
    $quoted = $dialect === 'mysql' ? "`$name`" : "\"$name\"";
    $admin->exec(($dialect === 'mysql' ? 'CREATE DATABASE ' : 'CREATE SCHEMA ') . $quoted);
    $pdo = new CountingPdo($pdoDsn, $user, $password, $options);
    $pdo->exec($dialect === 'mysql' ? "USE $quoted" : "SET search_path TO $quoted");
    return [$pdo, static function () use (&$pdo, $admin, $dialect, $quoted, $name): void {
        $pdo = null;
        if ($dialect === 'postgres') {
            // A case that needs a second schema makes it as <schema>_b.
            $admin->exec("DROP SCHEMA IF EXISTS \"{$name}_b\" CASCADE");
        }
        $admin->exec(($dialect === 'mysql' ? 'DROP DATABASE ' : 'DROP SCHEMA ') . $quoted . ($dialect === 'mysql' ? '' : ' CASCADE'));
        $left = $dialect === 'mysql'
            ? $admin->prepare('SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN (?, ?)')
            : $admin->prepare('SELECT COUNT(*) FROM pg_namespace WHERE nspname IN (?, ?)');
        $left->execute([$name, $name . '_b']);
        if ((int) $left->fetchColumn() !== 0) {
            throw new RuntimeException("$dialect $name remains after cleanup");
        }
    }, $name];
}

/**
 * Parses every document of the set. Each document can use the other documents.
 *
 * @param array<string, string> $texts
 * @return list<Document>
 */
function parse_set(string $id, array $texts): array
{
    ksort($texts, SORT_STRING);
    $documents = [];
    foreach ($texts as $name => $text) {
        $others = $texts;
        unset($others[$name]);
        $result = Dbspec::parse($text, $others);
        if ($result->document === null) {
            throw new RuntimeException("$id/$name: " . json_encode(array_map(static fn($d) => [$d->rule, $d->line, $d->message], $result->diagnostics)));
        }
        $documents[] = $result->document;
    }
    return $documents;
}

/** @param list<string> $lines */
function lines_text(array $lines): string
{
    return implode("\n", $lines) . "\n";
}

/** @return list<string> */
function render_statements(string $id, array $documents, string $dialect): array
{
    $rendered = Dbspec::render($documents, $dialect);
    return $rendered->statements ?? throw new RuntimeException("$id/$dialect: " . json_encode(array_map(static fn($d) => [$d->rule, $d->line, $d->message], $rendered->diagnostics)));
}

/** The schema text of one document with all the tables of the set in name order. @param list<Document> $documents */
function expected_schema_text(array $documents): string
{
    $combined = new Document('introspected');
    foreach ($documents as $document) {
        array_push($combined->tables, ...$document->tables);
    }
    usort($combined->tables, static fn(Table $a, Table $b): int => strcmp($a->name, $b->name));
    $manifest = Dbspec::manifest([$combined]);
    return $manifest->manifest?->schemaText ?? throw new RuntimeException('manifest: ' . json_encode(array_map(static fn($d) => [$d->rule, $d->message], $manifest->diagnostics)));
}

/**
 * Applies the statement to a new database and introspects it. Returns the result and the query count.
 * {schema} in the statement is the name of that database or schema.
 *
 * @param list<string> $statements
 * @return array{0: Polyspec\Orm\Dbspec\IntrospectResult, 1: int}
 */
function introspect_applied(string $dialect, array $statements): array
{
    [$pdo, $drop, $name] = open_database($dialect);
    try {
        foreach ([...INTROSPECT_CONNECTION_RULES[$dialect], ...$statements] as $statement) {
            $pdo->exec(str_replace('{schema}', $name, $statement));
        }
        $pdo->queries = 0;
        $result = Dbspec::introspect($pdo, $dialect, 'introspected');
        return [$result, $pdo->queries];
    } finally {
        $pdo = null;
        $drop();
    }
}

/** @param list<Unsupported> $unsupported */
function unsupported_entries(array $unsupported): array
{
    return array_map(static fn(Unsupported $u): array => [$u->kind, $u->table, $u->name], $unsupported);
}

// Each case creates a database, schema or file, applies a document set, introspects it and drops it.
#[Medium]
final class DbspecIntrospectTest extends TestCase
{
    // round trip: all cases of ddl.json and all schema documents, in the three dialects.
    public static function roundTripCases(): iterable
    {
        $root = dirname(__DIR__, 3);
        $sets = [];
        $ddl = json_decode(file_get_contents("$root/tests/dbspec/ddl.json"), true, 512, JSON_THROW_ON_ERROR);
        foreach ($ddl['cases'] as $case) {
            $sets['ddl_' . str_replace('-', '_', $case['id'])] = array_map(lines_text(...), $case['documents']);
        }
        // The same list as schemaDocumentPatterns in packages/go/internal/dialects. Each schema document is one set with the
        // documents of its directory that it uses.
        foreach (["$root/contracts/fixtures/bench/*.dbs", "$root/contracts/fixtures/*.dbs"] as $pattern) {
            $paths = [];
            foreach (glob($pattern) ?: throw new RuntimeException("no document matches $pattern") as $path) {
                $paths[basename($path, '.dbs')] = $path;
            }
            foreach ($paths as $name => $path) {
                $others = array_map(static fn(string $other): string => (string) file_get_contents($other), array_diff_key($paths, [$name => true]));
                $document = Dbspec::parse((string) file_get_contents($path), $others)->document ?? throw new RuntimeException("$path does not parse");
                $set = [$name => $path];
                foreach ($document->uses as $use) {
                    $set[$use->document] = $paths[$use->document];
                }
                $sets['schema_' . $name] = $set;
            }
        }
        foreach ($sets as $setId => $texts) {
            foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
                yield "introspect/$dialect/$setId" => [$dialect, $setId, $texts];
            }
        }
    }

    // The documents of a schema set are read here with Dbspec::readFile: the provider names their paths.
    #[DataProvider('roundTripCases')]
    public function test_round_trip(string $dialect, string $setId, array $texts): void
    {
        if (str_starts_with($setId, 'schema_')) {
            foreach ($texts as $name => $path) {
                $read = Dbspec::readFile($path);
                $this->assertNotNull($read->text, "$path: " . json_encode($read->diagnostics));
                $texts[$name] = $read->text;
            }
        }
        $id = "introspect/$dialect/$setId";
        $documents = parse_set($setId, $texts);
        $want = expected_schema_text($documents);
        [$result, $queries] = introspect_applied($dialect, render_statements($id, $documents, $dialect));
        $this->assertSame([], array_map(static fn(Unsupported $u): array => [$u->kind, $u->table, $u->name, $u->reason], $result->unsupported), "$id: unsupported");
        $this->assertSame($want, expected_schema_text([$result->document]), "$id: schema text differs");
        // The catalog query count per dialect, independent of the table count: it is the same for all sets.
        $this->assertSame(QUERY_COUNTS[$dialect], $queries, "$id: introspection query count");
    }

    // Unsupported cases: tests/dbspec/introspect.json.
    public static function unsupportedCases(): iterable
    {
        $vectors = json_decode(file_get_contents(dirname(__DIR__, 3) . '/tests/dbspec/introspect.json'), true, 512, JSON_THROW_ON_ERROR);
        if (($vectors['cases'] ?? []) === []) {
            throw new RuntimeException('Missing introspect vectors');
        }
        foreach ($vectors['cases'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    #[DataProvider('unsupportedCases')]
    public function test_unsupported(array $case): void
    {
        $id = "introspect/{$case['dialect']}/{$case['id']}";
        $documents = parse_set($id, array_map(lines_text(...), $case['documents']));
        $statements = [...render_statements($id, $documents, $case['dialect']), ...$case['statements']];
        [$result] = introspect_applied($case['dialect'], $statements);
        $this->assertSame(lines_text($case['document']), Dbspec::emit($result->document), "$id: document differs");
        $this->assertSame(array_map(static fn(array $w): array => array_slice($w, 0, 3), $case['unsupported']), unsupported_entries($result->unsupported), "$id: unsupported differs");
        // The fourth element is the rule the reason must contain. If absent, the reason is not compared.
        foreach ($case['unsupported'] as $i => $want) {
            if (isset($want[3])) {
                $this->assertStringContainsString($want[3], $result->unsupported[$i]->reason, "$id: reason of " . implode(' ', array_slice($want, 0, 3)) . ' differs');
            }
        }
    }

    public function test_unknown_dialect(): void
    {
        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessage('oracle');
        Dbspec::introspect(new PDO('sqlite::memory:'), 'oracle', 'introspected');
    }

    public static function queryFailureModes(): iterable
    {
        yield 'query-failure-exception' => [PDO::ERRMODE_EXCEPTION];
        yield 'query-failure-silent' => [PDO::ERRMODE_SILENT];
    }

    // A query failure is an error regardless of the connection's error mode.
    #[DataProvider('queryFailureModes')]
    public function test_query_failure(int $mode): void
    {
        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('information_schema');
        Dbspec::introspect(new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => $mode]), 'mysql', 'introspected');
    }
}
