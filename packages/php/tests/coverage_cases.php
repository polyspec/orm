<?php

declare(strict_types=1);

// Feature coverage helper shared by packages/php/tests/Coverage*Test.php (scripts/features/coverage.mts
// runs those test methods with PHPUnit).

use Polyspec\Orm\Config;
use Polyspec\Orm\Code;
use Polyspec\Orm\Db;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use PHPUnit\Framework\Assert;

/** Fails in extension mode if a client entry point has fallen back to its PHP implementation. */
function coverageAssertEntryClassesAreInternal(): void
{
    if (getenv('ORM_PHP_MODE') !== 'extension') {
        return;
    }
    foreach (['Polyspec\\Orm\\Db', 'Polyspec\\Orm\\Planner'] as $entry) {
        Assert::assertTrue((new ReflectionClass($entry))->isInternal(), "$entry is the extension class");
    }
}

/** A raw connection rejects a generated bench-model request before sending SQL. */
function coverageAssertRawConnectionRejectsUnregisteredBenchRequest(string $dsn): void
{
    $raw = Orm::connect($dsn, new Config());
    $events = [];
    $stop = $raw->subscribe(static function ($event) use (&$events): void {
        $events[] = $event->sql;
    });
    try {
        try {
            (new \Polyspec\Orm\Tests\Model\Author())($raw)->getCount();
            $code = '';
        } catch (OrmException $error) {
            $code = $error->code_;
        }
        Assert::assertSame(Code::SCHEMA_HASH_MISMATCH, $code, 'a raw connection registers no set');
        Assert::assertSame([], $events, 'an unregistered request sent no statement');
    } finally {
        $stop();
        $raw->close();
    }
}

/** Reads from the selected database's catalog whether a table exists. */
function coverageTableExists(Db $db, string $table): bool
{
    $sql = match ($db->driver()) {
        'mysql' => 'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        'postgres' => 'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = current_schema() AND '
            . 'table_name = ?',
        'sqlite' => "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
    };
    $st = $db->pdo()->prepare($sql);
    $st->execute([$table]);
    return (int) $st->fetchColumn() === 1;
}

/** The repository root used by PHP test fixtures. */
function coverageRepositoryRoot(): string
{
    return dirname(__DIR__, 3);
}

/** @return iterable<string, array{string}> */
function coverageDatabaseDrivers(): iterable
{
    foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
        yield $driver => [$driver];
    }
}

/** Generates and loads models for one coverage fixture, and removes its temporary directory when the process ends. */
function coverageGenerateFixtureModels(string $fixture, string $document, string $work, string $namespace): void
{
    register_shutdown_function(static function () use ($work): void {
        exec('rm -rf ' . escapeshellarg($work), $output, $status);
        if ($status !== 0) {
            fwrite(STDERR, "cannot remove $work\n");
            exit(1);
        }
    });
    $source = "$work/source";
    mkdir($source, 0o700, true);
    file_put_contents("$source/$fixture", $document);
    $set = \Polyspec\Orm\Tests\OrmGenTestSupport::setFile($source, [$fixture]);
    [$code, $stdout, $stderr] = \Polyspec\Orm\Tests\OrmGenTestSupport::run([
        'gen', '--set', $set, '--out', "$work/gen", '--namespace', $namespace
    ]);
    if ($code !== 0) {
        throw new RuntimeException("orm-gen failed: " . trim($stdout . "\n" . $stderr));
    }
    requireGeneratedClasses("$work/gen");
    require_once "$work/gen/bootstrap.php";
}

/**
 * The coverage items of a test file from the feature resolver: one [database, dsn] per declared database by default,
 * or the exact ORM_FEATURE_DATABASE assigned to this owner run. A selected database uses its declared DSN variable.
 *
 * @return list<array{string, ?string}>
 */
function coverageItemsOf(string $testFile): array
{
    $root = realpath(coverageRepositoryRoot());
    $relative = substr((string) realpath($testFile), strlen((string) $root) + 1);
    $command = ['node', "$root/scripts/features/coverage.mts", '--items', $relative];
    $selectedDatabase = getenv('ORM_FEATURE_DATABASE');
    if (is_string($selectedDatabase) && $selectedDatabase !== '') {
        $command[] = '--database';
        $command[] = $selectedDatabase;
    }
    $process = proc_open(
        $command,
        [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
        $pipes,
        $root
    );
    if (!is_resource($process)) {
        throw new RuntimeException("cannot run the coverage resolver for $relative");
    }
    $text = stream_get_contents($pipes[1]);
    $errors = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $status = proc_close($process);
    if ($status !== 0) {
        throw new RuntimeException("coverage items of $relative: " . trim((string) $errors));
    }
    $items = [];
    foreach (json_decode((string) $text, true, 512, JSON_THROW_ON_ERROR) as $item) {
        $items[] = [$item['database'], $item['dsn'] ?? null];
    }
    return $items;
}

/** The item that the running test method selected; a test method selects each item of the resolver in turn. */
function selectCoverageItem(array $item): void
{
    $GLOBALS['orm_coverage_item'] = $item;
}

/** @return array{string, ?string} the item the running test method selected */
function coverageItem(): array
{
    $item = $GLOBALS['orm_coverage_item'] ?? null;
    if (!is_array($item)) {
        throw new RuntimeException(
            'no coverage item is selected; a test method runs each item of coverageItemsOf(__FILE__)'
        );
    }
    return $item;
}

/** Connects with the AES and blind index keys of the seeded bench database (scripts/bench-db.sh). */
function coverageConnect(string $dsn): Db
{
    return \Polyspec\Orm\Tests\Model\connect(
        $dsn,
        new Config(aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index')
    );
}

/**
 * Selects the expected conformance vectors owned by a coverage case.
 *
 * @param list<string> $names
 * @return array<string, mixed>
 */
function coverageExpectedConformanceVectors(\stdClass $recorded, array $names): array
{
    $expected = [];
    foreach ($recorded->vectors as $vector) {
        if (in_array($vector->name, $names, true)) {
            $expected[$vector->name] = $vector->expect;
        }
    }
    return $expected;
}

/**
 * The vector file of tests/conformance that records the results of the database `driver` and the expected results of
 * `names` in it, keyed by name; a name that the file does not record fails the case.
 *
 * @param list<string> $names
 * @return array{string, array<string, mixed>}
 */
function coverageRecordedConformanceVectors(string $driver, array $names): array
{
    $file = $driver === 'mysql' ? 'vectors.json' : "vectors.$driver.json";
    $recorded = coverageJson(dirname(__DIR__, 3) . "/tests/conformance/$file", false);
    $expected = coverageExpectedConformanceVectors($recorded, $names);
    Assert::assertSame(
        $names,
        array_values(array_filter($names, static fn(string $name): bool => array_key_exists($name, $expected))),
        "$file lacks a selected vector"
    );
    return [$file, $expected];
}

/**
 * Runs one selected model-query coverage case per database and closes each connection on every path.
 *
 * @param Closure(Db): void $run
 * @param (Closure(string): Db)|null $connect A test seam for the DB-free helper unit.
 */
function coverageRunDatabaseItems(string $testFile, Closure $run, ?Closure $connect = null): void
{
    foreach (coverageItemsOf($testFile) as $item) {
        selectCoverageItem($item);
        [, $dsn] = coverageItem();
        $db = $connect === null ? coverageConnect($dsn) : $connect($dsn);
        try {
            $run($db);
        } finally {
            $db->close();
        }
    }
}

/** Reads the JSON of a repository file. Fails if it cannot be read or parsed. */
function coverageJson(string $path, bool $associative = true): mixed
{
    $text = file_get_contents($path);
    if ($text === false) {
        throw new RuntimeException("cannot read $path");
    }
    return json_decode($text, $associative, 512, JSON_THROW_ON_ERROR);
}

/** The OrmException code thrown by $fn. Other exceptions propagate as they are; on success, 'no error'. */
function coverageCode(Closure $fn): string
{
    try {
        $fn();
    } catch (OrmException $e) {
        return $e->code_;
    }
    return 'no error';
}

/**
 * Runs $body, and whether it succeeds or fails, rolls back the rows the test wrote with $restore.
 * If both steps fail, reports both errors together.
 */
function coverageRestoring(Closure $body, Closure $restore): void
{
    try {
        $body();
    } catch (Throwable $failure) {
        try {
            $restore();
        } catch (Throwable $cleanup) {
            $primary = new RuntimeException(
                'case failed: ' . $failure->getMessage() . '; restore failed: ' . $cleanup->getMessage(),
                0,
                $failure
            );
            throw OrmException::withCleanup($primary, $cleanup);
        }
        throw $failure;
    }
    $restore();
}

/** Runs a conformance child and restores its original auto-increment counters afterward. */
function coverageWithConformanceCountersRestored(
    string $driver,
    string $dsn,
    Closure $run,
    bool $auditLazyBaseline = false
): void {
    $root = coverageRepositoryRoot();
    $command = ['node', "$root/tests/conformance/check/main.mts", 'counters', '--driver', $driver, '--dsn', $dsn];
    $snapshot = coverageReadConformanceCounters($command, $root);
    coverageRestoring(
        static function () use ($run, $auditLazyBaseline, $driver, $dsn, $command, $root, $snapshot): void {
            if ($auditLazyBaseline) {
                coverageAssertAuditLazyTablesEmpty($driver, $dsn);
                $baseline = coverageAuditLazyCounterBaseline($driver, $snapshot);
                coverageRestoreConformanceCounters($command, $root, json_encode($baseline, JSON_THROW_ON_ERROR));
            }
            $run();
        },
        static function () use ($command, $root, $snapshot): void {
            coverageRestoreConformanceCounters($command, $root, json_encode($snapshot, JSON_THROW_ON_ERROR));
            $current = coverageReadConformanceCounters($command, $root);
            if (!coverageConformanceCountersEqual($snapshot, $current)) {
                throw new RuntimeException('conformance counters differ from the original snapshot after restore');
            }
        },
    );
}

/** @param list<string> $command @return array<string, array<string, mixed>> */
function coverageReadConformanceCounters(array $command, string $root): array
{
    [$status, $stdout, $stderr] = coverageProcess($command, $root);
    if ($status !== 0) {
        throw new RuntimeException("cannot read conformance counters: $stderr$stdout");
    }
    $snapshot = trim($stdout);
    $counters = $snapshot === '' ? null : json_decode($snapshot, true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($counters) || $counters === []) {
        throw new RuntimeException('conformance counter reader returned an invalid snapshot');
    }
    return $counters;
}

/** @param array<string, array<string, mixed>> $snapshot @return array<string, array<string, mixed>> */
function coverageAuditLazyCounterBaseline(string $driver, array $snapshot): array
{
    $baseline = $snapshot;
    foreach (['audit_record', 'audited_note'] as $table) {
        if ($driver === 'mysql') {
            if (!isset($baseline[$table])) {
                throw new RuntimeException("MySQL counter snapshot has no $table AUTO_INCREMENT");
            }
            $baseline[$table]['value'] = '1';
            $baseline[$table]['called'] = true;
            continue;
        }
        if ($driver === 'postgres') {
            $found = false;
            foreach ($baseline as $name => $counter) {
                if (($counter['owner'] ?? null) !== $table) {
                    continue;
                }
                $baseline[$name]['value'] = '1';
                $baseline[$name]['called'] = false;
                $found = true;
            }
            if (!$found) {
                throw new RuntimeException("PostgreSQL counter snapshot has no sequence owned by $table");
            }
            continue;
        }
        if ($driver === 'sqlite') {
            if (isset($baseline[$table])) {
                $baseline[$table]['value'] = '0';
                $baseline[$table]['called'] = true;
            }
            continue;
        }
        throw new RuntimeException("unsupported conformance driver $driver");
    }
    return $baseline;
}

function coverageAssertAuditLazyTablesEmpty(string $driver, string $dsn): void
{
    $db = Orm::connect($dsn, new Config());
    $quote = $driver === 'mysql' ? '`' : '"';
    try {
        foreach (['audit_record', 'audited_note'] as $table) {
            $quotedTable = $quote . $table . $quote;
            $count = (int) $db->pdo()->query('SELECT COUNT(*) FROM ' . $quotedTable)->fetchColumn();
            if ($count !== 0) {
                throw new RuntimeException("cannot normalize $table identity counter: table has $count rows");
            }
        }
    } finally {
        $db->close();
    }
}

/** @param list<string> $command Restores the whole counter map rather than only counters the selected vector touched. */
function coverageRestoreConformanceCounters(array $command, string $root, string $snapshot): void
{
    [$status, $stdout, $stderr] = coverageProcess([...$command, '--restore-json', $snapshot], $root);
    if ($status !== 0) {
        throw new RuntimeException("cannot restore conformance counters: $stderr$stdout");
    }
}

/** @param array<string, array<string, mixed>> $left @param array<string, array<string, mixed>> $right */
function coverageConformanceCountersEqual(array $left, array $right): bool
{
    if (array_diff_key($left, $right) !== [] || array_diff_key($right, $left) !== []) {
        return false;
    }
    foreach ($left as $name => $counter) {
        $current = $right[$name];
        if (array_diff_key($counter, $current) !== [] || array_diff_key($current, $counter) !== []) {
            return false;
        }
        foreach ($counter as $key => $value) {
            if ($current[$key] !== $value) {
                return false;
            }
        }
    }
    return true;
}

/**
 * Runs a child process and returns its exit code, stdout, and stderr. The output does not mix
 * into the test output; the caller puts it in the failure error.
 *
 * @param list<string> $command
 * @param array<string, string>|null $env
 * @return array{int, string, string}
 */
function coverageProcess(array $command, string $cwd, ?array $env = null): array
{
    $process = proc_open($command, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $cwd, $env);
    if (!is_resource($process)) {
        throw new RuntimeException('cannot start ' . $command[0]);
    }
    // Reads stdout and stderr together, so that a full pipe on one side does not block the child.
    stream_set_blocking($pipes[1], false);
    stream_set_blocking($pipes[2], false);
    $out = ['', ''];
    $open = [1 => $pipes[1], 2 => $pipes[2]];
    $abort = static function () use (&$open, $pipes, $process): void {
        proc_terminate($process, 9);
        foreach ($pipes as $pipe) {
            if (is_resource($pipe)) {
                fclose($pipe);
            }
        }
        $open = [];
        proc_close($process);
    };
    while ($open !== []) {
        $read = array_values($open);
        $write = null;
        $except = null;
        if (stream_select($read, $write, $except, null) === false) {
            $abort();
            throw new RuntimeException('cannot read the output of ' . $command[0]);
        }
        foreach ($open as $index => $pipe) {
            if (!in_array($pipe, $read, true)) {
                continue;
            }
            $chunk = fread($pipe, 65536);
            if ($chunk === false) {
                $abort();
                throw new RuntimeException('cannot read the output of ' . $command[0]);
            }
            $out[$index - 1] .= $chunk;
            if (feof($pipe)) {
                fclose($pipe);
                unset($open[$index]);
            }
        }
    }
    return [proc_close($process), $out[0], $out[1]];
}

/** Use the conformance checker's canonical JSON normalization for a vector output. */
function coverageCanonicalConformanceOutput(string $driver, string $vector, string $json): string
{
    if ($vector !== 'audit_lazy') {
        return $json;
    }
    $path = tempnam(sys_get_temp_dir(), 'orm-conformance-output-');
    if ($path === false) {
        throw new RuntimeException('cannot create a temporary conformance output');
    }
    try {
        if (file_put_contents($path, $json) !== strlen($json)) {
            throw new RuntimeException('cannot write a temporary conformance output');
        }
        $root = dirname(__DIR__, 3);
        [$status, $stdout, $stderr] = coverageProcess(
            [
                'node',
                'tests/conformance/check/main.mts',
                'normalize',
                '--driver',
                $driver,
                '--vector',
                $vector,
                $path,
            ],
            $root,
        );
        if ($status !== 0) {
            throw new RuntimeException("conformance output normalization exited $status: $stderr$stdout");
        }
        return $stdout;
    } finally {
        if (is_file($path) && !unlink($path)) {
            throw new RuntimeException("cannot remove temporary conformance output: $path");
        }
    }
}
