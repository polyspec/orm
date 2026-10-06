<?php
declare(strict_types=1);
// Orm\Dbspec\Native\Dbspec::introspect of the PHP extension orm_dbspec on
// MySQL, PostgreSQL and SQLite, the same cases as the PHP client's
// clients/php/tests/dbspec_introspect_test.php: the round trip of every case
// of tests/dbspec/ddl.json and every schema document with the source schema
// text, no unsupported object and one query count per dialect, the
// unsupported cases of tests/dbspec/introspect.json, the unknown dialect and
// a failing catalog query in both error modes. ORM_TEST_MYSQL_DSN and
// ORM_TEST_POSTGRES_DSN name the servers; the test fails when either is
// unset. The DSN is parsed by the PHP client's Orm::parseDsn.
// Usage: php -d extension=<orm_dbspec library> clients/php-extension/tests/dbspec_introspect_test.php
require dirname(__DIR__, 2) . '/php/tests/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

if (!extension_loaded('orm_dbspec')) {
    fwrite(STDERR, "the extension orm_dbspec is not loaded; run make dbspec-introspect-php-extension-check, which builds and loads it\n");
    exit(1);
}

use Orm\Dbspec\Native\Dbspec;
use Orm\Dbspec\Native\Document;
use Orm\Dbspec\Native\Table;
use Orm\Dbspec\Native\Unsupported;
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

// CASE_DEADLINE_MS는 case 하나의 기한이다. case는 database 하나를 만들고 문서 집합을 적용해
// introspect한 뒤 지운다.
const CASE_DEADLINE_MS = 60000;
// dialect 마다 table 수와 무관한 catalog query 수 (docs/dialects.md "Introspection").
const QUERY_COUNTS = ['mysql' => 9, 'postgres' => 7, 'sqlite' => 3];
// 모든 client 가 새 connection 에서 실행하는 statement.
const CONNECTION_RULES = ['mysql' => ["SET time_zone = '+00:00'"], 'postgres' => ["SET TimeZone = 'UTC'"], 'sqlite' => ['PRAGMA foreign_keys = ON']];

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
 * case 마다 새 database, schema 또는 file 을 만들고 그곳을 가리키는 connection,
 * 그것을 지우는 함수와 그 이름을 돌려준다.
 *
 * @return array{0: CountingPdo, 1: Closure(): void, 2: string}
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
            // 두 번째 schema 가 필요한 case 는 그것을 <schema>_b 로 만든다.
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
 * statement 의 {schema} 는 그 database 또는 schema 의 이름이다.
 *
 * @param list<string> $statements
 * @return array{0: Orm\Dbspec\IntrospectResult, 1: int}
 */
function introspect_applied(string $dialect, array $statements): array
{
    [$pdo, $drop, $name] = open_database($dialect);
    try {
        foreach ([...CONNECTION_RULES[$dialect], ...$statements] as $statement) {
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

function finish_case(string $id): void
{
    testcase_end();
}

// round trip: ddl.json 의 모든 case 와 모든 schema 문서.
$sets = [];
$ddl = json_decode(file_get_contents("$root/tests/dbspec/ddl.json"), true, 512, JSON_THROW_ON_ERROR);
foreach ($ddl['cases'] as $case) {
    $sets['ddl_' . str_replace('-', '_', $case['id'])] = array_map(lines_text(...), $case['documents']);
}
// tests/dialects 의 schemaDocumentPatterns 와 같은 목록.
foreach (["$root/schema/*.dbs", "$root/contracts/fixtures/*.dbs"] as $pattern) {
    foreach (glob($pattern) ?: throw new RuntimeException("no document matches $pattern") as $path) {
        $name = basename($path, '.dbs');
        $read = Dbspec::readFile($path);
        if ($read->text === null) {
            throw new RuntimeException("$path: " . json_encode($read->diagnostics));
        }
        $sets["schema_$name"] = [$name => $read->text];
    }
}
$counts = [];
$roundTrips = 0;
foreach ($sets as $setId => $texts) {
    $documents = parse_set($setId, $texts);
    $want = expected_schema_text($documents);
    foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
        $id = "introspect/$dialect/$setId";
        testcase_begin($id, CASE_DEADLINE_MS / 1000);
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
        finish_case($id);
    }
}
foreach (QUERY_COUNTS as $dialect => $expected) {
    testcase_begin("introspect/$dialect/queries", TESTCASE_COMPUTE);
    if (array_keys($counts[$dialect]) !== [$expected]) {
        throw new RuntimeException("$dialect: introspection query counts " . json_encode(array_map('count', $counts[$dialect])) . " differ from $expected for every set");
    }
    testcase_step("queries=$expected sets=" . count($counts[$dialect][$expected]));
    testcase_end();
}

// 미지원 case: tests/dbspec/introspect.json.
$vectors = json_decode(file_get_contents("$root/tests/dbspec/introspect.json"), true, 512, JSON_THROW_ON_ERROR);
if (($vectors['cases'] ?? []) === []) {
    throw new RuntimeException('Missing introspect vectors');
}
foreach ($vectors['cases'] as $case) {
    $id = "introspect/{$case['dialect']}/{$case['id']}";
    testcase_begin($id, CASE_DEADLINE_MS / 1000);
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
    finish_case($id);
}

testcase_begin('introspect/unknown-dialect', TESTCASE_COMPUTE);
try {
    Dbspec::introspect(new PDO('sqlite::memory:'), 'oracle', 'introspected');
    throw new RuntimeException('unknown dialect oracle was accepted');
} catch (InvalidArgumentException $e) {
    if (!str_contains($e->getMessage(), 'oracle')) {
        throw new RuntimeException('unknown dialect message does not name it: ' . $e->getMessage());
    }
}
testcase_end();

// query 실패는 connection 의 error mode 와 무관하게 error 다.
foreach ([PDO::ERRMODE_EXCEPTION => 'exception', PDO::ERRMODE_SILENT => 'silent'] as $mode => $label) {
    testcase_begin("introspect/query-failure-$label", TESTCASE_COMPUTE);
    try {
        Dbspec::introspect(new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => $mode]), 'mysql', 'introspected');
        throw new LogicException("a failing catalog query in $label mode was not reported");
    } catch (RuntimeException $e) {
        if (!str_contains($e->getMessage(), 'information_schema')) {
            throw new LogicException("query failure in $label mode does not name the query: " . $e->getMessage());
        }
    }
    testcase_end();
}

