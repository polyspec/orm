<?php

declare(strict_types=1);

use PHPUnit\Framework\Assert;

/** The statements that each dbspec test runs on a fresh connection to its selected database. */
function dbspec_connection_rules(): array
{
    return [
        'mysql' => ["SET time_zone = '+00:00'"],
        'postgres' => ["SET TimeZone = 'UTC'"],
        'sqlite' => ['PRAGMA foreign_keys = ON'],
    ];
}

/**
 * @param array{mysql: string, postgres: string} $names
 * @return array{mysql: string, postgres: string}
 */
function dbspec_dsns(array $names, ?string $missingMessage = null): array
{
    $dsns = [];
    foreach ($names as $driver => $name) {
        if ($missingMessage === null) {
            $dsns[$driver] = requiredDsn($name);
            continue;
        }
        $dsn = getenv($name);
        if (!is_string($dsn) || $dsn === '') {
            throw new RuntimeException($missingMessage);
        }
        $dsns[$driver] = $dsn;
    }
    return $dsns;
}

/** Reads a query's first value as text; the plan fixture also records SQL NULL as `NULL`. */
function dbspec_value(PDO $pdo, string $query, bool $nullAsText = false): string
{
    $rows = $pdo->query($query)->fetchAll(PDO::FETCH_NUM);
    Assert::assertNotSame([], $rows, "$query: no row");
    $value = $rows[0][0];
    return match (true) {
        $value === null && $nullAsText => 'NULL',
        is_string($value) => $value,
        is_int($value) => (string) $value,
        default => throw new RuntimeException(
            "$query: value of type " . get_debug_type($value) . ' has no text form here'
        ),
    };
}

/** Removes a SQLite test database and every sidecar file it can leave. */
function dbspec_remove_sqlite_files(string $path): void
{
    foreach (['', '-journal', '-wal', '-shm'] as $suffix) {
        if (file_exists($path . $suffix) && !unlink($path . $suffix)) {
            throw new RuntimeException("$path$suffix cannot be removed");
        }
    }
}

/**
 * Creates a fresh MySQL database or PostgreSQL schema and returns a session factory and cleanup operation.
 *
 * The session factory selects the new database or schema on every connection. Callers may supply a PDO subclass for
 * query counting; PostgreSQL cases with additional schemas may remove those through $beforeDrop and verify them through
 * $afterDrop. A PDO factory makes the SQL lifecycle testable without a server.
 *
 * @param Closure(string, ?string, ?string, array<int, mixed>): PDO|null $pdoFactory
 * @return array{0: Closure(): PDO, 1: Closure(): void}
 */
function dbspec_open_server_database(
    string $dialect,
    string $name,
    string $serverDsn,
    ?Closure $beforeDrop = null,
    ?Closure $afterDrop = null,
    ?Closure $pdoFactory = null
): array {
    if (!in_array($dialect, ['mysql', 'postgres'], true)) {
        throw new InvalidArgumentException("server database dialect $dialect");
    }
    [, $pdoDsn, $user, $password] = \Polyspec\Orm\Orm::parseDsn($serverDsn);
    $options = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION];
    $open = $pdoFactory ?? static function (
        string $dsn,
        ?string $user,
        ?string $password,
        array $options
    ): PDO {
        return new PDO($dsn, $user, $password, $options);
    };
    $admin = $open($pdoDsn, $user, $password, $options);
    $quoted = $dialect === 'mysql' ? "`$name`" : "\"$name\"";
    $admin->exec(($dialect === 'mysql' ? 'CREATE DATABASE ' : 'CREATE SCHEMA ') . $quoted);
    $session = static function () use ($open, $pdoDsn, $user, $password, $options, $dialect, $quoted): PDO {
        $pdo = $open($pdoDsn, $user, $password, $options);
        $pdo->exec($dialect === 'mysql' ? "USE $quoted" : "SET search_path TO $quoted");
        return $pdo;
    };
    $drop = static function () use ($admin, $dialect, $quoted, $name, $beforeDrop, $afterDrop): void {
        $beforeDrop?->__invoke($admin, $name);
        $admin->exec(
            ($dialect === 'mysql' ? 'DROP DATABASE ' : 'DROP SCHEMA ') . $quoted
                . ($dialect === 'mysql' ? '' : ' CASCADE')
        );
        $left = $dialect === 'mysql'
            ? $admin->prepare('SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?')
            : $admin->prepare('SELECT COUNT(*) FROM pg_namespace WHERE nspname = ?');
        $left->execute([$name]);
        \PHPUnit\Framework\Assert::assertSame(0, (int) $left->fetchColumn(), "$dialect $name remains after cleanup");
        $afterDrop?->__invoke($admin, $name);
    };
    return [$session, $drop];
}

// Checks dbspec cases in the shape of tests/dbspec/cases.json with the PHPUnit
// assertions; the test classes run each case as one data set named by its id.

/**
 * Joins each document's lines with LF, with CRLF when $crlf is true, or
 * alternately CRLF and LF (starting with CRLF, no final line end) when
 * $mixed is true.
 *
 * @param array<string, list<string>> $documents
 */
function dbspec_documents(array $documents, bool $crlf, bool $mixed = false): array
{
    $texts = [];
    foreach ($documents as $name => $lines) {
        if ($mixed) {
            $text = '';
            foreach ($lines as $i => $line) {
                $text .= ($i > 0 ? ($i % 2 === 1 ? "\r\n" : "\n") : '') . $line;
            }
            $texts[$name] = $text;
            continue;
        }
        $end = $crlf ? "\r\n" : "\n";
        $texts[$name] = implode($end, $lines) . $end;
    }
    return $texts;
}

/**
 * @param list<array{line: int, column: int, rule: string}> $errors
 * @return list<array{line: int, column: int, rule: string}>
 */
function dbspec_error_locations(array $errors): array
{
    return array_map(
        static fn(array $error): array => [
            'line' => $error['line'],
            'column' => $error['column'],
            'rule' => $error['rule']
        ],
        $errors
    );
}

/**
 * Checks one case of a kind (canonical, normalize, invalid) with the PHPUnit assertions: a canonical case emits
 * unchanged, a normalize case emits its canonical lines, an invalid case reports exactly the listed errors in order.
 * The case's CPU time is measured against its reference $cpuSeconds (case_clock.php).
 */
function dbspec_check_case(string $kind, array $case, float $cpuSeconds): void
{
    $id = $kind . '/' . $case['id'];
    $clock = cpuCaseBegin($cpuSeconds);
    $texts = dbspec_documents($case['documents'], $case['crlf'] ?? false, $case['mixed'] ?? false);
    $text = $texts[$case['main']];
    $result = Polyspec\Orm\Dbspec\Dbspec::parse($text, $texts);
    if ($kind === 'invalid') {
        Assert::assertNull($result->document, "$id: a document was returned with diagnostics expected");
        Assert::assertNull($result->positions, "$id: positions were returned for an invalid document");
        $got = array_map(
            static fn(Polyspec\Orm\Dbspec\Diagnostic $d): array => [
                'line' => $d->line,
                'column' => $d->column,
                'rule' => $d->rule
            ],
            $result->diagnostics
        );
        $want = dbspec_error_locations($case['errors']);
        Assert::assertSame(
            $want,
            $got,
            "$id: diagnostics differ\n" . implode(
                "\n",
                array_map(static fn($d) => "{$d->line}:{$d->column} {$d->rule} {$d->message}", $result->diagnostics)
            )
        );
        foreach ($result->diagnostics as $d) {
            Assert::assertNotSame('', $d->message, "$id: empty diagnostic message");
        }
        $formatted = Polyspec\Orm\Dbspec\Dbspec::format($text, $texts);
        Assert::assertNull($formatted->text, "$id: format returned text for an invalid document");
        Assert::assertSame(
            $want,
            array_map(
                static fn(Polyspec\Orm\Dbspec\Diagnostic $d): array => [
                    'line' => $d->line,
                    'column' => $d->column,
                    'rule' => $d->rule
                ],
                $formatted->diagnostics
            ),
            "$id: format diagnostics differ"
        );
    } else {
        Assert::assertSame(
            [],
            array_map(static fn($d) => "{$d->line}:{$d->column} {$d->rule} {$d->message}", $result->diagnostics),
            "$id: unexpected diagnostics"
        );
        Assert::assertNotNull($result->document, "$id: no document");
        $want = $kind === 'canonical' ? implode(
            "\n",
            $case['documents'][$case['main']]
        ) . "\n" : implode("\n", $case['canonical']) . "\n";
        $emitted = Polyspec\Orm\Dbspec\Dbspec::emit($result->document);
        Assert::assertSame($want, $emitted, "$id: emission differs");
        $again = Polyspec\Orm\Dbspec\Dbspec::parse($emitted, $texts);
        Assert::assertNotNull($again->document, "$id: emission does not parse again");
        Assert::assertSame(
            $emitted,
            Polyspec\Orm\Dbspec\Dbspec::emit($again->document),
            "$id: emission is not idempotent"
        );
        $formatted = Polyspec\Orm\Dbspec\Dbspec::format($text, $texts);
        Assert::assertSame($want, $formatted->text, "$id: format differs");
        $formattedAgain = Polyspec\Orm\Dbspec\Dbspec::format($formatted->text, $texts);
        Assert::assertSame($formatted->text, $formattedAgain->text, "$id: format is not idempotent");
    }
    cpuCaseEnd($id, $clock);
}


/**
 * The cases of the section $kind as PHPUnit data sets named by their bare ids, the case ids of that suite of
 * config/parity.json, each with its kind and case. A repeated id is refused.
 */
function dbspec_case_ids(string $kind, array $cases): iterable
{
    $seen = [];
    foreach ($cases as $case) {
        if (isset($seen[$case['id']])) {
            throw new RuntimeException("repeated case id $kind/{$case['id']}");
        }
        $seen[$case['id']] = true;
        yield $case['id'] => [$kind, $case];
    }
}
/**
 * The data sets of one kind of cases, each named "<kind>/<id>" and holding [kind, case]. A repeated id is an error.
 *
 * @return iterable<string, array{string, array}>
 */
function dbspec_case_sets(string $kind, array $cases): iterable
{
    $seen = [];
    foreach ($cases as $case) {
        $name = $kind . '/' . $case['id'];
        if (isset($seen[$name])) {
            throw new RuntimeException("repeated case id $name");
        }
        $seen[$name] = true;
        yield $name => [$kind, $case];
    }
}

/**
 * Checks one positions case: it parses its main document and must return the listed positions, in order, with the
 * listed kind, path, line and column. The section is read strictly: a case or position with an unknown or missing field
 * is an error.
 */
function dbspec_check_position_case(array $case, float $cpuSeconds): void
{
    Assert::assertSame(
        ['id', 'documents', 'main', 'positions'],
        array_keys($case),
        'positions case has unexpected fields'
    );
    $id = 'positions/' . $case['id'];
    $clock = cpuCaseBegin($cpuSeconds);
    $texts = dbspec_documents($case['documents'], false);
    $result = Polyspec\Orm\Dbspec\Dbspec::parse($texts[$case['main']], $texts);
    Assert::assertTrue($result->document !== null && $result->diagnostics === [], "$id: parse failed");
    $got = [];
    foreach ($result->positions as $p) {
        $got[] = ['kind' => $p->kind, 'path' => $p->path, 'line' => $p->line, 'column' => $p->column];
    }
    $want = [];
    foreach ($case['positions'] as $p) {
        Assert::assertSame(['kind', 'path', 'line', 'column'], array_keys($p), "$id: position has unexpected fields");
        $want[] = $p;
    }
    Assert::assertSame($want, $got, "$id: positions differ");
    cpuCaseEnd($id, $clock);
}
