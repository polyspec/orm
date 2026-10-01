<?php
declare(strict_types=1);
// Orm\Dbspec\Dbspec::introspect on MySQL, PostgreSQL and SQLite
// (docs/dialects.md "Introspection"). The round trip renders every case of
// tests/dbspec/ddl.json and every schema document, applies it to an empty
// database of each dialect, introspects it and requires the source schema
// text, no unsupported object and one query count per dialect. The
// unsupported cases run tests/dbspec/introspect.json. ORM_TEST_MYSQL_DSN and
// ORM_TEST_POSTGRES_DSN name the servers; the test fails when either is unset.
// Each case creates and drops its own database, schema or file.
// Usage: php clients/php/tests/dbspec_introspect_test.php
require __DIR__ . '/autoload.php';

use Orm\Dbspec\Dbspec;
use Orm\Dbspec\Document;
use Orm\Dbspec\Table;
use Orm\Dbspec\Unsupported;
use Orm\Orm;

/** introspection 이 보낸 catalog query 수를 센다. */
final class CountingPdo extends PDO
{
    public int $queries = 0;

    public function query(string $query, ?int $fetchMode = null, mixed ...$fetchModeArgs): PDOStatement|false
    {
        $this->queries++;
        return parent::query($query, $fetchMode, ...$fetchModeArgs);
    }
}

const CASE_DEADLINE_MS = 60000;
// dialect 마다 table 수와 무관한 catalog query 수 (docs/dialects.md "Introspection").
const QUERY_COUNTS = ['mysql' => 9, 'postgres' => 7, 'sqlite' => 3];
// 모든 client 가 새 connection 에서 실행하는 statement.
const CONNECTION_RULES = ['mysql' => ["SET time_zone = '+00:00'"], 'postgres' => ["SET TimeZone = 'UTC'"], 'sqlite' => ['PRAGMA foreign_keys = ON']];

$started = hrtime(true);
echo "RUN dbspec_introspect\n";
$root = dirname(__DIR__, 3);
$dsns = ['mysql' => getenv('ORM_TEST_MYSQL_DSN'), 'postgres' => getenv('ORM_TEST_POSTGRES_DSN')];
foreach ($dsns as $dialect => $dsn) {
    if (!is_string($dsn) || $dsn === '') {
        throw new RuntimeException('ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; pass TEST_ENV');
    }
}
$run = 'dbspec_php_' . getmypid();
$caseIndex = 0;

/**
 * case 마다 새 database, schema 또는 file 을 만들고 그곳을 가리키는 connection 과
 * 그것을 지우는 함수를 돌려준다.
 *
 * @return array{0: CountingPdo, 1: Closure(): void}
 */
function open_database(string $dialect): array
{
    global $dsns, $run, $caseIndex;
    $caseIndex++;
    $name = sprintf('%s_%03d', $run, $caseIndex);
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
        }];
    }
    [, $pdoDsn, $user, $password] = Orm::parseDsn($dsns[$dialect]);
    $admin = new PDO($pdoDsn, $user, $password, $options);
    $quoted = $dialect === 'mysql' ? "`$name`" : "\"$name\"";
    $admin->exec(($dialect === 'mysql' ? 'CREATE DATABASE ' : 'CREATE SCHEMA ') . $quoted);
    $pdo = new CountingPdo($pdoDsn, $user, $password, $options);
    $pdo->exec($dialect === 'mysql' ? "USE $quoted" : "SET search_path TO $quoted");
    return [$pdo, static function () use (&$pdo, $admin, $dialect, $quoted, $name): void {
        $pdo = null;
        $admin->exec(($dialect === 'mysql' ? 'DROP DATABASE ' : 'DROP SCHEMA ') . $quoted . ($dialect === 'mysql' ? '' : ' CASCADE'));
        $left = $dialect === 'mysql'
            ? $admin->prepare('SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?')
            : $admin->prepare('SELECT COUNT(*) FROM pg_namespace WHERE nspname = ?');
        $left->execute([$name]);
        if ((int) $left->fetchColumn() !== 0) {
            throw new RuntimeException("$dialect $name remains after cleanup");
        }
    }];
}

/**
 * 집합의 모든 문서를 parse 한다. 각 문서는 나머지 문서를 사용할 수 있다.
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

/** 집합의 모든 table 을 이름 순으로 담은 한 문서의 schema text. @param list<Document> $documents */
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
 * 새 database 에 statement 를 적용하고 introspect 한다. 결과와 query 수를 돌려준다.
 *
 * @param list<string> $statements
 * @return array{0: Orm\Dbspec\IntrospectResult, 1: int}
 */
function introspect_applied(string $dialect, array $statements): array
{
    [$pdo, $drop] = open_database($dialect);
    try {
        foreach ([...CONNECTION_RULES[$dialect], ...$statements] as $statement) {
            $pdo->exec($statement);
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

function finish_case(string $id, int $caseStarted): void
{
    $elapsed = (hrtime(true) - $caseStarted) / 1e6;
    if ($elapsed > CASE_DEADLINE_MS) {
        throw new RuntimeException("$id: deadline of " . CASE_DEADLINE_MS . " ms exceeded ($elapsed ms)");
    }
    echo "PASS $id elapsedMs=$elapsed\n";
}

// round trip: ddl.json 의 모든 case 와 모든 schema 문서.
$sets = [];
$ddl = json_decode(file_get_contents("$root/tests/dbspec/ddl.json"), true, 512, JSON_THROW_ON_ERROR);
foreach ($ddl['cases'] as $case) {
    $sets['ddl_' . str_replace('-', '_', $case['id'])] = array_map(lines_text(...), $case['documents']);
}
// tests/dialects 의 schemaDocumentPatterns 와 같은 목록.
foreach (["$root/schema/*.dbspec", "$root/contracts/fixtures/*.dbspec"] as $pattern) {
    foreach (glob($pattern) ?: throw new RuntimeException("no document matches $pattern") as $path) {
        $name = basename($path, '.dbspec');
        $sets["schema_$name"] = [$name => file_get_contents($path)];
    }
}
$counts = [];
$roundTrips = 0;
foreach ($sets as $setId => $texts) {
    $documents = parse_set($setId, $texts);
    $want = expected_schema_text($documents);
    foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
        $id = "introspect/$dialect/$setId";
        echo "RUN $id\n";
        $caseStarted = hrtime(true);
        [$result, $queries] = introspect_applied($dialect, render_statements($id, $documents, $dialect));
        $counts[$dialect][$queries][] = $setId;
        if ($result->unsupported !== []) {
            throw new RuntimeException("$id: unsupported " . json_encode(array_map(static fn(Unsupported $u): array => [$u->kind, $u->table, $u->name, $u->reason], $result->unsupported)));
        }
        $got = expected_schema_text([$result->document]);
        if ($got !== $want) {
            throw new RuntimeException("$id: schema text differs\n--- want\n$want--- got\n$got");
        }
        $roundTrips++;
        finish_case($id, $caseStarted);
    }
}
foreach (QUERY_COUNTS as $dialect => $expected) {
    if (array_keys($counts[$dialect]) !== [$expected]) {
        throw new RuntimeException("$dialect: introspection query counts " . json_encode(array_map('count', $counts[$dialect])) . " differ from $expected for every set");
    }
    echo "PASS introspect/$dialect queries=$expected sets=" . count($counts[$dialect][$expected]) . "\n";
}

// 미지원 case: tests/dbspec/introspect.json.
$vectors = json_decode(file_get_contents("$root/tests/dbspec/introspect.json"), true, 512, JSON_THROW_ON_ERROR);
if (($vectors['cases'] ?? []) === []) {
    throw new RuntimeException('Missing introspect vectors');
}
foreach ($vectors['cases'] as $case) {
    $id = "introspect/{$case['dialect']}/{$case['id']}";
    echo "RUN $id\n";
    $caseStarted = hrtime(true);
    $documents = parse_set($id, array_map(lines_text(...), $case['documents']));
    $statements = [...render_statements($id, $documents, $case['dialect']), ...$case['statements']];
    [$result] = introspect_applied($case['dialect'], $statements);
    $want = lines_text($case['document']);
    $got = Dbspec::emit($result->document);
    if ($got !== $want) {
        throw new RuntimeException("$id: document differs\n--- want\n$want--- got\n$got");
    }
    if (unsupported_entries($result->unsupported) !== $case['unsupported']) {
        throw new RuntimeException("$id: unsupported differs\nwant " . json_encode($case['unsupported']) . "\ngot  " . json_encode(array_map(static fn(Unsupported $u): array => [$u->kind, $u->table, $u->name, $u->reason], $result->unsupported)));
    }
    finish_case($id, $caseStarted);
}

echo "RUN introspect/unknown-dialect\n";
try {
    Dbspec::introspect(new PDO('sqlite::memory:'), 'oracle', 'introspected');
    throw new RuntimeException('unknown dialect oracle was accepted');
} catch (InvalidArgumentException $e) {
    if (!str_contains($e->getMessage(), 'oracle')) {
        throw new RuntimeException('unknown dialect message does not name it: ' . $e->getMessage());
    }
}
echo "PASS introspect/unknown-dialect\n";

// query 실패는 connection 의 error mode 와 무관하게 error 다.
foreach ([PDO::ERRMODE_EXCEPTION => 'exception', PDO::ERRMODE_SILENT => 'silent'] as $mode => $label) {
    echo "RUN introspect/query-failure-$label\n";
    try {
        Dbspec::introspect(new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => $mode]), 'mysql', 'introspected');
        throw new LogicException("a failing catalog query in $label mode was not reported");
    } catch (RuntimeException $e) {
        if (!str_contains($e->getMessage(), 'information_schema')) {
            throw new LogicException("query failure in $label mode does not name the query: " . $e->getMessage());
        }
    }
    echo "PASS introspect/query-failure-$label\n";
}

echo 'PASS dbspec_introspect roundTrips=' . $roundTrips . ' sets=' . count($sets) . ' unsupportedCases=' . count($vectors['cases']) . ' elapsedMs=' . ((hrtime(true) - $started) / 1e6) . "\n";
